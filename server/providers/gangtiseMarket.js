// Gangtise 真实数据接入：股票 / 指数行情、日 K、财报、公告、业绩日历。
// 只覆盖 Gangtise 有的标的（美股个股、港股、A 股及主要指数）；美股 ETF、宏观商品、加密等仍走 Mock，并在来源上标注。
// 任何一路数据出错只影响这一路：保留上一次的值或继续用 Mock，不影响其他数据。
import fs from 'node:fs';
import path from 'node:path';
import { db, instrument } from '../store.js';
import { sessionFor } from '../lib/sessions.js';
import * as G from './gangtise.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data');
const SYMBOLS_FILE = path.join(DATA_DIR, 'gangtise-symbols.json');

export const SOURCE = 'Gangtise 实时快照';
export const enabled = () => G.enabled();

// ---------- 代码映射 ----------
// 平台 ID → Gangtise 代码。指数单独列出；美股后缀以 usStocks 快照里的实际代码为准（.O / .N / .A）。
const INDEX_CODES = {
  'SP:SPX': 'SPX.SPI', 'TVC:SPX': 'SPX.SPI', 'NASDAQ:IXIC': 'IXIC.O', 'TVC:IXIC': 'IXIC.O', 'DJ:DJI': 'DJI.SPI', 'TVC:DJI': 'DJI.SPI',
  'HSI:HSI': 'HSI.HI', 'TVC:HSI': 'HSI.HI',
  // 指数 CFD 用对应现货指数代替（CFD 近 24 小时交易，指数只在交易时段更新）
  'FX:SPX500': 'SPX.SPI', 'FOREXCOM:HK50': 'HSI.HI', 'ICMARKETS:HK50': 'HSI.HI',
};
const PROXY = new Set(['FX:SPX500', 'FOREXCOM:HK50', 'ICMARKETS:HK50']);
const US_SUFFIX = { NASDAQ: 'O', NYSE: 'N', AMEX: 'A', NYSEARCA: 'A', BATS: 'A', CBOE: 'A' };

let usCodes = null; // TICKER → Gangtise 代码，来自 usStocks 快照
function loadSymbolCache() {
  if (usCodes) return usCodes;
  try { usCodes = JSON.parse(fs.readFileSync(SYMBOLS_FILE, 'utf8')).us || {}; } catch { usCodes = {}; }
  return usCodes;
}
function saveSymbolCache() {
  if (process.env.NODE_ENV === 'test') return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SYMBOLS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), us: usCodes })); } catch { /* 缓存失败不影响 */ }
}
export function _setUsCodes(map) { usCodes = map; }

const usKey = (t) => t.toUpperCase().replace(/[._\-/]/g, '');

/** 平台 ID → Gangtise 代码；不支持时返回 null */
export function toCode(id) {
  if (INDEX_CODES[id]) return INDEX_CODES[id];
  const inst = instrument(id);
  if (inst && !['stock', 'index', 'etf'].includes(inst.type)) return null;
  const [ex, code] = String(id).split(':');
  if (!code) return null;
  if (ex === 'SSE') return `${code.padStart(6, '0')}.SH`;
  if (ex === 'SZSE') return `${code.padStart(6, '0')}.SZ`;
  if (ex === 'BSE') return `${code}.BJ`;
  if (ex === 'HKEX') return /^\d+$/.test(code) ? `${code.padStart(5, '0')}.HK` : null;
  if (US_SUFFIX[ex]) {
    const map = loadSymbolCache();
    if (Object.keys(map).length) return map[usKey(code)] || null; // 快照里没有（如 ETF）就不支持
    return inst?.type === 'stock' ? `${code}.${US_SUFFIX[ex]}` : null;
  }
  return null;
}

export const marketOf = (code) => (code.endsWith('.HK') || code.endsWith('.HI') ? 'HK' : /\.(SH|SZ|BJ)$/.test(code) ? 'CN' : 'US');

/** 当前需要真实行情的标的：{ id → code } */
export function mappedIds(ids = db.instruments.map((i) => i.id)) {
  const out = {};
  for (const id of ids) { const c = toCode(id); if (c) out[id] = c; }
  return out;
}

// ---------- 实时报价 ----------
const QUOTE_FIELDS = ['securityCode', 'tradeDate', 'tradeTime', 'tradeStatus', 'open', 'high', 'low', 'latestPrice', 'preClose', 'volume', 'amount'];
const BULK = { US: 'usStocks', HK: 'hkStocks', CN: 'aShares' };
const lastBulk = {};      // market → 上次整市场快照时间
const state = { lastPoll: null, lastError: null, ok: 0, failed: 0 };
export const pollState = () => ({ ...state });

function round(x, n = 4) { const f = 10 ** n; return Math.round(x * f) / f; }

/** 用一行 Gangtise 快照更新平台报价。返回更新后的报价。 */
export function applyQuote(id, row, now = new Date()) {
  if (row?.latestPrice == null) return null;
  const inst = instrument(id);
  const market = inst?.market || marketOf(row.securityCode || '');
  const q = db.quotes[id] || (db.quotes[id] = { id, avgVolume20: null, marketCap: null });
  const prevLast = q.provider === 'gangtise' ? q.last : null;
  if (prevLast == null) { q.marketCap = null; if (!db.daily[id]?.real) q.avgVolume20 = null; } // 去掉 Mock 的市值 / 均量
  q.provider = 'gangtise';
  q.code = row.securityCode;
  q.last = row.latestPrice;
  q.prevClose = row.preClose ?? q.prevClose;
  q.open = row.open ?? q.open ?? row.latestPrice;
  q.high = row.high ?? q.high ?? row.latestPrice;
  q.low = row.low ?? q.low ?? row.latestPrice;
  q.volume = row.volume ?? null;
  q.amount = row.amount ?? null;
  q.change = q.prevClose ? round(q.last - q.prevClose) : 0;
  q.changePct = q.prevClose ? round(((q.last - q.prevClose) / q.prevClose) * 100, 2) : 0;
  q.source = PROXY.has(id) ? `${SOURCE}（以现货指数 ${row.securityCode} 代替 CFD）` : SOURCE;
  q.delayMinutes = 1; // 实测分钟级更新，时间戳为当前分钟末
  q.asOf = row.tradeDate ? `${row.tradeDate} ${row.tradeTime || ''}`.trim() : null;
  q.updatedAt = now.toISOString();
  const s = sessionFor(market, now);
  q.session = s.session;
  // 交易日以交易所给出的为准（异动提醒去重用）
  q.tradeDate = row.tradeDate || s.tradeDate;
  q.tradeStatus = row.tradeStatus ?? null;
  // 分时：每次轮询追加一个点（同一分钟内覆盖）
  if (!db.intraday[id]?.real) { db.intraday[id] = []; db.intraday[id].real = true; }
  const series = db.intraday[id];
  if (prevLast == null || q.session !== 'closed' || !series.length) {
    const lastPt = series[series.length - 1];
    if (lastPt && now - new Date(lastPt.t) < 60000) lastPt.p = q.last;
    else series.push({ t: now.toISOString(), p: q.last, v: 0 });
    if (series.length > 600) series.shift();
  }
  return q;
}

/** 轮询一次：有自选标的的市场拉整市场快照（免费、约 0.5–1 秒），其余代码逐个补。返回变化过的报价。 */
const bad = new Set(); // 接口判定无效（120001）或整市场快照里没有的代码，不再逐个请求

function groupByCode() {
  const byCode = new Map();
  for (const [id, code] of Object.entries(mappedIds())) { if (!byCode.has(code)) byCode.set(code, []); byCode.get(code).push(id); }
  return byCode;
}

/** 批量取指定代码；遇到无效代码（120001）时退回逐个请求，并记住无效代码。 */
async function fetchCodes(codes) {
  if (!codes.length) return [];
  try { return await G.realtime(codes, QUOTE_FIELDS); } catch (e) {
    if (e.code !== '120001') throw e;
  }
  const out = [];
  for (const c of codes) {
    try { const r = await G.realtime([c], QUOTE_FIELDS); if (!r.length) bad.add(c); out.push(...r); } catch (e) { if (e.code !== '120001') throw e; bad.add(c); }
  }
  return out;
}

/** 轮询一次：有自选标的的市场拉整市场快照（免费、约 0.5–1 秒），指数等其余代码批量补。返回变化过的报价。 */
export async function pollQuotes(now = new Date(), { force = false } = {}) {
  const rows = new Map();
  const due = (m) => force || sessionFor(m, now).session !== 'closed' || !lastBulk[m] || now - lastBulk[m] >= 30 * 60e3;
  try {
    // 休市时 30 分钟刷新一次即可；交易时段每次轮询都拉
    const markets = new Set([...groupByCode().keys()].map(marketOf));
    for (const m of markets) {
      if (!due(m)) continue;
      const list = await G.realtime([BULK[m]], QUOTE_FIELDS);
      lastBulk[m] = now;
      for (const r of list) rows.set(r.securityCode, r);
      if (m === 'US' && list.length > 1000) {
        usCodes = Object.fromEntries(list.map((r) => [usKey(r.securityCode.replace(/\.[A-Z]+$/, '')), r.securityCode]));
        saveSymbolCache();
      }
    }
    // 美股代码表刚刷新时映射可能变化，重新分组；指数、A 股 ETF 等不在整市场关键字里的代码再批量补
    const byCode = groupByCode();
    const rest = [...byCode.keys()].filter((c) => !rows.has(c) && !bad.has(c) && due(marketOf(c)) && !(marketOf(c) === 'US' && /\.(O|N|A)$/.test(c) && rows.size && !/^(IXIC|NDX)\./.test(c)));
    for (const r of await fetchCodes(rest)) rows.set(r.securityCode, r);
    state.lastPoll = now.toISOString(); state.lastError = null; state.ok++;
  } catch (e) {
    state.lastError = `${e.code || ''} ${e.message}`.trim(); state.failed++;
    console.error('[gangtise] 行情轮询失败，保留上一次报价：', state.lastError);
  }
  const changed = [];
  for (const [code, list] of groupByCode()) {
    const r = rows.get(code);
    if (!r) continue;
    for (const id of list) { const q = applyQuote(id, r, now); if (q) changed.push(q); }
  }
  return changed;
}

// ---------- 日 K ----------
const ymd = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const loadingDaily = new Map();

/** 拉取（或复用当天已拉过的）真实日 K，写入 db.daily[id]。失败时保留 Mock K 线。 */
export async function ensureDaily(id, now = new Date()) {
  const code = toCode(id);
  if (!code || !enabled()) return false;
  const cur = db.daily[id];
  if (cur?.real && cur.fetched === ymd(now)) return true;
  if (loadingDaily.has(id)) return loadingDaily.get(id);
  const p = (async () => {
    try {
      const start = new Date(now.getTime() - 400 * 86400e3);
      const rows = await G.dayKline(code, ymd(start), ymd(now));
      if (!rows.length) return false;
      const today = db.quotes[id]?.tradeDate;
      // 当天的 K 线由实时报价补，避免重复
      const daily = rows.filter((r) => r.close != null && r.tradeDate !== today).map((r) => ({ t: `${r.tradeDate}T16:00:00Z`, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume ?? 0 }));
      daily.real = true; daily.fetched = ymd(now);
      db.daily[id] = daily;
      const vols = daily.slice(-20).map((x) => x.v).filter(Boolean);
      if (db.quotes[id] && vols.length) db.quotes[id].avgVolume20 = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
      return true;
    } catch (e) {
      console.error(`[gangtise] ${id} 日 K 拉取失败，继续使用 Mock：`, e.message);
      return false;
    } finally { loadingDaily.delete(id); }
  })();
  loadingDaily.set(id, p);
  return p;
}

/** 后台为所有映射标的预取日 K（成交量规则需要 20 日均量）。顺序执行，避免并发打满接口。 */
export async function preloadDaily(ids = Object.keys(mappedIds())) {
  let n = 0;
  for (const id of ids) if (await ensureDaily(id)) n++;
  return n;
}

// ---------- 财报 ----------
const PERIODS = { US: ['q1', 'h1', 'q3', 'annual'], HK: ['q1', 'h1', 'q3', 'annual'], CN: ['q1', 'interim', 'q3', 'annual'] };
const UNIT = { 元: 1e-6, 千元: 1e-3, 万元: 1e-2, 百万元: 1, 亿元: 100 };
const qIndex = (r) => {
  const p = String(r.period || '');
  if (/一季/.test(p)) return 1;
  if (/半年|中报|中期/.test(p)) return 2;
  if (/三季/.test(p)) return 3;
  if (/年度|年报/.test(p)) return 4;
  return null;
};
const n = (x) => (x == null || x === '' ? null : Number(x));
const sum = (...xs) => { const v = xs.map(n).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

/** 把 Gangtise 三张表（累计口径）转为单季度数据，单位：百万（本币）。纯函数，便于测试。 */
export function toQuarterly({ income = [], balance = [], cashflow = [] }, market) {
  const key = (r) => `${r.fiscalYear}Q${qIndex(r)}`;
  const scale = (r) => UNIT[r.unit] ?? 1e-6;
  const inc = new Map(); const cf = new Map(); const bs = new Map();
  for (const r of income) if (qIndex(r)) inc.set(key(r), r);
  for (const r of cashflow) if (qIndex(r)) cf.set(key(r), r);
  for (const r of balance) if (qIndex(r)) bs.set(key(r), r);
  const pick = {
    revenue: (r) => n(r.totalOpRev ?? r.opRev),
    grossProfit: (r) => n(r.grossProfit) ?? (n(r.opRev ?? r.totalOpRev) != null && n(r.opCost) != null ? n(r.opRev ?? r.totalOpRev) - n(r.opCost) : null),
    operatingIncome: (r) => n(r.opProfit),
    netIncome: (r) => n(r.netProfitParent ?? r.netProfitAttrParent ?? r.netProfit),
    eps: (r) => n(r.dilutedEPS ?? r.basicEPS),
  };
  const fcfOf = (r) => { const op = n(r.netOpCashFlows); const capex = n(r.capex ?? r.cashPaidAcqConstructAssets); return op == null ? null : op - Math.abs(capex || 0); };
  const keys = [...inc.keys()].sort((a, b) => (inc.get(a).endDate || '').localeCompare(inc.get(b).endDate || ''));
  const out = [];
  for (const k of keys) {
    const r = inc.get(k); const qi = qIndex(r); const s = scale(r);
    const prevK = `${r.fiscalYear}Q${qi - 1}`;
    const prev = qi > 1 ? inc.get(prevK) : null;
    if (qi > 1 && !prev) continue; // 缺上一期累计数，无法拆出单季
    const diff = (f) => { const a = f(r); if (a == null) return null; if (!prev) return a; const b = f(prev); return b == null ? null : a - b; };
    const c = cf.get(k); const cPrev = qi > 1 ? cf.get(prevK) : null;
    const fcf = c ? (qi > 1 ? (cPrev ? fcfOf(c) - fcfOf(cPrev) : null) : fcfOf(c)) : null;
    const b = bs.get(k);
    const rev = diff(pick.revenue);
    if (rev == null) continue;
    const mm = (x, sc = s) => (x == null ? null : Math.round(x * sc));
    out.push({
      period: `${market === 'US' ? 'FY' : ''}${r.fiscalYear}Q${qi}`, endDate: r.endDate, revenue: mm(rev), grossProfit: mm(diff(pick.grossProfit)),
      operatingIncome: mm(diff(pick.operatingIncome)), netIncome: mm(diff(pick.netIncome)),
      eps: diff(pick.eps) == null ? null : +diff(pick.eps).toFixed(2), fcf: mm(fcf, c ? scale(c) : s),
      cash: b ? mm(n(b.totalCash ?? b.cashEquivalents ?? b.monetaryAssets ?? b.cash), scale(b)) : null,
      debt: b ? mm(sum(b.shortTermDebt, b.longTermDebt, b.stBorrowings, b.ltBorrowings, b.bondsPay), scale(b)) : null,
      guidance: null, currency: r.currency,
    });
  }
  return out;
}

const loadingFin = new Map();
/** 拉取近 3 个财年的财报（免费接口），当天内复用。成功后写入 db.financials / db.financialsMeta。 */
export async function ensureFinancials(id, now = new Date()) {
  const code = toCode(id);
  const market = code && marketOf(code);
  if (!code || !enabled() || instrument(id)?.type !== 'stock') return false;
  db.financialsMeta ||= {};
  if (db.financialsMeta[id]?.fetched === ymd(now)) return true;
  if (loadingFin.has(id)) return loadingFin.get(id);
  const p = (async () => {
    try {
      const y = Number(ymd(now).slice(0, 4));
      const years = [y - 2, y - 1, y, y + 1].map(String); // 美股财年可能领先自然年
      const all = { income: [], balance: [], cashflow: [] };
      for (const fy of years) {
        const s = await G.statements(code, market, { fiscalYear: [fy], period: PERIODS[market] });
        for (const k of Object.keys(all)) all[k].push(...s[k]);
      }
      const quarters = toQuarterly(all, market);
      if (!quarters.length) return false;
      db.financials[id] = quarters;
      db.financialsMeta[id] = { source: 'Gangtise 财报（累计口径拆分为单季）', currency: quarters.at(-1).currency, fetched: ymd(now), code };
      return true;
    } catch (e) {
      console.error(`[gangtise] ${id} 财报拉取失败，保留原数据：`, e.message);
      return false;
    } finally { loadingFin.delete(id); }
  })();
  loadingFin.set(id, p);
  return p;
}

// ---------- 公告（0.1 积分/行） ----------
const BJ = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}+08:00`).toISOString() : null);
const fetchedFilings = {};

export function toFiling(id, r, market) {
  const cat = r.primaryCategory?.secondaryCategory?.categoryName || r.primaryCategory?.categoryName || r.categoryName || '公告';
  return {
    id: `gts_${r.announcementId}`, symbol: id, type: cat, title: String(r.title || '').replace(/^[^:：]{1,30}[:：]\s*/, ''),
    filedAt: BJ(r.publishTime) || (r.announcementDate ? `${r.announcementDate}T00:00:00Z` : new Date().toISOString()),
    source: `Gangtise · ${{ US: '美股', HK: '港股', CN: 'A股' }[market]}公告`, url: '', summary: (r.fileNameList || []).slice(0, 3).join('、'),
  };
}

/** 拉取某个标的最近的公告，当天内只拉一次。 */
export async function ensureFilings(id, { size = 10, now = new Date() } = {}) {
  const code = toCode(id);
  if (!code || !enabled() || instrument(id)?.type !== 'stock') return false;
  if (fetchedFilings[id] === ymd(now)) return true;
  try {
    const market = marketOf(code);
    const rows = await G.announcements(code, market, size);
    fetchedFilings[id] = ymd(now);
    const fresh = rows.map((r) => toFiling(id, r, market));
    const ids = new Set(fresh.map((f) => f.id));
    // 拿到真实公告后，去掉这个标的的演示公告
    db.filings = [...db.filings.filter((f) => f.symbol !== id || (!/演示/.test(f.source) && !ids.has(f.id))), ...fresh];
    return true;
  } catch (e) {
    console.error(`[gangtise] ${id} 公告拉取失败：`, e.message);
    return false;
  }
}

// ---------- 业绩日历（0.1 积分/行） ----------
/** 自选股未来 30 天的财报发布日，合并进 db.calendar（kind: 'earnings'）。每天一次。 */
export async function refreshEarningsCalendar(ids, now = new Date()) {
  if (!enabled()) return 0;
  const map = mappedIds(ids.filter((id) => instrument(id)?.type === 'stock'));
  const byCode = Object.fromEntries(Object.entries(map).map(([id, c]) => [c, id]));
  const codes = Object.keys(byCode);
  if (!codes.length) return 0;
  const end = new Date(now.getTime() + 30 * 86400e3);
  const rows = [];
  for (let i = 0; i < codes.length; i += 100) {
    // 只要正式财报发布日（不含业绩预告 / 快报），省积分
    rows.push(...await G.performanceCalendar({ codes: codes.slice(i, i + 100), categories: ['performanceAnnouncement'], startDate: ymd(now), endDate: ymd(end) }));
  }
  const items = rows.map((r) => {
    const id = (r.securityCodeList || []).map((c) => byCode[c]).find(Boolean);
    return id && {
      id: `gts_pc_${r.performanceReportId}`, kind: 'earnings', symbol: id, time: `${r.publishDate}T00:00:00+08:00`,
      country: instrument(id)?.name || id, event: String(r.title || '').replace(/^.*?·\s*/, ''), importance: 2,
      previous: null, forecast: null, actual: null, unit: '', source: 'Gangtise 业绩日历', dateOnly: true,
    };
  }).filter(Boolean);
  db.calendar = [...db.calendar.filter((c) => c.kind !== 'earnings'), ...items];
  return items.length;
}
