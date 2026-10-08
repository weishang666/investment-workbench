// HTTP 服务：REST API + SSE 实时推送 + 静态前端。零依赖（Node 20+）。
import { loadEnv } from './lib/env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, load, save, flush, reset, instrument, uid } from './store.js';
import { seed } from './seed.js';
import { on } from './lib/bus.js';
import { bars, marketSource } from './providers/market.js';
import * as GM from './providers/gangtiseMarket.js';
import { usageToday } from './providers/gangtise.js';
import * as WL from './watchlist.js';
import * as RS from './research.js';
import { listAlerts, setStatus, counts } from './alerts.js';
import { hotSymbols, symbolStats, searchChats, groupDigest, ingestMessages, tagMessages, chatView, visibleMessages } from './rules/chatHeat.js';
import { searchNews } from './news.js';
import { ask, listSessions, getSession, llmEnabled, engine } from './agent/agent.js';
import { toolManifest, runTool } from './agent/tools.js';
import { startJobs, runScheduled, SCHEDULE, runNewsJob, acceptResult } from './agent/jobs.js';
import * as OpenClaw from './agent/openclaw.js';
import { startDiscordPolling, parseJsonl } from './connectors/discordLocal.js';
import { SESSION_LABEL } from './lib/sessions.js';
import { COMPANY_KB } from './agent/companyKb.js';
import { companyResearch } from './agent/analysis.js';

loadEnv(); // 读取根目录 .env（Gangtise 密钥等），已存在的环境变量优先
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 3000);

if (process.argv.includes('--reset') || process.argv.includes('--reset-only')) reset();
if (!load()) { seed(); flush(); console.log('[store] 已生成演示数据 data/db.json'); }
if (process.argv.includes('--reset-only')) process.exit(0);

// ---------- 路由 ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

const quoteView = (id) => {
  const inst = instrument(id); const q = db.quotes[id];
  return inst && q ? { ...inst, quote: { ...q, sessionLabel: SESSION_LABEL[q.session] } } : null;
};

route('GET', '/api/meta', () => {
  const gts = GM.enabled();
  return {
    llm: llmEnabled() || OpenClaw.chatEnabled(), model: engine(), openclaw: { chat: OpenClaw.chatEnabled(), hooks: OpenClaw.hooksEnabled() },
    marketSource: marketSource(gts), gangtise: gts ? { ...GM.pollState(), usage: usageToday() } : null,
    discord: !!process.env.DISCORD_MESSAGES_DIR, mockSession: process.env.MOCK_SESSION || 'regular',
    mocked: (gts ? ['美股 ETF / 宏观商品 / 外汇 / 加密行情', '新闻', '宏观经济日历'] : ['行情', '新闻', '公告', '财务数据', '经济日历']).concat(process.env.DISCORD_MESSAGES_DIR ? [] : ['群聊']),
    real: gts ? ['股票 / 指数行情（Gangtise）', '日 K', '财报', '公告', '业绩日历'] : [],
  };
});
route('GET', '/api/gangtise/status', () => ({ enabled: GM.enabled(), ...GM.pollState(), usage: usageToday() }));

// 按需拉取 Gangtise 数据：超时就先返回已有数据（Mock 或上次缓存），后台继续拉
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);

// 大屏
route('GET', '/api/dashboard', (_, q) => {
  const groups = WL.groupsView();
  const macroItems = groups.filter((g) => g.kind === 'macro').flatMap((g) => g.items);
  const pinned = [...new Set(macroItems.filter((i) => i.pinned).map((i) => i.symbol))];
  const strip = (pinned.length ? pinned : [...new Set(macroItems.map((i) => i.symbol))].slice(0, 12)).map(quoteView).filter(Boolean);
  const stockGroups = groups.filter((g) => g.kind === 'stock');
  const sel = stockGroups.find((g) => g.id === q.get('group')) || stockGroups[0];
  tagMessages();
  return {
    macro: strip, macroCount: new Set(macroItems.map((i) => i.symbol)).size,
    news: db.events.slice(0, 12),
    // 宏观日历全部展示；自选股财报日只展示未来 14 天内最近的 12 条
    calendar: [...db.calendar.filter((c) => c.kind !== 'earnings'),
      ...db.calendar.filter((c) => c.kind === 'earnings' && new Date(c.time) - Date.now() < 14 * 86400e3 && new Date(c.time) - Date.now() > -86400e3).sort((a, b) => a.time.localeCompare(b.time)).slice(0, 12)]
      .sort((a, b) => a.time.localeCompare(b.time)),
    groups: stockGroups.map(({ items, ...g }) => ({ ...g, count: items.length, moved: items.filter((i) => Math.abs(db.quotes[i.symbol]?.changePct || 0) >= db.settings.priceMove.threshold).length })),
    group: sel ? { ...sel, items: sel.items.map((i) => ({ ...i, ...quoteView(i.symbol), moved: Math.abs(db.quotes[i.symbol]?.changePct || 0) >= db.settings.priceMove.threshold })) } : null,
    chat: hotSymbols().slice(0, 8).map((s) => ({ ...s, name: instrument(s.symbol)?.name })),
    alerts: listAlerts({ status: 'open', limit: 30 }), alertCounts: counts(),
    briefs: db.briefs.slice(0, 3),
    updatedAt: new Date().toISOString(),
  };
});
route('GET', '/api/macro', () => WL.groupsView().filter((g) => g.kind === 'macro').map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, ...quoteView(i.symbol) })) })));

// 行情
route('GET', '/api/quote/:id', ({ id }) => quoteView(id) || notFound());
route('GET', '/api/bars/:id', async ({ id }, q) => {
  await within(GM.ensureDaily(id), 8000);
  return { id, period: q.get('period') || '1M', ...bars(id, q.get('period') || '1M'), real: !!db.daily[id]?.real };
});
route('GET', '/api/instruments/search', (_, q) => WL.searchInstruments(q.get('q')).map((i) => quoteView(i.id)));

// 自选
route('GET', '/api/watchlist', () => WL.groupsView());
route('POST', '/api/watchlist/groups', (_, __, b) => { const g = WL.createGroup(b.name, b.kind, b.category); save(); return g; });
route('DELETE', '/api/watchlist/groups/:gid', ({ gid }) => { WL.deleteGroup(gid); save(); return { ok: true }; });
route('POST', '/api/watchlist/groups/:gid/items', ({ gid }, _, b) => { const r = WL.addToGroup(gid, b.symbol); save(); return r; });
route('DELETE', '/api/watchlist/groups/:gid/items/:sym', ({ gid, sym }) => { WL.removeFromGroup(gid, sym); save(); return { ok: true }; });
route('POST', '/api/watchlist/groups/:gid/items/:sym/pin', ({ gid, sym }, _, b) => { WL.pin(gid, sym, b.pinned !== false); save(); return { ok: true }; });
route('POST', '/api/watchlist/groups/:gid/items/:sym/move', ({ gid, sym }, _, b) => { WL.reorder(gid, sym, Number(b.toIndex)); save(); return { ok: true }; });
route('POST', '/api/import/tradingview', (_, __, b) => { const r = WL.importTradingView(b.text, b); runNewsJob(); save(); return r; });
// 通用文件导入：.xlsx / .csv（按"一级 / 二级 / 名称 / 代码 / 简介"列识别）或 TradingView .txt
route('POST', '/api/import/watchlist-file', (_, __, b) => {
  const buf = Buffer.from(b.base64 || '', 'base64');
  const parsed = WL.parseWatchlistFile(b.filename || 'file.txt', buf);
  const r = parsed.format === 'table' ? WL.importTable(parsed.rows, { mode: b.mode === 'replace' ? 'replace' : 'merge' }) : WL.importTradingView(parsed.text, b);
  runNewsJob(); save();
  return { ...r, format: parsed.format, usedSheet: parsed.usedSheet };
});

// 标的详情（研究档案）
route('GET', '/api/stock/:id', async ({ id }) => {
  const v = quoteView(id); if (!v) return notFound();
  await within(Promise.all([GM.ensureFinancials(id), GM.ensureFilings(id)]), 10000);
  tagMessages();
  return {
    ...v,
    financials: RS.financialMetrics(id), earnings: RS.earningsChanges(id),
    filings: db.filings.filter((f) => f.symbol === id).sort((a, b) => b.filedAt.localeCompare(a.filedAt)),
    news: searchNews({ symbol: id, limit: 10 }),
    chat: { stats: symbolStats(id, visibleMessages(), db.settings.chatHeat), daily: symbolStats(id, visibleMessages(), { ...db.settings.chatHeat, windowMinutes: 24 * 60 }), messages: searchChats({ symbol: id, limit: 30 }) },
    research: RS.getResearch(id), versions: RS.versions(id),
    analyses: RS.analyses(id), suggestions: db.aiSuggestions.filter((s) => s.symbol === id),
    hasCompanyKb: !!COMPANY_KB[id],
    origins: [...new Set(db.watchlist.groups.flatMap((g) => g.items.filter((i) => i.symbol === id && i.origin).map((i) => i.origin)))],
    memberOf: db.watchlist.groups.filter((g) => g.items.some((i) => i.symbol === id)).map((g) => `${g.category}/${g.name}`),
    alerts: listAlerts({ symbol: id, status: 'all', limit: 20 }),
  };
});
route('GET', '/api/stock/:id/company', async ({ id }) => companyResearch(id));
route('PUT', '/api/research/:id', ({ id }, _, b) => RS.saveResearch(id, b.patch || b, { reason: b.reason || '用户更新' }));
route('GET', '/api/research/:id/diff', ({ id }, q) => {
  const vs = RS.versions(id); const a = vs.find((v) => v.id === q.get('from')); const bb = vs.find((v) => v.id === q.get('to'));
  if (!a || !bb) return notFound();
  return { from: a, to: bb, changes: RS.diffVersions(a, bb) };
});
route('POST', '/api/suggestions/:sid', ({ sid }, _, b) => RS.resolveSuggestion(sid, b.status));

// 新闻 / 日历
route('GET', '/api/news', (_, q) => searchNews({ query: q.get('q') || undefined, symbol: q.get('symbol') || undefined, limit: Number(q.get('limit') || 30) }));
route('GET', '/api/briefs', () => db.briefs);

// 群聊
route('GET', '/api/chat/hot', (_, q) => hotSymbols(new Date(), { ...db.settings.chatHeat, windowMinutes: Number(q.get('minutes') || db.settings.chatHeat.windowMinutes) }));
route('GET', '/api/chat/messages', (_, q) => searchChats({ query: q.get('q') || undefined, symbol: q.get('symbol') || undefined, groupId: q.get('group') || undefined, limit: Number(q.get('limit') || 50) }));
route('GET', '/api/chat/digest', (_, q) => groupDigest({ groupId: q.get('group') || undefined, minutes: Number(q.get('minutes') || 60) }));
route('GET', '/api/chat/groups', () => db.chatGroups);
// 群聊视图：来源合并 + 屏蔽频道/发言人
route('GET', '/api/chat/view', () => {
  const v = chatView();
  const stat = new Map();
  const users = new Map();
  for (const m of db.chatMessages) {
    if (!stat.has(m.groupId)) stat.set(m.groupId, { messages: 0, last: '', users: new Map() });
    const g = stat.get(m.groupId);
    g.messages++; if (m.time > g.last) g.last = m.time;
    g.users.set(m.user, (g.users.get(m.user) || 0) + 1);
    users.set(m.user, (users.get(m.user) || 0) + 1);
  }
  const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([user, count]) => ({ user, count }));
  return {
    ...v,
    channels: db.chatGroups.map((g) => {
      const s = stat.get(g.id);
      return { ...g, messages: s?.messages || 0, lastTime: s?.last || null, topUsers: s ? top(s.users, 3) : [],
        sourceId: v.sources.find((x) => x.groupIds.includes(g.id))?.id || null, hidden: v.hiddenGroups.includes(g.id) };
    }),
    users: top(users, 300).map((u) => ({ ...u, hidden: v.hiddenUsers.includes(u.user) })),
  };
});
route('PUT', '/api/chat/view', (_, __, b) => {
  const v = chatView();
  const ids = new Set(db.chatGroups.map((g) => g.id));
  const strs = (a) => [...new Set((Array.isArray(a) ? a : []).map(String).filter(Boolean))];
  if (b.sources) {
    const taken = new Set();
    v.sources = b.sources.filter((s) => s && String(s.name || '').trim()).map((s) => ({
      id: String(s.id || uid('s')), name: String(s.name).trim().slice(0, 40),
      // 一个频道只能属于一个来源
      groupIds: strs(s.groupIds).filter((g) => ids.has(g) && !taken.has(g) && taken.add(g)),
    }));
  }
  if (b.hiddenGroups) v.hiddenGroups = strs(b.hiddenGroups);
  if (b.hiddenUsers) v.hiddenUsers = strs(b.hiddenUsers);
  save();
  return v;
});
route('POST', '/api/chat/import', (_, __, b) => {
  // 方式三：导入聊天记录。支持 discord-local 的 jsonl，或标准 JSON 数组
  const list = b.format === 'discord-jsonl' ? parseJsonl(b.text, b.folder || '', b.tz) : JSON.parse(b.text);
  const added = ingestMessages(list, b.format || 'import');
  save();
  return { added: added.length, total: list.length };
});

// 提醒
route('GET', '/api/alerts', (_, q) => ({ items: listAlerts({ status: q.get('status') || 'open', type: q.get('type') || undefined, symbol: q.get('symbol') || undefined, limit: 200 }), counts: counts() }));
route('POST', '/api/alerts/:aid/status', ({ aid }, _, b) => setStatus(aid, b.status));

// Agent
route('POST', '/api/agent/ask', (_, __, b) => ask(String(b.question || ''), b.context || {}, b.sessionId));
route('GET', '/api/agent/sessions', () => listSessions());
route('GET', '/api/agent/sessions/:sid', ({ sid }) => getSession(sid) || notFound());
route('GET', '/api/agent/tools', () => toolManifest());
route('POST', '/api/agent/tools/:name', async ({ name }, _, b) => {
  const r = await runTool(name, b);
  OpenClaw.rememberEvidence(r?.evidence); // 外部 OpenClaw 回答里引用 [证据: id] 时可还原来源
  return r;
});
route('POST', '/api/agent/results', (_, __, b) => acceptResult(b)); // OpenClaw 写回分析结果
route('GET', '/api/openclaw/status', () => OpenClaw.status());
route('GET', '/api/analyses/:aid', ({ aid }) => db.aiAnalyses.find((a) => a.id === aid) || notFound());

// 任务 / 设置
route('GET', '/api/jobs', () => ({ schedule: SCHEDULE, runs: db.jobRuns.slice(0, 50) }));
route('POST', '/api/jobs/:name/run', ({ name }) => runScheduled(name));
route('GET', '/api/settings', () => db.settings);
route('PUT', '/api/settings', (_, __, b) => { for (const k of Object.keys(b)) db.settings[k] = { ...db.settings[k], ...b[k] }; save(); return db.settings; });

function notFound() { throw Object.assign(new Error('未找到'), { status: 404 }); }

// ---------- SSE ----------
const clients = new Set();
on('*', (event, payload) => {
  if (!['quotes', 'alert', 'alert-updated', 'brief'].includes(event)) return;
  const data = event === 'quotes' ? payload.map((q) => ({ id: q.id, last: q.last, change: q.change, changePct: q.changePct, volume: q.volume, updatedAt: q.updatedAt, session: q.session })) : payload;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 20e6) throw Object.assign(new Error('请求体过大'), { status: 413 }); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      try {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const out = await r.handler(params, url.searchParams, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out ?? null));
      } catch (e) {
        if (!e.status) console.error(e);
        res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  let file = path.normalize(path.join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (!process.argv.includes('--no-listen')) {
  startJobs();
  startDiscordPolling();
  server.listen(PORT, () => {
    console.log(`个人投研工作台已启动：http://localhost:${PORT}`);
    const e = engine();
    console.log(`AI 对话：${e === 'openclaw' ? `本机 OpenClaw（${OpenClaw.OC.url()}，agent=${OpenClaw.OC.agent()}）` : e === 'local-rules' ? '本地规则（设置 OPENCLAW_TOKEN 接入本机 OpenClaw）' : `Claude（${e}）`}`);
    console.log(`异动分析与日报：${OpenClaw.hooksEnabled() ? '派发给本机 OpenClaw，超时回退本地规则' : '本地规则（设置 OPENCLAW_HOOKS_TOKEN 交给 OpenClaw）'}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
}
