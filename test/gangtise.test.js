// Gangtise 接入测试：用假的 fetch 模拟接口，不访问网络、不消耗积分。
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MOCK_SESSION = 'regular';
process.env.WATCHLIST_FILE = '';
process.env.GANGTISE_ACCESS_KEY = 'test-ak';
process.env.GANGTISE_SECRET_KEY = 'test-sk';
process.env.GANGTISE_BASE_URL = 'http://gangtise.test';
process.env.GANGTISE_DAILY_POINTS = '5';

let G, GM, store, research, market, env;
let calls = [];
let handler = () => ({ code: '000000', data: { list: [] } });

const ok = (data) => ({ code: '000000', msg: 'success', status: true, data });
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  const body = JSON.parse(init.body || '{}');
  calls.push({ path, body, auth: init.headers.Authorization });
  if (path.endsWith('/loginV2')) return resp(ok({ accessToken: `tok${calls.filter((c) => c.path.endsWith('/loginV2')).length}`, expiresIn: 10800 }));
  return resp(handler(path, body));
};
function resp(json) { return { ok: true, status: 200, text: async () => JSON.stringify(json) }; }

before(async () => {
  [G, GM, store, research, market, env] = await Promise.all([
    import('../server/providers/gangtise.js'), import('../server/providers/gangtiseMarket.js'), import('../server/store.js'),
    import('../server/research.js'), import('../server/providers/market.js'), import('../server/lib/env.js'),
  ]);
  (await import('../server/seed.js')).seed(new Date());
  GM._setUsCodes({ NVDA: 'NVDA.O', TSM: 'TSM.N', AAPL: 'AAPL.O' });
});
beforeEach(() => { calls = []; G._resetAuth(); G._resetUsage(); handler = () => ok({ list: [] }); });

test('.env 解析：注释、引号、export 前缀', () => {
  const v = env.parseEnv('# 注释\nexport A=1\nB="two words"\nC=\'x\'\n\nbad line');
  assert.deepEqual(v, { A: '1', B: 'two words', C: 'x' });
});

test('登录一次后复用 token；token 失效时自动重新登录', async () => {
  await G.call(G.EP.realtime, { securityList: ['NVDA.O'] });
  await G.call(G.EP.realtime, { securityList: ['NVDA.O'] });
  assert.equal(calls.filter((c) => c.path.endsWith('/loginV2')).length, 1);
  assert.equal(calls[1].auth, 'Bearer tok1');
  let first = true;
  handler = () => (first ? ((first = false), { code: '8000014', msg: 'token 过期' }) : ok({ list: [] }));
  await G.call(G.EP.realtime, { securityList: ['NVDA.O'] });
  assert.equal(calls.filter((c) => c.path.endsWith('/loginV2')).length, 2);
  assert.equal(calls.at(-1).auth, 'Bearer tok2');
});

test('接口报错时抛出带错误码的异常', async () => {
  handler = () => ({ code: '120001', msg: '证券代码无效' });
  await assert.rejects(G.call(G.EP.realtime, { securityList: ['SPY.P'] }), (e) => e.code === '120001');
});

test('列式行情数据转成对象', () => {
  const rows = G.list({ fieldList: ['securityCode', 'latestPrice'], list: [['NVDA.O', 236.5], ['AAPL.O', 336.6]] });
  assert.deepEqual(rows, [{ securityCode: 'NVDA.O', latestPrice: 236.5 }, { securityCode: 'AAPL.O', latestPrice: 336.6 }]);
});

test('按行计费接口受每日积分上限约束，免费接口不受影响', async () => {
  handler = () => ok({ list: Array.from({ length: 20 }, (_, i) => ({ announcementId: i })) });
  await G.call(G.EP.annUS, { securityList: ['NVDA.O'], size: 20 }); // 20 行 × 0.1 = 2 积分
  assert.equal(G.usageToday().points, 2);
  await G.call(G.EP.annUS, { securityList: ['NVDA.O'], size: 20 }); // 累计 4
  await assert.rejects(G.call(G.EP.annUS, { securityList: ['NVDA.O'], size: 20 }), (e) => e.code === 'POINTS_CAP');
  await G.call(G.EP.realtime, { securityList: ['NVDA.O'] }); // 免费
  assert.equal(G.usageToday().points, 4);
});

test('代码映射：美股按快照后缀、港股补零、A 股、指数；ETF / 加密 / 宏观不映射', () => {
  assert.equal(GM.toCode('NASDAQ:NVDA'), 'NVDA.O');
  assert.equal(GM.toCode('NYSE:TSM'), 'TSM.N');
  assert.equal(GM.toCode('HKEX:700'), '00700.HK');
  assert.equal(GM.toCode('SSE:600519'), '600519.SH');
  assert.equal(GM.toCode('SP:SPX'), 'SPX.SPI');
  assert.equal(GM.toCode('HSI:HSI'), 'HSI.HI');
  assert.equal(GM.toCode('AMEX:GLD'), null); // 美股 ETF：快照里没有
  assert.equal(GM.toCode('OANDA:XAUUSD'), null);
  assert.equal(GM.toCode('BINANCE:ETHUSDT'), null);
});

test('财报：累计口径拆成单季度，单位换算为百万', () => {
  const inc = (period, rev, gp, np) => ({ fiscalYear: '2026', period, endDate: { 一季报: '20250427', 半年报告: '20250727', 三季报: '20251026' }[period], unit: '元', currency: '美元', totalOpRev: rev, grossProfit: gp, opProfit: gp / 2, netProfitParent: np, dilutedEPS: np / 1e10 });
  const q = GM.toQuarterly({
    income: [inc('半年报告', 90e9, 60e9, 40e9), inc('一季报', 44e9, 30e9, 19e9), inc('三季报', 147e9, 100e9, 70e9)],
    cashflow: [{ fiscalYear: '2026', period: '一季报', unit: '元', netOpCashFlows: 27e9, capex: -1e9 }, { fiscalYear: '2026', period: '半年报告', unit: '元', netOpCashFlows: 42e9, capex: -2e9 }],
    balance: [{ fiscalYear: '2026', period: '三季报', unit: '元', totalCash: 60e9, shortTermDebt: 1e9, longTermDebt: 7e9 }],
  }, 'US');
  assert.deepEqual(q.map((x) => x.period), ['FY2026Q1', 'FY2026Q2', 'FY2026Q3']);
  assert.deepEqual(q.map((x) => x.revenue), [44000, 46000, 57000]);
  assert.equal(q[1].netIncome, 21000);
  assert.equal(q[0].fcf, 26000);
  assert.equal(q[1].fcf, 14000); // (42-2) - (27-1)
  assert.equal(q[2].fcf, null);  // 三季报现金流缺失
  assert.equal(q[2].cash, 60000);
  assert.equal(q[2].debt, 8000);
});

test('行情轮询：用 Gangtise 快照替换报价，之后 Mock 跳动不再改动它', async () => {
  handler = (path, body) => {
    const codes = body.securityList;
    const all = { usStocks: [['NVDA.O', '2026-10-08', '10:30:00', null, 234.9, 237, 233.7, 236.87, 237.47, 22901841, null]], hkStocks: [['00700.HK', '2026-10-08', '16:08:00', '收盘', 422, 424.6, 411.2, 411.4, 420.6, 30202875, 1]], aShares: [['600519.SH', '2026-10-08', '15:00:00', '收盘', 1252.9, 1258, 1242, 1255.79, 1258.62, 2516757, 1]] };
    const rows = codes.length === 1 && all[codes[0]] ? all[codes[0]] : codes.map((c) => [c, '2026-10-08', '10:30:00', null, 1, 2, 1, 1.5, 1.4, null, null]);
    return ok({ fieldList: ['securityCode', 'tradeDate', 'tradeTime', 'tradeStatus', 'open', 'high', 'low', 'latestPrice', 'preClose', 'volume', 'amount'], list: rows });
  };
  const changed = await GM.pollQuotes(new Date('2026-10-08T14:30:00Z'), { force: true });
  assert.ok(changed.length >= 3);
  const q = store.db.quotes['NASDAQ:NVDA'];
  assert.equal(q.provider, 'gangtise');
  assert.equal(q.last, 236.87);
  assert.equal(q.changePct, -0.25);
  assert.equal(q.session, 'regular');
  assert.equal(q.marketCap, null);
  assert.equal(store.db.quotes['HKEX:700'].last, 411.4);
  market.tick(new Date('2026-10-08T14:30:05Z'));
  assert.equal(store.db.quotes['NASDAQ:NVDA'].last, 236.87);
  // 接口出错：保留上一次报价
  handler = () => ({ code: '999999', msg: '服务异常' });
  await GM.pollQuotes(new Date('2026-10-08T14:31:00Z'), { force: true });
  assert.equal(store.db.quotes['NASDAQ:NVDA'].last, 236.87);
  assert.match(GM.pollState().lastError, /999999/);
});

test('财报按需拉取后，详情页显示 Gangtise 来源；失败时保留 Mock', async () => {
  handler = (path, body) => {
    if (!path.includes('income-statement')) return ok({ list: [] });
    if (body.fiscalYear[0] !== '2026') return ok({ list: [] });
    return ok({ list: [
      { fiscalYear: '2026', period: '一季报', endDate: '20260331', unit: '百万元', currency: '新台币', totalOpRev: 800, grossProfit: 480, netProfitParent: 300 },
      { fiscalYear: '2026', period: '半年报告', endDate: '20260630', unit: '百万元', currency: '新台币', totalOpRev: 1700, grossProfit: 1000, netProfitParent: 650 },
    ] });
  };
  assert.equal(await GM.ensureFinancials('NYSE:TSM', new Date('2026-10-08T00:00:00Z')), true);
  const f = research.financialMetrics('NYSE:TSM');
  assert.equal(f.real, true);
  assert.match(f.source, /Gangtise/);
  assert.deepEqual(f.quarters.map((x) => x.revenue), [800, 900]);
  // 另一只股票接口出错：继续用演示财务数据
  handler = () => ({ code: '999999', msg: '服务异常' });
  assert.equal(await GM.ensureFinancials('NASDAQ:AAPL', new Date('2026-10-08T00:00:00Z')), false);
  assert.match(research.financialMetrics('NASDAQ:AAPL').source, /Mock/);
});

test('公告：转换为平台格式，并替换该标的的演示公告', async () => {
  handler = () => ok({ list: [{ announcementId: '94318013', title: '英伟达: Statement of changes in beneficial ownership of securities', publishTime: '2026-09-24 04:56:28', announcementDate: '2026-09-23', fileNameList: ['FORM 4.html'], primaryCategory: { categoryName: '股本股东', secondaryCategory: { categoryName: '内部交易' } } }] });
  assert.ok(store.db.filings.some((f) => f.symbol === 'NASDAQ:NVDA' && /演示/.test(f.source)));
  await GM.ensureFilings('NASDAQ:NVDA', { size: 1 });
  const fs = store.db.filings.filter((f) => f.symbol === 'NASDAQ:NVDA');
  assert.equal(fs.length, 1);
  assert.equal(fs[0].type, '内部交易');
  assert.equal(fs[0].title, 'Statement of changes in beneficial ownership of securities');
  assert.equal(fs[0].filedAt, '2026-09-23T20:56:28.000Z');
  assert.equal(G.usageToday().points, 0.1);
});

test('业绩日历：自选股财报日并入日历，标记为 earnings', async () => {
  handler = () => ok({ list: [{ performanceReportId: '1', securityCodeList: ['NVDA.O'], securityName: '英伟达', publishDate: '2026-11-19', title: '英伟达 · 发布2027财年三季度业绩公告' }] });
  const n = await GM.refreshEarningsCalendar(['NASDAQ:NVDA', 'OANDA:XAUUSD'], new Date('2026-10-08T00:00:00Z'));
  assert.equal(n, 1);
  const c = store.db.calendar.find((x) => x.kind === 'earnings');
  assert.equal(c.symbol, 'NASDAQ:NVDA');
  assert.equal(c.event, '发布2027财年三季度业绩公告');
  assert.deepEqual(calls.at(-1).body.securityList, ['NVDA.O']);
  assert.ok(store.db.calendar.some((x) => !x.kind)); // 宏观日历（演示）保留
});
