// 真实新闻源（财联社电报 / Finnhub）映射与入库测试，不访问网络。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.WATCHLIST_FILE = '';
let M;

before(async () => {
  const [store, seed, news, feeds, cls, fh] = await Promise.all([
    import('../server/store.js'), import('../server/seed.js'), import('../server/news.js'), import('../server/newsFeeds.js'),
    import('../server/providers/cls.js'), import('../server/providers/finnhub.js'),
  ]);
  M = { store, seed, news, feeds, cls, fh };
  seed.seed(new Date());
});

test('财联社：签名与股票代码映射', () => {
  const u = new URL(M.cls.signedUrl({ rn: '20', last_time: '1' }));
  assert.match(u.searchParams.get('sign'), /^[0-9a-f]{32}$/);
  assert.equal(M.cls.clsSymbol('sh600519'), 'SSE:600519');
  assert.equal(M.cls.clsSymbol('hk00700'), 'HKEX:700');
  assert.equal(M.cls.clsSymbol('sz999999'), null); // 不在标的库中
});

test('财联社：无标题时取正文第一句，stock_list 映射为显式标的', () => {
  const a = M.cls.toArticle({ id: 1, ctime: 1791471948, title: '', level: 'B', content: '【】财联社10月8日电，腾讯控股公布回购进展。后续还有更多。', stock_list: [{ StockID: 'hk00700' }] });
  assert.equal(a.title, '腾讯控股公布回购进展');
  assert.equal(a.source, '财联社');
  assert.equal(a.url, 'https://www.cls.cn/detail/1');
  assert.deepEqual(a.symbols, ['HKEX:700']);
});

test('Finnhub：映射文章并保留查询标的', () => {
  const a = M.fh.toArticle({ id: 9, datetime: 1791471948, headline: 'Chipmaker beats', summary: 'x', source: 'Reuters', url: 'https://r.example/1', related: 'NVDA,AMD' }, 'NASDAQ:NVDA', new Map([['AMD', 'NASDAQ:AMD']]));
  assert.equal(a.source, 'Reuters');
  assert.equal(a.publishedAt, new Date(1791471948e3).toISOString());
  assert.deepEqual(a.symbols, ['NASDAQ:NVDA', 'NASDAQ:AMD']);
  assert.ok(!M.fh.usStockSymbols().some((i) => /ETF/i.test(i.name)));
});

test('入库：清掉演示新闻、按 url 去重、合并标的、丢弃过旧文章；流水线保留显式标的', () => {
  const now = new Date();
  const iso = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const base = { sourceType: 'media', feed: 'finnhub', source: 'X', lead: 'Quarterly update from the company.' };
  const added = M.feeds.ingestArticles([
    { ...base, id: 'a_1', publishedAt: iso(5), title: 'Company posts update', url: 'https://n/1', symbols: ['NASDAQ:AAPL'] },
    { ...base, id: 'a_2', publishedAt: iso(5), title: 'Company posts update', url: 'https://n/1', symbols: ['NASDAQ:MSFT'] },
    { ...base, id: 'a_3', publishedAt: iso(5 * 1440), title: 'Old', url: 'https://n/old' },
  ], now);
  assert.equal(added, 2);
  const { db } = M.store;
  assert.equal(db.articles.length, 1);
  assert.deepEqual(db.articles[0].symbols.sort(), ['NASDAQ:AAPL', 'NASDAQ:MSFT']);
  M.news.processNews(now);
  assert.equal(db.events.length, 1);
  assert.ok(db.events[0].entities.includes('NASDAQ:AAPL') && db.events[0].entities.includes('NASDAQ:MSFT'));
  assert.equal(M.news.searchNews({ symbol: 'NASDAQ:MSFT' }).length, 1);
});

test('真实快讯：同一标的的不同消息不聚合，单条"其他"类不推送提醒', () => {
  const now = new Date();
  const iso = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const A = (id, title) => ({ id, publishedAt: iso(3), source: '财联社', sourceType: 'media', feed: 'cls', title, lead: title, url: `https://cls/${id}`, symbols: ['HKEX:700'] });
  M.feeds.ingestArticles([A('a_c1', '腾讯控股今日回购100万股'), A('a_c2', '腾讯游戏新作首日流水破亿元')], now);
  M.news.processNews(now);
  const ev = M.store.db.events.filter((e) => e.entities.includes('HKEX:700'));
  assert.equal(ev.length, 2);
  assert.equal(M.news.inferEventType('美联储宣布降息 25 个基点'), 'central_bank');
  assert.equal(M.news.inferEventType('某公司股东大会召开'), 'other');
  assert.ok(ev.some((e) => e.eventType === 'other' && e.alertable === false));
});
