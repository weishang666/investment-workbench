// Gangtise Open API 客户端（零依赖，Node 20+ 自带 fetch）。
// 密钥读环境变量 GANGTISE_ACCESS_KEY / GANGTISE_SECRET_KEY（可写在根目录 .env，见 server/lib/env.js）。
// 只使用免费接口做后台轮询（实时快照、日 K、财报、证券检索）；按行计费的公告 / 业绩日历走积分日上限。
// 永远不调用 AI / 50 积分类接口。
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data');
const USAGE_FILE = path.join(DATA_DIR, 'gangtise-usage.json');

export const BASE_URL = () => process.env.GANGTISE_BASE_URL || 'https://openapi.gangtise.com';
export const enabled = () => !!(process.env.GANGTISE_ACCESS_KEY && process.env.GANGTISE_SECRET_KEY) && process.env.GANGTISE_DISABLED !== '1';
export const dailyCap = () => Number(process.env.GANGTISE_DAILY_POINTS || 200);

export const EP = {
  login: '/application/auth/oauth/open/loginV2',
  realtime: '/application/open-quote/quote/realtime',
  dayKline: '/application/open-quote/kline/daily',
  minuteKline: '/application/open-quote/kline/minute',
  search: '/application/open-reference/securities/search',
  incomeUS: '/application/open-fundamental/financial-report/income-statement/us',
  balanceUS: '/application/open-fundamental/financial-report/balance-sheet/us',
  cashflowUS: '/application/open-fundamental/financial-report/cash-flow-statement/us',
  incomeHK: '/application/open-fundamental/financial-report/income-statement/hk',
  balanceHK: '/application/open-fundamental/financial-report/balance-sheet/hk',
  cashflowHK: '/application/open-fundamental/financial-report/cash-flow-statement/hk',
  incomeCN: '/application/open-fundamental/financial-report/income-statement/accumulated',
  balanceCN: '/application/open-fundamental/financial-report/balance-sheet/accumulated',
  cashflowCN: '/application/open-fundamental/financial-report/cash-flow-statement/accumulated',
  annUS: '/application/open-insight/announcement-us/getList',
  annHK: '/application/open-insight/announcement-hk/getList',
  annCN: '/application/open-insight/announcement/getList',
  perfCalendar: '/application/open-insight/schedule/performance-calendar/getList',
};
// 按行计费的接口（积分 / 行）
export const BILLING = { [EP.annUS]: 0.1, [EP.annHK]: 0.1, [EP.annCN]: 0.1, [EP.perfCalendar]: 0.1 };
const AUTH_RETRY_CODES = new Set(['8000014', '8000015', '0000001008', '999002']);

export class GangtiseError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

// ---------- 积分台账（按北京时间自然日） ----------
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
let usage = null;
function loadUsage() {
  if (usage?.date === today()) return usage;
  try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); if (u.date === today()) return (usage = u); } catch { /* 首次 */ }
  return (usage = { date: today(), points: 0, calls: {} });
}
function recordUsage(p, points) {
  const u = loadUsage();
  u.points = +(u.points + points).toFixed(2);
  u.calls[p] = (u.calls[p] || 0) + 1;
  if (process.env.NODE_ENV === 'test') return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2)); } catch { /* 台账写失败不影响取数 */ }
}
export function usageToday() { const u = loadUsage(); return { ...u, cap: dailyCap() }; }
export function _resetUsage() { usage = { date: today(), points: 0, calls: {} }; }

// ---------- 请求 ----------
let token = null; // { value, expiresAt(ms) }
let loggingIn = null;
export function _resetAuth() { token = null; loggingIn = null; }

async function post(p, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.Authorization = auth;
  const res = await fetch(BASE_URL() + p, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new GangtiseError(`HTTP ${res.status}：响应不是 JSON`, undefined, res.status); }
  const code = json.code === undefined ? undefined : String(json.code);
  const ok = json.status === true || json.success === true || code === '000000' || code === '0';
  if (!res.ok || !ok) throw new GangtiseError(json.msg || `HTTP ${res.status}`, code, res.status);
  return json.data;
}

async function login() {
  const d = await post(EP.login, { accessKey: process.env.GANGTISE_ACCESS_KEY, secretKey: process.env.GANGTISE_SECRET_KEY });
  if (!d?.accessToken) throw new GangtiseError('登录成功但没有返回 accessToken');
  const v = /^bearer\s+/i.test(d.accessToken) ? d.accessToken : `Bearer ${d.accessToken}`;
  // 提前 5 分钟视为过期
  token = { value: v, expiresAt: Date.now() + Math.max(60, (Number(d.expiresIn) || 10800) - 300) * 1000 };
  return v;
}

async function authHeader(force = false) {
  if (!force && token && token.expiresAt > Date.now()) return token.value;
  if (!loggingIn) loggingIn = login().finally(() => { loggingIn = null; });
  return loggingIn;
}

/** 调用一个接口。按行计费的接口会先检查当日积分上限。 */
export async function call(p, body = {}) {
  if (!enabled()) throw new GangtiseError('未配置 GANGTISE_ACCESS_KEY / GANGTISE_SECRET_KEY');
  const price = BILLING[p] || 0;
  if (price) {
    const est = price * (body.size || 20);
    const u = loadUsage();
    if (u.points + est > dailyCap()) throw new GangtiseError(`今日 Gangtise 积分已用 ${u.points}，再调用预计 ${est} 会超过上限 ${dailyCap()}`, 'POINTS_CAP');
  }
  let data;
  try {
    data = await post(p, body, await authHeader());
  } catch (e) {
    if (!AUTH_RETRY_CODES.has(e.code)) throw e;
    data = await post(p, body, await authHeader(true)); // token 失效：重新登录一次
  }
  const rows = Array.isArray(data?.list) ? data.list.length : 0;
  recordUsage(p, price * rows);
  if (price) console.log(`[gangtise] ${p.split('/').slice(-2).join('/')} ${rows} 行，${(price * rows).toFixed(1)} 积分（今日累计 ${loadUsage().points}/${dailyCap()}）`);
  return data;
}

// 行情类接口返回 { fieldList, list: [[...], ...] } 的列式数据，统一转成对象数组
export function list(d) {
  const rows = Array.isArray(d?.list) ? d.list : Array.isArray(d) ? d : [];
  const f = d?.fieldList;
  return Array.isArray(f) ? rows.map((r) => (Array.isArray(r) ? Object.fromEntries(f.map((k, i) => [k, r[i]])) : r)) : rows;
}

// ---------- 业务封装 ----------
/** 实时快照。codes 为 Gangtise 代码（NVDA.O / 00700.HK / 600519.SH / SPX.SPI），或单个市场关键字 usStocks。 */
export async function realtime(codes, fieldList = []) {
  const out = [];
  for (let i = 0; i < codes.length; i += 200) out.push(...list(await call(EP.realtime, { securityList: codes.slice(i, i + 200), fieldList })));
  return out;
}

export async function dayKline(code, startDate, endDate) {
  return list(await call(EP.dayKline, { securityList: [code], startDate, endDate, limit: 1000 }));
}

export async function minuteKline(code, startDate, endDate) {
  return list(await call(EP.minuteKline, { securityCode: code, startDate, endDate, limit: 1000 }));
}

export async function searchSecurities(keyword, category) {
  return list(await call(EP.search, { keyword, ...(category ? { category: [category] } : {}), top: 10 }));
}

/** 财报（三张表，累计口径），market: US / HK / CN；opts 如 { fiscalYear: ['2026'], period: ['q1','h1','q3','annual'] }。
 *  注意：不传 period 时接口只返回最新一期；美股一次最多返回每种报告期各一条，所以按财年逐年查。 */
export async function statements(code, market, opts = {}) {
  const k = { US: 'US', HK: 'HK', CN: 'CN' }[market];
  if (!k) return null;
  const body = { securityCode: code, ...opts };
  const [income, balance, cashflow] = await Promise.all([EP[`income${k}`], EP[`balance${k}`], EP[`cashflow${k}`]].map((p) => call(p, body).then(list)));
  return { income, balance, cashflow };
}

export async function announcements(code, market, size = 10) {
  const p = { US: EP.annUS, HK: EP.annHK, CN: EP.annCN }[market];
  if (!p) return [];
  return list(await call(p, { securityList: [code], from: 0, size }));
}

/** 业绩日历（单页最多 50 行，按页取完，最多 maxPages 页） */
export async function performanceCalendar({ codes = [], markets = [], categories = [], startDate, endDate, maxPages = 4 }) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = list(await call(EP.perfCalendar, { from: page * 50, size: 50, startDate, endDate, securityList: codes, marketList: markets, categoryList: categories }));
    out.push(...rows);
    if (rows.length < 50) break;
  }
  return out;
}
