// 极简持久化层：内存对象 + JSON 文件（data/db.json）。
// 所有业务模块都通过 db 访问数据，后续换 SQLite / Postgres 只需替换本文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export const db = {
  instruments: [],
  watchlist: { groups: [] },
  quotes: {},          // id -> quote
  daily: {},           // id -> [{t, o, h, l, c, v}]
  intraday: {},        // id -> [{t, p, v}]
  articles: [],        // 原始新闻
  events: [],          // 聚合后的新闻事件
  calendar: [],
  filings: [],
  financials: {},      // id -> [{period, ...}]
  companyProfiles: {}, // id -> 结构化公司研究（AI 生成，带版本）
  chatGroups: [],
  chatMessages: [],
  research: {},        // id -> 用户研究记录（仅用户可改）
  researchVersions: [],
  aiAnalyses: [],      // AI 分析历史版本
  aiSuggestions: [],   // AI 对用户研究的建议（不会直接改写研究记录）
  alerts: [],
  agentSessions: [],
  briefs: [],
  jobRuns: [],
  settings: {},
};

let saveTimer = null;

export function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

export function load() {
  if (!fs.existsSync(DB_FILE)) return false;
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  Object.assign(db, raw);
  return true;
}

export function save() {
  if (process.env.NODE_ENV === 'test') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

export function flush() {
  if (process.env.NODE_ENV === 'test') return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  // K 线是可再生成的派生数据，不写入磁盘
  fs.writeFileSync(tmp, JSON.stringify({ ...db, daily: {}, intraday: {} }));
  fs.renameSync(tmp, DB_FILE);
}

export function reset() {
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
}

export function instrument(id) {
  return db.instruments.find((i) => i.id === id);
}
