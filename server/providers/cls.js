// 财联社电报（A 股 / 港股 / 宏观快讯）。非官方接口，无需密钥：
// https://www.cls.cn/v1/roll/get_roll_list，参数按 key 排序后 sign = md5(sha1(query))（同 cls.cn 网页端）。
// 单次最多 50 条，按 last_time 向前翻页。失败时只告警一次，保留已入库的数据。
// 设置 NEWS_CLS=0 可关闭。
import crypto from 'node:crypto';
import { db } from '../store.js';

const BASE = 'https://www.cls.cn/v1/roll/get_roll_list';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Referer: 'https://www.cls.cn/telegraph' };
const PAGE = 50;

export const enabled = () => process.env.NEWS_CLS !== '0' && process.env.NODE_ENV !== 'test';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export function signedUrl(params) {
  const p = { app: 'CailianpressWeb', os: 'web', sv: '8.4.6', ...params };
  const q = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&');
  return `${BASE}?${q}&sign=${md5(sha1(q))}`;
}

async function fetchPage(lastTime) {
  const url = signedUrl({ category: '', hasFirstVipArticle: '1', last_time: String(lastTime), refresh_type: '1', rn: String(PAGE) });
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errno && String(j.errno) !== '0') throw new Error(`errno ${j.errno} ${j.msg || ''}`);
  return j.data?.roll_data || [];
}

/** 财联社 StockID（sh600519 / sz300735 / bj830799 / hk00700）→ 平台 ID，只保留库中已有的标的。 */
export function clsSymbol(stockId, known = new Set(db.instruments.map((i) => i.id))) {
  const m = String(stockId || '').toLowerCase().match(/^(sh|sz|bj|hk)(\w+)$/);
  if (!m) return null;
  const id = m[1] === 'hk' ? `HKEX:${String(Number(m[2]))}` : `${{ sh: 'SSE', sz: 'SZSE', bj: 'BSE' }[m[1]]}:${m[2].toUpperCase()}`;
  return known.has(id) ? id : null;
}

/** 财联社电报条目 → 平台文章结构。 */
export function toArticle(x, known) {
  const content = String(x.content || x.brief || '').trim();
  // 内容形如"【标题】财联社10月8日电，……"；无标题时取正文第一句
  const body = content.replace(/^【[^】]*】/, '').replace(/^财联社\d+月\d+日电[，,]?/, '').trim();
  const title = String(x.title || '').trim() || (body.match(/^[^。！？!?]+/)?.[0] || body).slice(0, 80);
  return {
    id: `a_cls${x.id}`,
    publishedAt: new Date(x.ctime * 1000).toISOString(),
    source: '财联社', sourceType: 'media', feed: 'cls',
    title, lead: body || content,
    url: `https://www.cls.cn/detail/${x.id}`,
    level: x.level, // A 加红 / B 加粗 / C 普通
    symbols: [...new Set((x.stock_list || []).map((s) => clsSymbol(s.StockID, known)).filter(Boolean))],
  };
}

let lastGood = null;
let warned = false;

/** 拉取最新电报；pages > 1 时向前回补。返回文章数组（失败返回 []，不抛错）。 */
export async function pollCls({ pages = 1 } = {}) {
  if (!enabled()) return [];
  const known = new Set(db.instruments.map((i) => i.id));
  const out = [];
  let last = Math.floor(Date.now() / 1000);
  try {
    for (let i = 0; i < pages; i++) {
      const list = await fetchPage(last);
      for (const x of list) if (!x.is_ad && x.ctime) out.push(toArticle(x, known));
      if (list.length < PAGE) break;
      last = list.at(-1).ctime;
    }
    lastGood = new Date().toISOString();
    if (warned) { console.log('[news] 财联社电报已恢复'); warned = false; }
  } catch (e) {
    if (!warned) { console.warn(`[news] 财联社电报拉取失败（保留已有数据，继续重试）：${e.message}`); warned = true; }
  }
  return out;
}

export const clsState = () => ({ enabled: enabled(), lastGood, failing: warned });
