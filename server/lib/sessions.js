// 交易时段判断。美股区分盘前 / 正常交易 / 盘后 / 休市（按美东时间，不含节假日表）。

function partsIn(tz, date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { weekday: o.weekday, date: `${o.year}-${o.month}-${o.day}`, minutes: (Number(o.hour) % 24) * 60 + Number(o.minute) };
}

/** 返回 { session: 'pre'|'regular'|'post'|'closed', tradeDate } */
export function usSession(date = new Date()) {
  const { weekday, date: d, minutes } = partsIn('America/New_York', date);
  if (weekday === 'Sat' || weekday === 'Sun') return { session: 'closed', tradeDate: d };
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return { session: 'pre', tradeDate: d };
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return { session: 'regular', tradeDate: d };
  if (minutes >= 16 * 60 && minutes < 20 * 60) return { session: 'post', tradeDate: d };
  return { session: 'closed', tradeDate: d };
}

export function cnSession(date = new Date()) {
  const { weekday, date: d, minutes } = partsIn('Asia/Shanghai', date);
  if (weekday === 'Sat' || weekday === 'Sun') return { session: 'closed', tradeDate: d };
  const open = (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) || (minutes >= 13 * 60 && minutes < 15 * 60);
  return { session: open ? 'regular' : 'closed', tradeDate: d };
}

export function hkSession(date = new Date()) {
  const { weekday, date: d, minutes } = partsIn('Asia/Hong_Kong', date);
  if (weekday === 'Sat' || weekday === 'Sun') return { session: 'closed', tradeDate: d };
  const open = (minutes >= 9 * 60 + 30 && minutes < 12 * 60) || (minutes >= 13 * 60 && minutes < 16 * 60);
  return { session: open ? 'regular' : 'closed', tradeDate: d };
}

// 其他市场的连续交易时段（当地时间，分钟）
const LOCAL = {
  JP: ['Asia/Tokyo', [[540, 690], [750, 930]]],
  KR: ['Asia/Seoul', [[540, 930]]],
  TW: ['Asia/Taipei', [[540, 810]]],
  DE: ['Europe/Berlin', [[540, 1050]]],
  CA: ['America/Toronto', [[570, 960]]],
  MY: ['Asia/Kuala_Lumpur', [[630, 750], [870, 1080]]],
};

function localSession(tz, ranges, date) {
  const { weekday, date: d, minutes } = partsIn(tz, date);
  if (weekday === 'Sat' || weekday === 'Sun') return { session: 'closed', tradeDate: d };
  return { session: ranges.some(([a, b]) => minutes >= a && minutes < b) ? 'regular' : 'closed', tradeDate: d };
}

export function sessionFor(market, date = new Date()) {
  if (market === 'CN') return cnSession(date);
  if (market === 'HK') return hkSession(date);
  if (market === 'US') return usSession(date);
  if (market === 'CRYPTO') return { session: 'regular', tradeDate: date.toISOString().slice(0, 10) }; // 7×24
  if (LOCAL[market]) return localSession(...LOCAL[market], date);
  // 外汇 / 商品期货近似 24 小时（周末休市）
  const s = usSession(date);
  return { session: s.session === 'closed' && ['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(date)) ? 'closed' : 'regular', tradeDate: s.tradeDate };
}

export const SESSION_LABEL = { pre: '盘前', regular: '交易中', post: '盘后', closed: '休市' };

export function etHourMinute(date = new Date()) {
  return partsIn('America/New_York', date).minutes;
}

// 连续交易时段（当地时间分钟），用于计算当日交易进度
const PROGRESS = { US: ['America/New_York', [[570, 960]]], HK: ['Asia/Hong_Kong', [[570, 720], [780, 960]]], CN: ['Asia/Shanghai', [[570, 690], [780, 900]]] };

/** 当日已完成的交易时段比例（0–1）；不支持的市场返回 null */
export function sessionProgress(market, date = new Date()) {
  const def = PROGRESS[market];
  if (!def) return null;
  const { minutes } = partsIn(def[0], date);
  const total = def[1].reduce((s, [a, b]) => s + b - a, 0);
  const done = def[1].reduce((s, [a, b]) => s + Math.max(0, Math.min(minutes, b) - a), 0);
  return done / total;
}
