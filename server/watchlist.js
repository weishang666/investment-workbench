// 自选管理 + TradingView 导出文件导入（支持重复导入、自动去重）。
import { db, uid, instrument } from './store.js';
import { normalizeSymbol, classify, inferType, currencyFor, parseExpression, MARKET_BY_EXCHANGE, MARKET_LABEL } from './lib/instruments.js';
import { readXlsx } from './lib/xlsx.js';
import { seedInstrument } from './providers/market.js';

export function watchedSymbols(kind) {
  const s = new Set();
  for (const g of db.watchlist.groups) if (!kind || g.kind === kind) for (const it of g.items) s.add(it.symbol);
  return [...s];
}

export function groupsView() {
  return db.watchlist.groups.map((g) => ({
    ...g,
    items: [...g.items].sort((a, b) => (b.pinned - a.pinned) || a.order - b.order),
  }));
}

export function createGroup(name, kind = 'stock', category = null) {
  const g = { id: uid('g_'), name, kind, category: category || (kind === 'macro' ? '宏观' : '自选'), items: [] };
  db.watchlist.groups.push(g);
  return g;
}

export function deleteGroup(groupId) {
  db.watchlist.groups = db.watchlist.groups.filter((g) => g.id !== groupId);
}

export function addToGroup(groupId, rawSymbol, meta = {}) {
  const g = db.watchlist.groups.find((x) => x.id === groupId);
  if (!g) throw httpError(404, '分组不存在');
  const id = normalizeSymbol(rawSymbol, db.instruments);
  if (!id) throw httpError(400, `无法识别的代码：${rawSymbol}`);
  ensureInstrument(id, meta);
  if (g.items.some((i) => i.symbol === id)) return { added: false, symbol: id, reason: 'duplicate' };
  g.items.push({ symbol: id, pinned: false, order: g.items.length, addedAt: new Date().toISOString(), ...(meta.origin ? { origin: meta.origin } : {}) });
  return { added: true, symbol: id };
}

export function removeFromGroup(groupId, symbol) {
  const g = db.watchlist.groups.find((x) => x.id === groupId);
  if (!g) throw httpError(404, '分组不存在');
  g.items = g.items.filter((i) => i.symbol !== symbol);
  g.items.forEach((it, i) => { it.order = i; });
}

export function pin(groupId, symbol, pinned = true) {
  const it = findItem(groupId, symbol);
  it.pinned = pinned;
}

/** 将 symbol 移到 toIndex（拖拽 / 上移下移排序） */
export function reorder(groupId, symbol, toIndex) {
  const g = db.watchlist.groups.find((x) => x.id === groupId);
  if (!g) throw httpError(404, '分组不存在');
  const items = [...g.items].sort((a, b) => a.order - b.order);
  const from = items.findIndex((i) => i.symbol === symbol);
  if (from < 0) throw httpError(404, '标的不在分组中');
  const [it] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, it);
  items.forEach((x, i) => { x.order = i; });
  g.items = items;
}

function findItem(groupId, symbol) {
  const g = db.watchlist.groups.find((x) => x.id === groupId);
  const it = g?.items.find((i) => i.symbol === symbol);
  if (!it) throw httpError(404, '标的不在分组中');
  return it;
}

/** 平台不认识的新标的：建主数据 + 生成演示行情。meta 可带 name / intro / category / theme。 */
export function ensureInstrument(id, meta = {}) {
  const existing = instrument(id);
  if (existing) {
    if (meta.intro && !existing.intro) existing.intro = meta.intro;
    if (meta.name && !existing.userName && meta.name !== existing.name) existing.userName = meta.name;
    if (meta.theme) existing.themes = [...new Set([...(existing.themes || []), meta.theme])];
    return existing;
  }
  const expr = parseExpression(id);
  const [ex, code] = expr ? ['', id] : id.split(':');
  const type = inferType(id);
  const name = meta.name || code;
  const aliases = [code.toLowerCase()];
  if (meta.name) aliases.push(...meta.name.toLowerCase().split(/[\s/（）()]+/).filter((x) => x.length >= 2 && !/^(etf|cfd|the|inc)$/.test(x)));
  const inst = {
    id, name, enName: code, type, market: expr ? 'GLOBAL' : (MARKET_BY_EXCHANGE[ex] || 'GLOBAL'), currency: expr ? '' : currencyFor(id),
    aliases: [...new Set(aliases)], imported: true,
    ...(meta.intro ? { intro: meta.intro } : {}), ...(meta.theme ? { themes: [meta.theme] } : {}),
  };
  if (type === 'future') inst.contract = { kind: /1!$/.test(code) ? 'continuous' : 'specific', current: '未知', main: /1!$/.test(code) ? '主力连续' : code, rollRule: '未配置（接入真实期货数据源后补充）' };
  if (expr) inst.legs = [expr.left, expr.right], inst.op = expr.op;
  db.instruments.push(inst);
  seedInstrument(id);
  if (!expr && !db.quotes[id].source.includes('经济')) db.quotes[id].source = 'Mock 行情（导入标的，合成数据）';
  return inst;
}

export function searchInstruments(q, limit = 12) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  return db.instruments
    .map((i) => {
      const keys = [i.id.toLowerCase(), i.id.split(':')[1].toLowerCase(), i.name.toLowerCase(), (i.enName || '').toLowerCase(), ...(i.aliases || [])];
      const score = keys.some((k) => k === s) ? 3 : keys.some((k) => k.startsWith(s)) ? 2 : keys.some((k) => k.includes(s)) ? 1 : 0;
      return { i, score };
    })
    .filter((x) => x.score).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.i);
}

/**
 * 解析 TradingView 自选列表导出文件。
 * TradingView 导出为 .txt，内容形如：
 *   ###宏观,TVC:GOLD,TVC:DXY,###科技股,NASDAQ:NVDA,NASDAQ:AAPL
 * 也兼容逐行一个代码、CSV（首列为代码）等常见格式。
 */
export function parseTradingView(text) {
  const tokens = String(text).replace(/^﻿/, '').split(/[,\n\r\t]+/).map((t) => t.trim()).filter(Boolean);
  const sections = [];
  let current = { name: null, symbols: [] };
  for (const t of tokens) {
    if (t.startsWith('###')) {
      if (current.symbols.length || current.name) sections.push(current);
      current = { name: t.replace(/^#+/, '').trim() || null, symbols: [] };
    } else if (/^symbol$/i.test(t) || /^ticker$/i.test(t)) {
      continue; // CSV 表头
    } else {
      current.symbols.push(t);
    }
  }
  if (current.symbols.length || current.name) sections.push(current);
  return sections;
}

/**
 * 导入：自动分类到宏观观察列表 / 股票自选；TradingView 分区名映射为同名分组（可选）。
 * opts.mode: 'auto'（按分区建分组，宏观资产归入宏观观察）| 'single'（全部导入 opts.groupId）
 */
export function importTradingView(text, opts = {}) {
  const mode = opts.mode || 'auto';
  const sections = parseTradingView(text);
  const report = { totalTokens: 0, added: [], duplicates: [], invalid: [], newInstruments: [], groupsCreated: [] };
  const macroGroup = db.watchlist.groups.find((g) => g.kind === 'macro') || createGroup('宏观观察', 'macro');
  const seenInFile = new Set();

  for (const sec of sections) {
    for (const raw of sec.symbols) {
      report.totalTokens++;
      const id = normalizeSymbol(raw, db.instruments);
      if (!id) { report.invalid.push(raw); continue; }
      const kind = classify(id, db.instruments);
      let group;
      if (mode === 'single') {
        group = db.watchlist.groups.find((g) => g.id === opts.groupId);
        if (!group) throw httpError(404, '目标分组不存在');
      } else if (kind === 'macro') {
        group = macroGroup;
      } else {
        const name = sec.name || 'TradingView 导入';
        group = db.watchlist.groups.find((g) => g.name === name && g.kind === 'stock');
        if (!group) { group = createGroup(name, 'stock'); report.groupsCreated.push(name); }
      }
      const fileKey = `${group.id}|${id}`;
      if (seenInFile.has(fileKey)) { report.duplicates.push({ raw, symbol: id, group: group.name, reason: '文件内重复' }); continue; }
      seenInFile.add(fileKey);
      const isNew = !instrument(id);
      const r = addToGroup(group.id, id);
      if (isNew) report.newInstruments.push(id);
      if (r.added) report.added.push({ raw, symbol: id, group: group.name, kind });
      else report.duplicates.push({ raw, symbol: id, group: group.name, reason: '已在分组中' });
    }
  }
  return report;
}

// ---------------- 表格导入（xlsx / csv）----------------
const HEADER = {
  code: [/^完整代码$/, /^代码$/, /^symbol$/i, /^ticker$/i, /代码/, /symbol|ticker|code/i],
  name: [/^名称$/, /^name$/i, /名称|简称/],
  l1: [/^一级$/, /^一级分类$/, /^大类$/, /^市场$/, /^category$/i],
  l2: [/^二级$/, /^二级分类$/, /^分组$/, /^板块$/, /^主题$/, /^group$/i, /^theme$/i],
  intro: [/^简介$/, /简介|描述|备注|description|note/i],
  origin: [/原所在|来源列表|origin/i],
};

function mapHeader(row) {
  const cells = row.map((c) => String(c ?? '').trim());
  const idx = {};
  for (const [k, pats] of Object.entries(HEADER)) {
    for (const re of pats) {
      const i = cells.findIndex((c, j) => c && re.test(c) && !Object.values(idx).includes(j) && !(k !== 'origin' && /原所在/.test(c)));
      if (i >= 0) { idx[k] = i; break; }
    }
  }
  return idx.code != null ? idx : null;
}

/** 把表格（二维数组）解析为 [{ code, name, l1, l2, intro, origin }] */
export function rowsFromTable(rows) {
  const headerAt = rows.slice(0, 10).findIndex((r) => r && mapHeader(r));
  if (headerAt < 0) return [];
  const idx = mapHeader(rows[headerAt]);
  const get = (r, k) => (idx[k] != null && r[idx[k]] != null ? String(r[idx[k]]).trim() : '');
  return rows.slice(headerAt + 1).filter((r) => r && get(r, 'code')).map((r) => ({ code: get(r, 'code'), name: get(r, 'name'), l1: get(r, 'l1'), l2: get(r, 'l2'), intro: get(r, 'intro'), origin: get(r, 'origin') }));
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** 从上传的文件解析出标的行。支持 .xlsx（多工作表合并）、.csv、TradingView .txt */
export function parseWatchlistFile(filename, buf) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'xlsx') {
    const sheets = readXlsx(buf);
    // 优先用"明细"类工作表；否则合并所有带代码列的工作表（重复行在导入时去重）
    const detail = sheets.find((s) => /明细|全部|all/i.test(s.name) && rowsFromTable(s.rows).length);
    const rows = detail ? rowsFromTable(detail.rows) : sheets.flatMap((s) => rowsFromTable(s.rows));
    return { format: 'table', rows, sheets: sheets.map((s) => s.name), usedSheet: detail?.name || '全部工作表' };
  }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (ext === 'csv') {
    const rows = rowsFromTable(parseCsv(text));
    if (rows.length) return { format: 'table', rows };
  }
  return { format: 'tradingview', text };
}

const MACRO_L1 = /宏观|指标|商品|利率|汇率|macro/i;

/**
 * 表格导入：一级分类 → 分组的 category，二级分类 → 分组名。
 * mode: 'merge'（合并，默认）| 'replace'（用文件替换全部分组）
 */
export function importTable(rows, { mode = 'merge' } = {}) {
  const report = { totalTokens: rows.length, added: [], duplicates: [], invalid: [], newInstruments: [], groupsCreated: [], replaced: mode === 'replace' };
  if (mode === 'replace') db.watchlist.groups = [];
  const seen = new Set();
  for (const r of rows) {
    const id = normalizeSymbol(r.code, db.instruments);
    if (!id) { report.invalid.push(r.code); continue; }
    const kind = r.l1 ? (MACRO_L1.test(r.l1) ? 'macro' : 'stock') : classify(id, db.instruments);
    const category = r.l1 || (kind === 'macro' ? '宏观' : MARKET_LABEL[MARKET_BY_EXCHANGE[id.split(':')[0]]] || '自选');
    const name = r.l2 || r.l1 || (kind === 'macro' ? '宏观观察' : '导入');
    let g = db.watchlist.groups.find((x) => x.name === name && x.category === category && x.kind === kind);
    if (!g) { g = createGroup(name, kind, category); report.groupsCreated.push(`${category}/${name}`); }
    const key = `${g.id}|${id}`;
    if (seen.has(key)) { report.duplicates.push({ raw: r.code, symbol: id, group: `${category}/${name}`, reason: '文件内重复' }); continue; }
    seen.add(key);
    const isNew = !instrument(id);
    const res = addToGroup(g.id, id, { name: r.name, intro: r.intro, theme: r.l2, origin: r.origin });
    if (isNew) report.newInstruments.push(id);
    if (res.added) report.added.push({ raw: r.code, symbol: id, group: `${category}/${name}`, kind });
    else report.duplicates.push({ raw: r.code, symbol: id, group: `${category}/${name}`, reason: '已在分组中' });
  }
  return report;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
