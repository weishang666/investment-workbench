// 个股页 TradingView 风格图表的数据：K 线（日 / 周 / 月，周月由日 K 合成）、分时、
// 交易计划价位线（关注价 / 买入区间 / 止损 / 目标价）和提醒标记（异动、放量、触及价位、财报）。
import { db, instrument } from './store.js';
import { bars } from './providers/market.js';

const TZ = { US: 'America/New_York', HK: 'Asia/Hong_Kong', CN: 'Asia/Shanghai' };

/** 某个时刻在该市场当地的日期 YYYY-MM-DD。 */
export function marketDate(iso, market) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ[market] || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const weekKey = (date) => {
  // 以周一为一周开始
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const monthKey = (date) => `${date.slice(0, 7)}-01`;

/** 把日 K 按周 / 月合并。bar.time 用该周（周一）/ 该月（1 号）的日期，方便标记对齐。 */
export function aggregate(daily, tf) {
  if (tf === 'D') return daily;
  const keyOf = tf === 'W' ? weekKey : monthKey;
  const out = [];
  for (const b of daily) {
    const k = keyOf(b.time);
    const last = out[out.length - 1];
    if (last && last.time === k) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v || 0;
    } else out.push({ time: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
  }
  return out;
}

/** 日 K（含今天由实时报价补的一根）。 */
function dailyBars(id, market) {
  const pts = bars(id, '1Y').points; // 最多约 1 年
  const all = [...(db.daily[id] || []).slice(0, -251), ...pts]; // 有更长历史时一并带上
  const byDate = new Map();
  const q = db.quotes[id];
  for (const p of all) {
    if (p.o == null || p.c == null) continue;
    const isToday = q && p.t === q.updatedAt;
    const date = isToday ? (q.tradeDate || marketDate(p.t, market)) : String(p.t).slice(0, 10);
    if (!date) continue;
    byDate.set(date, { time: date, o: p.o, h: p.h ?? Math.max(p.o, p.c), l: p.l ?? Math.min(p.o, p.c), c: p.c, v: p.v || 0 });
  }
  return [...byDate.values()].sort((a, b) => a.time.localeCompare(b.time));
}

const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) || n <= 0 ? null : n; };

/** 交易计划里的价位线。 */
export function planLevels(plan = {}) {
  const levels = [];
  const add = (key, label, price, role) => { const p = num(price); if (p) levels.push({ key, label, price: p, role }); };
  add('target', '目标价', plan.target, 'target');
  add('buyHigh', '买入上沿', plan.buyHigh, 'buy');
  add('buyLow', '买入下沿', plan.buyLow, 'buy');
  add('watchPrice', '关注价', plan.watchPrice, 'watch');
  add('stopLoss', '止损', plan.stopLoss, 'stop');
  return levels;
}

const MARK_TYPES = new Set(['price', 'volume', 'level', 'earnings', 'company']);

/** 提醒 → 图上标记。time 对齐到当前周期的 K 线（分时用秒级时间戳）。 */
function alertMarkers(id, market, tf, barTimes) {
  const list = db.alerts.filter((a) => a.symbol === id && MARK_TYPES.has(a.type));
  const out = [];
  for (const a of list) {
    let time;
    if (tf === 'intraday') {
      time = Math.floor(new Date(a.createdAt).getTime() / 1000);
      if (!barTimes.length || time < barTimes[0] || time > barTimes[barTimes.length - 1] + 300) continue;
      // 对齐到不晚于提醒时间的最后一个点
      let lo = 0; let hi = barTimes.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (barTimes[mid] <= time) lo = mid; else hi = mid - 1; }
      time = barTimes[lo];
    } else {
      const date = marketDate(a.createdAt, market);
      if (!date) continue;
      time = tf === 'W' ? weekKey(date) : tf === 'M' ? monthKey(date) : date;
      if (!barTimes.includes(time)) {
        // 非交易日产生的提醒，挂到之后最近的一根 K 线上
        const next = barTimes.find((t) => t > time);
        if (!next) continue;
        time = next;
      }
    }
    const d = a.data || {};
    let shape = 'circle'; let position = 'aboveBar'; let text = a.category; let tone = 'info';
    if (a.type === 'price') {
      const upMove = d.direction === 'up';
      shape = upMove ? 'arrowUp' : 'arrowDown'; position = upMove ? 'belowBar' : 'aboveBar';
      text = `${upMove ? '+' : '-'}${Math.abs(d.pct ?? 0).toFixed(1)}%`; tone = upMove ? 'up' : 'down';
    } else if (a.type === 'volume') { text = `量 ${d.ratio ?? ''}x`; tone = 'volume'; }
    else if (a.type === 'level') { shape = 'square'; text = { stopLoss: '止损', target: '目标', buyZone: '买区' }[d.key] || '价位'; tone = d.key === 'stopLoss' ? 'stop' : 'level'; }
    else if (a.type === 'earnings') { text = '财报'; tone = 'event'; }
    else if (a.type === 'company') { text = '公司'; tone = 'event'; }
    out.push({ time, shape, position, text, tone, title: a.title, alertId: a.id });
  }
  // 同一根 K 线上同类标记只保留最新一条（提醒列表是新的在前）
  const seen = new Set();
  return out.filter((m) => { const k = `${m.time}|${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** GET /api/chart/:id?tf=intraday|D|W|M */
export function chartData(id, tf = 'D') {
  if (!['intraday', 'D', 'W', 'M'].includes(tf)) tf = 'D';
  const inst = instrument(id);
  const q = db.quotes[id];
  if (!inst || !q) return null;
  const market = inst.market;
  let candles = [];
  let line = [];
  if (tf === 'intraday') {
    const seen = new Set();
    for (const p of bars(id, 'intraday').points) {
      const t = Math.floor(new Date(p.t).getTime() / 1000);
      if (!Number.isFinite(t) || seen.has(t) || p.c == null) continue;
      seen.add(t); line.push({ time: t, value: p.c });
    }
    line.sort((a, b) => a.time - b.time);
  } else {
    candles = aggregate(dailyBars(id, market), tf);
  }
  const barTimes = tf === 'intraday' ? line.map((p) => p.time) : candles.map((b) => b.time);
  return {
    id, tf, market,
    kind: tf === 'intraday' ? 'line' : 'candle',
    candles, line,
    prevClose: q.prevClose ?? null,
    realDaily: !!db.daily[id]?.real,
    source: q.source,
    levels: planLevels(db.research[id]?.plan),
    markers: alertMarkers(id, market, tf, barTimes),
  };
}
