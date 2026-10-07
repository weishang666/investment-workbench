// OpenClaw Agent 工具层。OpenClaw 负责理解与编排，这里的工具负责确定性执行。
// 每个工具返回 { data, evidence }，evidence 用于构建"结论 → 原因 → 证据"链路。
// 同一套定义既供内置 Agent 使用，也通过 HTTP 暴露给外部 OpenClaw：
//   GET  /api/agent/tools          → 工具清单（JSON Schema）
//   POST /api/agent/tools/:name    → 执行工具
import { db, instrument } from '../store.js';
import { bars } from '../providers/market.js';
import { searchNews } from '../news.js';
import { watchedSymbols, groupsView, searchInstruments } from '../watchlist.js';
import { getResearch, versions, financialMetrics, earningsChanges, addSuggestion, analyses } from '../research.js';
import { searchChats, symbolStats, hotSymbols, groupDigest, tagMessages } from '../rules/chatHeat.js';
import { listAlerts } from '../alerts.js';
import { findMentions } from '../lib/instruments.js';

const ev = {
  quote: (q, inst) => ({ id: `q:${q.id}`, type: 'data', label: `${inst?.name || q.id} 最新价 ${q.last}，涨跌幅 ${q.changePct > 0 ? '+' : ''}${q.changePct}%（昨收 ${q.prevClose}）`, source: `${q.source}${q.delayMinutes ? `，延迟 ${q.delayMinutes} 分钟` : '，实时'}`, time: q.updatedAt }),
  event: (e) => ({ id: `n:${e.id}`, type: e.hasOfficial ? 'filing' : 'news', label: e.title, source: e.sources.map((s) => s.source).join('、'), time: e.firstSeen, url: e.sources[0]?.url }),
  filing: (f) => ({ id: `f:${f.id}`, type: 'filing', label: `${f.type}：${f.title}`, source: f.source, time: f.filedAt, url: f.url }),
  chat: (st) => ({ id: `c:${st.symbol}:${st.start}`, type: 'chat', label: `最近 ${st.windowMinutes} 分钟 ${st.effectiveGroupCount} 个群有效讨论，${st.userCount} 人，${st.messageCount} 条消息`, source: '群聊（未经证实来源）', time: st.end }),
  note: (symbol, text, time) => ({ id: `r:${symbol}:${time}`, type: 'note', label: text, source: '你的研究记录', time }),
  cal: (c) => ({ id: `cal:${c.id}`, type: 'data', label: `${c.country} ${c.event}：公布 ${c.actual ?? '—'}${c.unit}，预期 ${c.forecast}${c.unit}，前值 ${c.previous}${c.unit}`, source: '经济日历（演示数据）', time: c.time }),
};

function resolveSymbol(s) {
  if (!s) return null;
  if (instrument(s)) return s;
  const m = findMentions(s, db.instruments);
  if (m.length) return m[0];
  const hit = searchInstruments(s, 1)[0];
  return hit?.id || null;
}

const symbolProp = { type: 'string', description: '标的代码，如 NASDAQ:NVDA，也可以是 NVDA / 英伟达 等别名' };

export const TOOLS = {
  market_data: {
    description: '查询标的的实时/延迟行情与历史 K 线。返回最新价、涨跌幅、成交量、交易时段、数据来源与延迟。',
    input_schema: { type: 'object', properties: { symbol: symbolProp, period: { type: 'string', enum: ['intraday', '1D', '1W', '1M', '3M', '1Y'], description: '可选，返回该周期的 K 线摘要' } }, required: ['symbol'] },
    run({ symbol, period }) {
      const id = resolveSymbol(symbol);
      const q = db.quotes[id];
      if (!q) return { data: { error: `未找到标的 ${symbol}` }, evidence: [] };
      const inst = instrument(id);
      const data = { instrument: inst, quote: q };
      if (period) {
        const b = bars(id, period).points;
        const first = b[0]; const last = b[b.length - 1];
        data.period = { period, points: b.length, start: first?.t, end: last?.t, change: first && last ? +(((last.c - (first.o ?? first.c)) / (first.o ?? first.c)) * 100).toFixed(2) : null, high: Math.max(...b.map((x) => x.h ?? x.c)), low: Math.min(...b.map((x) => x.l ?? x.c)) };
      }
      return { data, evidence: [ev.quote(q, inst)] };
    },
  },
  macro_data: {
    description: '查询宏观观察列表（黄金、原油、美元、美债、主要指数、汇率等）的最新行情。期货会标明当前/主力/连续合约。',
    input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: '可选，不传则返回整个宏观观察列表' } } },
    run({ symbols } = {}) {
      const ids = symbols?.length ? symbols.map(resolveSymbol).filter(Boolean) : watchedSymbols('macro');
      const rows = ids.map((id) => ({ ...instrument(id), quote: db.quotes[id] })).filter((r) => r.quote);
      return { data: rows.map((r) => ({ id: r.id, name: r.name, type: r.type, contract: r.contract, last: r.quote.last, changePct: r.quote.changePct, session: r.quote.session, source: r.quote.source, delayMinutes: r.quote.delayMinutes, updatedAt: r.quote.updatedAt })), evidence: rows.filter((r) => Math.abs(r.quote.changePct) >= 1).map((r) => ev.quote(r.quote, r)) };
    },
  },
  economic_calendar: {
    description: '查询经济日历：CPI、PPI、非农、GDP、PMI、利率决议等。可筛选已公布 / 即将公布。',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['released', 'upcoming', 'all'] }, hours: { type: 'number', description: '时间范围（小时），默认 48' } } },
    run({ status = 'all', hours = 48 } = {}) {
      const now = Date.now();
      const rows = db.calendar.filter((c) => Math.abs(new Date(c.time) - now) <= hours * 3600e3 || (status === 'upcoming' && new Date(c.time) > now))
        .filter((c) => status === 'all' || (status === 'released' ? c.actual != null : c.actual == null))
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((c) => ({ ...c, surprise: c.actual != null ? +(c.actual - c.forecast).toFixed(2) : null }));
      return { data: rows, evidence: rows.filter((c) => c.actual != null).map(ev.cal) };
    },
  },
  news_search: {
    description: '检索已经过去重、事件聚合、标的关联的投资事件。每个事件包含事实摘要、AI 推断与信息来源。',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, symbol: symbolProp, hours: { type: 'number', description: '最近多少小时，默认 48' }, limit: { type: 'number' } } },
    run({ query, symbol, hours = 48, limit = 8 } = {}) {
      const since = new Date(Date.now() - hours * 3600e3).toISOString();
      const id = symbol ? resolveSymbol(symbol) : null;
      const rows = searchNews({ query, symbol: id, since, limit });
      return { data: rows.map((e) => ({ id: e.id, title: e.title, importance: e.importance, entities: e.entities, hasOfficial: e.hasOfficial, sourceCount: e.sourceCount, firstSeen: e.firstSeen, summary: e.summary })), evidence: rows.map(ev.event) };
    },
  },
  filing_search: {
    description: '查询公司公告 / 监管文件（SEC 8-K、10-Q、10-K、交易所公告等）。官方来源优先级高于媒体报道。',
    input_schema: { type: 'object', properties: { symbol: symbolProp, days: { type: 'number', description: '最近多少天，默认 90' } }, required: ['symbol'] },
    run({ symbol, days = 90 }) {
      const id = resolveSymbol(symbol);
      const since = new Date(Date.now() - days * 86400e3).toISOString();
      const rows = db.filings.filter((f) => f.symbol === id && f.filedAt >= since).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
      return { data: rows, evidence: rows.map(ev.filing) };
    },
  },
  company_financials: {
    description: '查询公司财务指标（营收、毛利、营业利润、净利润、EPS、自由现金流、现金、负债、毛利率、净利率），含同比/环比与最新财报变化。',
    input_schema: { type: 'object', properties: { symbol: symbolProp }, required: ['symbol'] },
    run({ symbol }) {
      const id = resolveSymbol(symbol);
      const m = financialMetrics(id);
      if (!m) return { data: { error: '暂无该公司的财务数据' }, evidence: [] };
      const ch = earningsChanges(id);
      return { data: { ...m, latestChanges: ch }, evidence: [{ id: `fin:${id}:${ch.period}`, type: 'data', label: `${ch.period} 营收同比 ${ch.items[0].yoy}%，毛利率 ${ch.items[3].value}%（环比 ${ch.items[3].delta >= 0 ? '+' : ''}${ch.items[3].delta}pct）`, source: m.source, time: null }] };
    },
  },
  watchlist: {
    description: '查询用户的自选列表（股票与宏观资产分组）及每个标的的最新涨跌幅。只读。',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['stock', 'macro', 'all'] } } },
    run({ kind = 'all' } = {}) {
      const groups = groupsView().filter((g) => kind === 'all' || g.kind === kind);
      return { data: groups.map((g) => ({ name: g.name, kind: g.kind, items: g.items.map((i) => ({ symbol: i.symbol, name: instrument(i.symbol)?.name, changePct: db.quotes[i.symbol]?.changePct, pinned: i.pinned })) })), evidence: [] };
    },
  },
  research_notes: {
    description: '读取用户对某标的的个人研究记录：投资逻辑、核心假设（含最近检查时间）、待验证问题、复盘结论与历史版本。'
      + 'Agent 不能修改研究记录；如认为某项假设需要重新检查，使用 action=suggest 提交建议，由用户决定。',
    input_schema: { type: 'object', properties: { symbol: symbolProp, action: { type: 'string', enum: ['read', 'suggest'], description: '默认 read' }, suggestion: { type: 'string', description: 'action=suggest 时的建议内容' }, assumption_id: { type: 'string' } }, required: ['symbol'] },
    run({ symbol, action = 'read', suggestion, assumption_id }) {
      const id = resolveSymbol(symbol);
      if (action === 'suggest') {
        const s = addSuggestion({ symbol: id, text: suggestion, assumptionId: assumption_id });
        return { data: { ok: true, suggestion: s, note: '已作为 AI 建议提交，未修改用户研究记录' }, evidence: [] };
      }
      const r = getResearch(id);
      const vs = versions(id);
      const evidence = [];
      if (r.thesis) evidence.push(ev.note(id, `投资逻辑：${r.thesis}`, r.updatedAt || r.createdAt));
      for (const a of r.assumptions) evidence.push(ev.note(id, `核心假设：${a.text}（${a.status}，最近检查 ${a.lastCheckedAt.slice(0, 10)}）`, a.createdAt));
      return { data: { symbol: id, thesis: r.thesis, assumptions: r.assumptions, questions: r.questions, review: r.review, updatedAt: r.updatedAt, versionCount: vs.length, versions: vs.slice(0, 5).map((v) => ({ createdAt: v.createdAt, reason: v.reason })) }, evidence };
    },
  },
  trading_plan: {
    description: '读取用户为某标的设定的交易计划（关注价、买入区间、计划仓位、加减仓条件、止损、目标价、有效期）与当前价格的相对位置。只读，Agent 不得修改。',
    input_schema: { type: 'object', properties: { symbol: symbolProp }, required: ['symbol'] },
    run({ symbol }) {
      const id = resolveSymbol(symbol);
      const p = getResearch(id).plan;
      const q = db.quotes[id];
      const dist = (x) => (x && q ? +(((q.last - x) / x) * 100).toFixed(1) : null);
      return { data: { symbol: id, plan: p, last: q?.last, distance: { toStopLoss: dist(p.stopLoss), toTarget: dist(p.target), toWatch: dist(p.watchPrice) }, readonly: true }, evidence: [] };
    },
  },
  chat_search: {
    description: '搜索已接入系统的群聊消息（标准化结构：群、用户、时间、内容、来源平台）。群聊内容属于未经证实信息。',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, symbol: symbolProp, minutes: { type: 'number', description: '最近多少分钟，默认 240' }, limit: { type: 'number' } } },
    run({ query, symbol, minutes = 240, limit = 20 } = {}) {
      const since = new Date(Date.now() - minutes * 60000).toISOString();
      const rows = searchChats({ query, symbol: symbol ? resolveSymbol(symbol) : null, since, limit });
      return { data: rows.map((m) => ({ id: m.id, group: m.groupName, platform: m.platform, user: m.user, time: m.time, content: m.content, symbols: m.symbols })), evidence: [] };
    },
  },
  chat_stats: {
    description: '群聊统计：单个标的的跨群热度（群数、人数、消息数、热度变化、主题、看多/看空观点、重复传播内容），或窗口内热门标的排行。',
    input_schema: { type: 'object', properties: { symbol: symbolProp, minutes: { type: 'number', description: '窗口分钟数，默认 60' } } },
    run({ symbol, minutes } = {}) {
      tagMessages();
      const cfg = { ...db.settings.chatHeat, ...(minutes ? { windowMinutes: minutes } : {}) };
      if (symbol) {
        const st = symbolStats(resolveSymbol(symbol), db.chatMessages, cfg);
        return { data: st, evidence: st.messageCount ? [ev.chat(st)] : [] };
      }
      const hot = hotSymbols(new Date(), cfg).slice(0, 8);
      return { data: hot.map((s) => ({ symbol: s.symbol, name: instrument(s.symbol)?.name, groups: s.effectiveGroupCount, users: s.userCount, messages: s.messageCount, heatChangePct: s.heatChangePct, topics: s.topics.slice(0, 3), spreading: s.spreading.length > 0 })), evidence: hot.slice(0, 3).filter((s) => s.messageCount).map(ev.chat), digest: groupDigest({ minutes: cfg.windowMinutes }) };
    },
  },
  alerts: {
    description: '查询统一提醒中心的提醒（价格异动、成交量、关键价位、公司事件、新闻、群聊共振、研究提醒）。',
    input_schema: { type: 'object', properties: { symbol: symbolProp, status: { type: 'string', enum: ['open', 'unread', 'read', 'handled', 'ignored', 'all'] }, limit: { type: 'number' } } },
    run({ symbol, status = 'open', limit = 20 } = {}) {
      const rows = listAlerts({ symbol: symbol ? resolveSymbol(symbol) : undefined, status, limit });
      return { data: rows.map((a) => ({ id: a.id, category: a.category, symbol: a.symbol, title: a.title, status: a.status, createdAt: a.createdAt, analysis: a.analysis?.summary })), evidence: [] };
    },
  },
  report_generator: {
    description: '生成并保存一份结构化投资研究报告（行情、财务、财报变化、新闻、公告、群聊、用户研究、AI 研究框架），保存为 AI 分析历史版本。',
    input_schema: { type: 'object', properties: { symbol: symbolProp, focus: { type: 'string', description: '可选，报告侧重点' } }, required: ['symbol'] },
    async run({ symbol, focus }) {
      const { buildReport } = await import('./analysis.js');
      const r = buildReport(resolveSymbol(symbol), { focus, save: true });
      return { data: { id: r.saved?.id, title: r.title, blocks: r.blocks }, evidence: r.evidence };
    },
  },
};

export function toolManifest() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
}

export async function runTool(name, input = {}) {
  const t = TOOLS[name];
  if (!t) throw Object.assign(new Error(`未知工具：${name}`), { status: 404 });
  return await t.run(input || {});
}

export { resolveSymbol };
export { analyses };
