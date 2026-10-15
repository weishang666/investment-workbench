// Finnhub 美股新闻（免费档）。配置 FINNHUB_API_KEY 后启用：
//  - /api/v1/news?category=general            市场要闻
//  - /api/v1/company-news?symbol=X&from&to    自选中的每只美股个股（跳过 ETF / 指数）
// 免费档限 60 次/分钟：这里按 ~50 次/分钟节流，每轮约 5 分钟。密钥只放在 .env，任何日志都不输出密钥。
import { db } from '../store.js';
import { watchedSymbols } from '../watchlist.js';

const BASE = 'https://finnhub.io/api/v1';
const GAP_MS = 1200;          // ≈50 次/分钟
const PER_SYMBOL = 15;        // 每只股票每轮最多保留最新 15 条
const LOOKBACK_DAYS = 2;

const key = () => process.env.FINNHUB_API_KEY || '';
export const enabled = () => !!key() && process.env.NODE_ENV !== 'test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (s) => String(s).split(key() || '\u0000').join('***');

let warned = false;
let lastGood = null;
let lastCall = 0;

async function call(path, params) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const qs = new URLSearchParams({ ...params, token: key() });
  const r = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (r.status === 429) { await sleep(60000); lastCall = Date.now(); throw Object.assign(new Error('触发频率限制（429），已等待 60 秒'), { soft: true }); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`密钥无效或无权限（HTTP ${r.status}）`), { fatal: true });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const ETF_RE = /etf|指数|index|基金|fund|trust|杠杆|leveraged|ishares|spdr|invesco|proshares|direxion|vaneck|global x/i;

/** 自选里需要拉个股新闻的美股：只要个股，跳过 ETF / 指数。 */
export function usStockSymbols() {
  const watched = new Set(watchedSymbols());
  return db.instruments.filter((i) => watched.has(i.id) && i.market === 'US' && i.type === 'stock'
    && !ETF_RE.test(`${i.name || ''} ${i.enName || ''} ${i.intro || ''} ${(i.themes || []).join(' ')}`));
}

/** Finnhub 新闻条目 → 平台文章结构。symbol 为查询时的标的，确保关联不依赖文本匹配。 */
export function toArticle(x, symbol, codeMap = new Map()) {
  const related = String(x.related || '').split(',').map((s) => codeMap.get(s.trim().toUpperCase())).filter(Boolean);
  return {
    id: `a_fh${x.id}`,
    publishedAt: new Date(x.datetime * 1000).toISOString(),
    source: x.source || 'Finnhub', sourceType: 'media', feed: 'finnhub',
    title: String(x.headline || '').trim(),
    lead: String(x.summary || '').trim() || String(x.headline || '').trim(),
    url: x.url,
    symbols: [...new Set([symbol, ...related].filter(Boolean))],
  };
}

const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * 跑一轮：先市场要闻，再逐只个股。每处理一批就回调 onArticles(articles)，便于界面尽快看到新闻。
 * 不抛错；密钥无效时本轮直接结束。
 */
export async function pollFinnhub(onArticles, { batch = 20 } = {}) {
  if (!enabled()) return 0;
  const stocks = usStockSymbols();
  const codeMap = new Map(db.instruments.filter((i) => i.market === 'US').map((i) => [i.id.split(':')[1], i.id]));
  const now = new Date();
  const from = ymd(new Date(now.getTime() - LOOKBACK_DAYS * 86400e3));
  const to = ymd(now);
  let total = 0;
  let buf = [];
  const flushBuf = () => { if (buf.length) { onArticles(buf); total += buf.length; buf = []; } };
  try {
    const general = await call('/news', { category: 'general' });
    for (const x of Array.isArray(general) ? general : []) if (x.headline && x.url) buf.push(toArticle(x, null, codeMap));
    flushBuf();
    for (let i = 0; i < stocks.length; i++) {
      const inst = stocks[i];
      try {
        const list = await call('/company-news', { symbol: inst.id.split(':')[1], from, to });
        const items = (Array.isArray(list) ? list : []).filter((x) => x.headline && x.url).sort((a, b) => b.datetime - a.datetime).slice(0, PER_SYMBOL);
        for (const x of items) buf.push(toArticle(x, inst.id, codeMap));
      } catch (e) {
        if (e.fatal) throw e;
        if (!e.soft && !warned) { console.warn(`[news] Finnhub ${inst.id} 拉取失败：${scrub(e.message)}`); warned = true; }
      }
      if ((i + 1) % batch === 0) flushBuf();
    }
    flushBuf();
    lastGood = new Date().toISOString();
    if (warned) { warned = false; }
  } catch (e) {
    flushBuf();
    if (!warned) { console.warn(`[news] Finnhub 拉取失败（保留已有数据，下一轮重试）：${scrub(e.message)}`); warned = true; }
  }
  return total;
}

export const finnhubState = () => ({ enabled: enabled(), lastGood, failing: warned, symbols: enabled() ? usStockSymbols().length : 0 });
