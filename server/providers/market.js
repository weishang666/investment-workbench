// 行情数据源。当前为 Mock 实现：确定性随机游走生成日线 / 分时，并每隔几秒小幅跳动。
// 接入真实行情时实现同样的接口：seedInstrument(id) / tick() / bars(id, period)。
// K 线不持久化（启动后按需生成），只持久化报价。比值 / 价差标的由各腿行情计算。
import { db, instrument } from '../store.js';
import { sessionFor } from '../lib/sessions.js';
import { parseExpression } from '../lib/instruments.js';

// 基准价：[上一交易日收盘, 今日相对昨收的初始涨跌幅 %, 日均成交量]
const BASE = {
  'OANDA:XAUUSD': [2650.4, 1.62, 0], 'COMEX:GC1!': [2668.9, 1.55, 210000], 'OANDA:XAGUSD': [31.42, 2.1, 0],
  'NYMEX:CL1!': [71.35, -1.85, 320000], 'ICEEUR:BRN1!': [74.9, -1.6, 260000], 'TVC:DXY': [101.85, -0.42, 0],
  'TVC:US10Y': [4.012, -1.1, 0], 'SP:SPX': [5810.2, 0.48, 0], 'NASDAQ:IXIC': [18420.6, 0.95, 0], 'DJ:DJI': [42150.3, 0.12, 0],
  'SSE:000001': [3336.5, -0.35, 0], 'HSI:HSI': [21130.8, 0.66, 0], 'FX_IDC:USDCNH': [7.0612, -0.08, 0],
  'NASDAQ:NVDA': [128.4, 5.3, 230e6], 'NASDAQ:AAPL': [226.8, -0.7, 52e6], 'NASDAQ:TSLA': [249.3, -2.4, 95e6],
  'NASDAQ:META': [585.2, 1.2, 14e6], 'NASDAQ:GOOGL': [166.9, 0.4, 24e6], 'NASDAQ:MSFT': [416.3, 0.2, 19e6],
  'NYSE:TSM': [189.5, 3.1, 16e6], 'NASDAQ:AMD': [158.1, 2.6, 41e6], 'SSE:600519': [1572.0, -0.9, 3.4e6],
  'HKEX:700': [418.6, 1.1, 21e6], 'HKEX:9988': [96.35, -1.3, 58e6],
  // 用户关注列表中的常见宏观 / 加密标的，给出量级合理的演示价格
  'ICMARKETS:XAUUSD': [2651.0, 1.6, 0], 'TVC:SILVER': [31.40, 2.0, 0], 'OANDA:XPTUSD': [985, 0.8, 0], 'OANDA:XPDUSD': [1040, -0.6, 0],
  'COMEX:HG1!': [4.42, 0.9, 90000], 'ICMARKETS:XTIUSD': [71.3, -1.9, 0], 'TVC:US30Y': [4.31, -0.8, 0], 'FRED:DFII10': [1.72, -1.2, 0],
  'FRED:T10YIE': [2.29, 0.4, 0], 'TVC:VIX': [16.8, -4.2, 0], 'FX:SPX500': [5812, 0.47, 0], 'NASDAQ:NDX': [20310, 0.9, 0],
  'FOREXCOM:HK50': [21140, 0.6, 0], 'ICMARKETS:HK50': [21138, 0.6, 0], 'TVC:HSI': [21130.8, 0.66, 0], 'HSI:HSTECH': [4720, 1.1, 0],
  'ICMARKETS:JP225': [38950, 0.3, 0], 'OANDA:JP225USD': [38940, 0.3, 0], 'TVC:KOSPI': [2580, -0.2, 0], 'OANDA:USDCNH': [7.0615, -0.08, 0],
  'OANDA:USDJPY': [148.6, -0.35, 0], 'TVC:GOLD': [2650.4, 1.62, 0], 'AMEX:GDX': [39.8, 2.9, 18e6], 'AMEX:GLD': [244.5, 1.6, 8e6],
  'AMEX:SLV': [28.6, 2.0, 25e6], 'NASDAQ:QQQ': [494.0, 0.9, 40e6], 'NASDAQ:SOX': [5140, 2.4, 0], 'AMEX:SOXL': [31.2, 7.1, 70e6],
  'BITSTAMP:BTCUSD': [62450, 1.2, 0], 'BINANCE:ETHUSDT': [2440, 1.8, 0], 'BINANCE:SOLUSDT': [143.5, 2.6, 0], 'BINANCE:BNBUSDT': [568, 0.6, 0],
  'BINANCE:XRPUSDT': [0.532, -0.9, 0], 'BINANCE:PAXGUSDT': [2655, 1.5, 0], 'BINANCE:BNBBTC': [0.00909, -0.6, 0],
};

const DELAY = { US: 0, CN: 0, HK: 15, JP: 20, KR: 20, TW: 20, DE: 15, CA: 15, MY: 15, GLOBAL: 0, CRYPTO: 0 };
const SOURCE = 'Mock 行情（演示数据）';

function rng(seed) {
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function baseFor(id) {
  if (BASE[id]) return BASE[id];
  const r = rng(id);
  const inst = instrument(id);
  const scale = { CN: [5, 120], HK: [2, 150], JP: [500, 8000], KR: [20000, 180000], TW: [100, 1500], CRYPTO: [0.05, 300] }[inst?.market] || [10, 400];
  return [scale[0] + r() * (scale[1] - scale[0]), (r() - 0.5) * 4, inst?.type === 'stock' ? 1e6 + r() * 2e7 : 0];
}

function round(x, n) {
  const digits = n ?? (Math.abs(x) < 1 ? 5 : Math.abs(x) < 10 ? 4 : 2);
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function genDaily(id, prevClose, avgVol, now = new Date()) {
  const r = rng(id + ':daily');
  const closes = [prevClose];
  let price = prevClose;
  for (let i = 0; i < 259; i++) { price = price / (1 + (r() - 0.48) * 0.035); closes.unshift(price); }
  const d = new Date(now); d.setUTCHours(20, 0, 0, 0);
  let cursor = new Date(d); const dates = [];
  while (dates.length < closes.length) {
    cursor = new Date(cursor.getTime() - 86400000);
    if ([0, 6].includes(cursor.getUTCDay())) continue;
    dates.unshift(cursor.toISOString());
  }
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] * (1 + (r() - 0.5) * 0.01) : c;
    return { t: dates[i], o: round(o), h: round(Math.max(o, c) * (1 + r() * 0.012)), l: round(Math.min(o, c) * (1 - r() * 0.012)), c: round(c), v: Math.round(avgVol * (0.6 + r() * 0.8)) };
  });
}

function genIntraday(id, prevClose, last, avgVol, now = new Date()) {
  const minutes = 120;
  const start = now.getTime() - minutes * 60000;
  const ri = rng(id + ':intra');
  const pct = ((last - prevClose) / prevClose) * 100;
  const pts = [];
  for (let i = 0; i <= minutes; i++) {
    const base = prevClose + (last - prevClose) * (i / minutes);
    const p = i === minutes ? last : base * (1 + (ri() - 0.5) * 0.004);
    const v = Math.round((avgVol / 390) * (0.5 + ri()) * (Math.abs(pct) > 4 ? 2.4 : 1));
    pts.push({ t: new Date(start + i * 60000).toISOString(), p: round(p), v });
  }
  return pts;
}

function sessionInfo(market, now) {
  // 演示模式下美股默认按"正常交易时段"运行，便于随时看到 5% 异动规则；MOCK_SESSION=real 时按真实美东时间。
  const forced = process.env.MOCK_SESSION || 'regular';
  if (forced !== 'real' && market === 'US') return { session: forced, tradeDate: sessionFor(market, now).tradeDate };
  return sessionFor(market, now);
}

export function computeChange(q) {
  q.change = round(q.last - q.prevClose);
  q.changePct = q.prevClose ? round(((q.last - q.prevClose) / q.prevClose) * 100, 2) : 0;
  return q;
}

const MCAP_SHARES = { 'NASDAQ:NVDA': 24.5e9, 'NASDAQ:AAPL': 15.2e9, 'NASDAQ:TSLA': 3.2e9, 'NASDAQ:META': 2.53e9, 'NASDAQ:GOOGL': 12.3e9, 'NASDAQ:MSFT': 7.43e9, 'NYSE:TSM': 5.19e9, 'NASDAQ:AMD': 1.62e9, 'SSE:600519': 1.256e9, 'HKEX:700': 9.3e9, 'HKEX:9988': 19.1e9 };

/** 生成某个标的的报价（启动时或导入新标的时调用）。K 线按需生成。 */
export function seedInstrument(id, now = new Date()) {
  const inst = instrument(id);
  if (inst?.type === 'spread') return seedSpread(id, now);
  const [prevClose, pct, avgVol] = baseFor(id);
  const last = prevClose * (1 + pct / 100);
  db.daily[id] = genDaily(id, prevClose, avgVol, now);
  const pts = genIntraday(id, prevClose, last, avgVol, now);
  db.intraday[id] = pts;
  const market = inst?.market || 'GLOBAL';
  const econ = inst?.type === 'econ';
  db.quotes[id] = {
    id, last: round(last), prevClose: round(prevClose), open: pts[0].p,
    high: round(Math.max(...pts.map((x) => x.p))), low: round(Math.min(...pts.map((x) => x.p))),
    volume: avgVol ? pts.reduce((s, x) => s + x.v, 0) : null, avgVolume20: avgVol || null,
    marketCap: MCAP_SHARES[id] ? round(last * MCAP_SHARES[id]) : null,
    source: econ ? 'Mock 经济数据（日度，演示）' : SOURCE, delayMinutes: econ ? 1440 : (DELAY[market] ?? 0), updatedAt: now.toISOString(),
    ...(econ ? { session: 'closed', tradeDate: now.toISOString().slice(0, 10) } : sessionInfo(market, now)),
  };
  computeChange(db.quotes[id]);
}

// ---------- 比值 / 价差 ----------
const legs = (id) => parseExpression(id);
const combine = (op, a, b) => (op === '/' ? a / b : a - b);

function legQuote(sym) {
  // 各腿可能经别名映射（TVC:GOLD → OANDA:XAUUSD），也可能只为计算而存在
  return db.quotes[sym] || db.quotes[instrument(sym)?.id];
}

function seedSpread(id, now) {
  const { left, op, right } = legs(id);
  for (const s of [left, right]) if (!db.quotes[s]) seedInstrument(s, now);
  updateSpread(id, now);
}

function updateSpread(id, now = new Date()) {
  const { left, op, right } = legs(id);
  const a = legQuote(left); const b = legQuote(right);
  if (!a || !b) return null;
  const q = db.quotes[id] || (db.quotes[id] = { id, volume: null, avgVolume20: null, marketCap: null, delayMinutes: Math.max(a.delayMinutes, b.delayMinutes) });
  q.last = round(combine(op, a.last, b.last));
  q.prevClose = round(combine(op, a.prevClose, b.prevClose));
  q.open = round(combine(op, a.open, b.open));
  q.high = Math.max(q.high ?? q.last, q.last); q.low = Math.min(q.low ?? q.last, q.last);
  q.source = `由 ${left} ${op === '/' ? '÷' : '−'} ${right} 计算（${SOURCE}）`;
  q.updatedAt = now.toISOString();
  q.session = a.session === 'regular' || b.session === 'regular' ? 'regular' : 'closed';
  q.tradeDate = a.tradeDate;
  return computeChange(q);
}

function ensureBars(id) {
  const inst = instrument(id);
  const q = db.quotes[id];
  if (!q) return;
  if (inst?.type === 'spread') {
    const { left, op, right } = legs(id);
    ensureBars(left); ensureBars(right);
    const A = db.daily[left] || []; const B = db.daily[right] || [];
    const n = Math.min(A.length, B.length);
    db.daily[id] = Array.from({ length: n }, (_, i) => {
      const a = A[A.length - n + i]; const b = B[B.length - n + i];
      const c = combine(op, a.c, b.c); const o = combine(op, a.o, b.o);
      return { t: a.t, o: round(o), h: round(Math.max(o, c)), l: round(Math.min(o, c)), c: round(c), v: 0 };
    });
    const IA = db.intraday[left] || []; const IB = db.intraday[right] || [];
    const m = Math.min(IA.length, IB.length);
    db.intraday[id] = Array.from({ length: m }, (_, i) => ({ t: IA[IA.length - m + i].t, p: round(combine(op, IA[IA.length - m + i].p, IB[IB.length - m + i].p)), v: 0 }));
    return;
  }
  const [, , avgVol] = baseFor(id);
  if (!db.daily[id]) db.daily[id] = genDaily(id, q.prevClose, avgVol);
  if (!db.intraday[id]) db.intraday[id] = genIntraday(id, q.prevClose, q.last, avgVol);
}

/** 每次 tick 对所有报价做小幅随机波动，并追加分时点。返回变化过的报价列表。 */
export function tick(now = new Date()) {
  const changed = [];
  const spreads = [];
  for (const id of Object.keys(db.quotes)) {
    const q = db.quotes[id];
    const inst = instrument(id);
    if (inst?.type === 'spread') { spreads.push(id); continue; }
    if (inst?.type === 'econ') continue;
    Object.assign(q, sessionInfo(inst?.market || 'GLOBAL', now));
    if (q.session === 'closed') continue;
    const drift = (Math.random() - 0.5) * 0.0016;
    q.last = round(q.last * (1 + drift));
    q.high = Math.max(q.high, q.last);
    q.low = Math.min(q.low, q.last);
    const v = q.avgVolume20 ? Math.round((q.avgVolume20 / 390 / 12) * (0.5 + Math.random())) : 0;
    if (q.volume != null) q.volume += v;
    q.updatedAt = now.toISOString();
    computeChange(q);
    const series = db.intraday[id];
    if (series) {
      const lastPt = series[series.length - 1];
      if (!lastPt || now - new Date(lastPt.t) >= 60000) series.push({ t: now.toISOString(), p: q.last, v });
      else { lastPt.p = q.last; lastPt.v += v; }
      if (series.length > 400) series.shift();
    }
    changed.push(q);
  }
  for (const id of spreads) {
    const q = updateSpread(id, now);
    if (q) { changed.push(q); if (db.intraday[id]) db.intraday[id].push({ t: now.toISOString(), p: q.last, v: 0 }); }
  }
  return changed;
}

/** 按周期返回 K 线 / 分时数据。 */
export function bars(id, period = '1D') {
  ensureBars(id);
  const daily = db.daily[id] || [];
  const intra = db.intraday[id] || [];
  const q = db.quotes[id];
  const today = q ? [{ t: q.updatedAt, o: q.open, h: q.high, l: q.low, c: q.last, v: q.volume }] : [];
  switch (period) {
    case 'intraday': return { kind: 'line', points: intra.map((x) => ({ t: x.t, c: x.p, v: x.v })) };
    case '1D': return { kind: 'line', points: intra.filter((_, i) => i % 5 === 0 || i === intra.length - 1).map((x) => ({ t: x.t, c: x.p, v: x.v })) };
    case '1W': return { kind: 'candle', points: [...daily.slice(-4), ...today] };
    case '1M': return { kind: 'candle', points: [...daily.slice(-21), ...today] };
    case '3M': return { kind: 'candle', points: [...daily.slice(-62), ...today] };
    case '1Y': return { kind: 'candle', points: [...daily.slice(-251), ...today] };
    default: return { kind: 'candle', points: [...daily.slice(-21), ...today] };
  }
}

export const MARKET_SOURCE = SOURCE;
