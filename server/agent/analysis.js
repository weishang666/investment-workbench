// 本地分析能力（无大模型时的 OpenClaw 降级实现，也是异动第二阶段的默认分析器）。
// 输出统一为 blocks：每块标明类型 fact（已确认事实）/ analysis（AI 分析）/ unverified（待验证）/ note（用户研究）
// 原则：没有证据就说"暂无明确原因"，不编造因果。
import { db, instrument } from '../store.js';
import { runTool } from './tools.js';
import { getResearch, earningsChanges, financialMetrics, addAnalysis, addSuggestion, versions } from '../research.js';
import { symbolStats, tagMessages, hotSymbols } from '../rules/chatHeat.js';
import { watchedSymbols } from '../watchlist.js';
import { COMPANY_KB } from './companyKb.js';

const H = (text) => ({ kind: 'h', text });
const F = (text, evidence = []) => ({ kind: 'fact', text, evidence });
const A = (text, evidence = []) => ({ kind: 'analysis', text, evidence });
const U = (text, evidence = []) => ({ kind: 'unverified', text, evidence });
const N = (text, evidence = []) => ({ kind: 'note', text, evidence });
const T = (text) => ({ kind: 'text', text });

const RELATED = {
  'OANDA:XAUUSD': [['TVC:DXY', -1, '美元指数'], ['TVC:US10Y', -1, '美债收益率'], ['COMEX:GC1!', 1, 'COMEX 黄金期货']],
  'COMEX:GC1!': [['TVC:DXY', -1, '美元指数'], ['TVC:US10Y', -1, '美债收益率']],
  'OANDA:XAGUSD': [['OANDA:XAUUSD', 1, '现货黄金'], ['TVC:DXY', -1, '美元指数']],
  'NYMEX:CL1!': [['ICEEUR:BRN1!', 1, 'Brent 原油'], ['TVC:DXY', -1, '美元指数']],
  'ICEEUR:BRN1!': [['NYMEX:CL1!', 1, 'WTI 原油']],
};
const INDEX_FOR = { US: 'NASDAQ:IXIC', CN: 'SSE:000001', HK: 'HSI:HSI' };

const fmtPct = (x) => `${x > 0 ? '+' : ''}${x.toFixed(2)}%`;
const code = (id) => id.split(':')[1];
const name = (id) => instrument(id)?.name || id;

class Ctx {
  constructor() { this.evidence = new Map(); this.toolCalls = []; }
  async tool(nameT, input) {
    const r = await runTool(nameT, input);
    this.toolCalls.push({ name: nameT, input, at: new Date().toISOString() });
    for (const e of r.evidence || []) this.evidence.set(e.id, e);
    return r;
  }
  addEv(e) { this.evidence.set(e.id, e); return e.id; }
  ev() { return [...this.evidence.values()]; }
}

// ------------------------------------------------------------------
// 1. 异动原因分析（第二阶段）：已确认事件 / 可能影响因素 / 暂无明确原因
// ------------------------------------------------------------------
export async function explainMove(symbol, ctx = new Ctx()) {
  const inst = instrument(symbol);
  const { data: md, evidence: qe } = await ctx.tool('market_data', { symbol });
  const q = md.quote;
  const dir = Math.sign(q.changePct) || 1;
  const verb = dir > 0 ? '上涨' : '下跌';
  const since = Date.now() - 24 * 3600e3;
  const confirmed = []; const possible = []; const unverified = []; const observations = [];

  // 公告（官方来源，最高优先级）
  if (inst?.type === 'stock') {
    const { data: filings } = await ctx.tool('filing_search', { symbol, days: 2 });
    for (const f of filings.filter((x) => new Date(x.filedAt) >= since)) confirmed.push({ text: `${f.source} ${f.type}：${f.title}`, evidence: [`f:${f.id}`] });
  }
  // 新闻事件
  const { data: news } = await ctx.tool('news_search', { symbol, hours: 24, limit: 6 });
  for (const e of news) {
    const line = `${e.title}（${e.sourceCount} 个来源${e.hasOfficial ? '，含官方' : ''}）`;
    if (e.hasOfficial || e.sourceCount >= 2) confirmed.push({ text: line, evidence: [`n:${e.id}`] });
    else possible.push({ text: `单一媒体报道：${line}`, evidence: [`n:${e.id}`] });
    for (const c of e.summary.changes.filter((x) => x.kind === 'unverified')) unverified.push({ text: c.text, evidence: [`n:${e.id}`] });
  }
  // 行业 / 相关资产同向变动
  const peers = inst?.type === 'stock'
    ? db.instruments.filter((i) => i.type === 'stock' && i.sector === inst.sector && i.id !== symbol).map((i) => [i.id, 1, i.name])
    : (RELATED[symbol] || []);
  for (const [pid, sign, label] of peers) {
    const pq = db.quotes[pid];
    if (!pq) continue;
    if (Math.sign(pq.changePct) * sign === dir && Math.abs(pq.changePct) >= (inst?.type === 'stock' ? 2 : 0.3)) {
      const id = ctx.addEv({ id: `q:${pid}`, type: 'data', label: `${label} ${fmtPct(pq.changePct)}`, source: pq.source, time: pq.updatedAt });
      possible.push({ text: inst?.type === 'stock' ? `同行业 ${label} 同向变动 ${fmtPct(pq.changePct)}，可能存在板块性因素` : `${label} ${fmtPct(pq.changePct)}，与${name(symbol)}通常呈${sign > 0 ? '同向' : '反向'}关系`, evidence: [id] });
    }
  }
  // 指数
  const idx = INDEX_FOR[inst?.market];
  if (inst?.type === 'stock' && idx && db.quotes[idx]) {
    const iq = db.quotes[idx];
    const id = ctx.addEv({ id: `q:${idx}`, type: 'data', label: `${name(idx)} ${fmtPct(iq.changePct)}`, source: iq.source, time: iq.updatedAt });
    if (Math.abs(q.changePct) - Math.abs(iq.changePct) > 3) observations.push({ text: `${name(idx)} 仅 ${fmtPct(iq.changePct)}，个股涨跌幅明显大于大盘，更可能是公司或行业层面的因素`, evidence: [id] });
    else if (Math.sign(iq.changePct) === dir && Math.abs(iq.changePct) >= 1) possible.push({ text: `大盘同向变动 ${fmtPct(iq.changePct)}，可能受整体市场情绪影响`, evidence: [id] });
  }
  // 宏观事件
  const { data: cal } = await ctx.tool('economic_calendar', { status: 'released', hours: 24 });
  for (const c of cal.filter((x) => x.importance >= 3 && Math.abs(x.surprise) > 0)) {
    possible.push({ text: `${c.country}${c.event} 公布 ${c.actual}${c.unit}，${c.surprise > 0 ? '高于' : '低于'}预期 ${c.forecast}${c.unit}，宏观数据可能影响市场定价`, evidence: [`cal:${c.id}`] });
  }
  // 群聊（只代表关注度，且属于未经证实信息）
  tagMessages();
  const st = symbolStats(symbol, db.chatMessages, db.settings.chatHeat);
  if (st.messageCount) {
    const cid = ctx.addEv({ id: `c:${symbol}:${st.start}`, type: 'chat', label: `最近 ${st.windowMinutes} 分钟 ${st.effectiveGroupCount} 个群有效讨论，${st.messageCount} 条消息`, source: '群聊（未经证实）', time: st.end });
    for (const m of st.unverified) unverified.push({ text: `群聊传闻（${m.groupName}·${m.user}）：${m.content}`, evidence: [cid] });
    if (st.spreading.length) unverified.push({ text: `有内容被转发到 ${Math.max(...st.spreading.map((s) => s.groups.length))} 个群，属于信息传播，不代表独立共识：「${st.spreading[0].sample.slice(0, 60)}」`, evidence: [cid] });
  }

  const noClear = confirmed.length === 0 && possible.length === 0;
  const qid = qe[0]?.id;
  const blocks = [
    F(`${name(symbol)}（${symbol}）最新价 ${q.last}，相对上一交易日收盘 ${q.prevClose} ${verb} ${Math.abs(q.changePct).toFixed(2)}%。数据来源：${q.source}${q.delayMinutes ? `（延迟 ${q.delayMinutes} 分钟）` : ''}。`, [qid]),
    H('已确认事件'),
    ...(confirmed.length ? confirmed.map((c) => F(c.text, c.evidence)) : [T('暂无有官方公告或多家媒体证实的相关事件。')]),
    H('可能影响因素'),
    ...(possible.length ? possible.map((c) => A(c.text, c.evidence)) : [T('暂未发现与本次变动明显相关的行业、指数或宏观因素。')]),
    ...observations.map((c) => A(c.text, c.evidence)),
  ];
  if (unverified.length) blocks.push(H('待验证信息'), ...unverified.map((c) => U(c.text, c.evidence)));
  if (noClear) blocks.push(H('结论'), A('暂无明确原因。当前没有足够信息解释本次价格变动，系统会继续监控公告与新闻。'));
  else if (confirmed.length) blocks.push(H('结论'), A(`本次${verb}与上述已确认事件在时间上高度吻合，可能是主要驱动；但事件与股价之间的因果关系属于推断，仍需结合后续资金流与市场反应验证。`));
  else blocks.push(H('结论'), A('没有找到直接解释本次变动的公告或新闻，上述因素只具有相关性，无法确认因果关系。'));

  return {
    title: `${code(symbol)} ${verb} ${Math.abs(q.changePct).toFixed(1)}% 原因分析`,
    blocks, evidence: ctx.ev(), toolCalls: ctx.toolCalls,
    summary: noClear ? '暂无明确原因' : confirmed.length ? `已确认事件 ${confirmed.length} 条，可能因素 ${possible.length} 条` : `无已确认事件，可能因素 ${possible.length} 条`,
    confirmed, possible, unverified, noClearReason: noClear,
  };
}

// ------------------------------------------------------------------
// 2. 经济数据公布后的影响分析
// ------------------------------------------------------------------
export function calendarImpact(c) {
  const s = +(c.actual - c.forecast).toFixed(2);
  const ev = [`cal:${c.id}`];
  const blocks = [F(`${c.country}${c.event}：公布值 ${c.actual}${c.unit}，市场预期 ${c.forecast}${c.unit}，前值 ${c.previous}${c.unit}。`, ev)];
  const e = c.event;
  let analysis;
  if (/CPI|PPI/.test(e)) analysis = s < 0 ? '通胀低于预期，市场可能提高降息预期：美债收益率与美元可能承压，黄金与成长股估值可能受益。' : s > 0 ? '通胀高于预期，市场可能下调降息预期：美债收益率与美元可能走强，黄金与高估值成长股可能承压。' : '结果与预期一致，对利率预期的冲击可能有限。';
  else if (/非农|就业|失业金/.test(e)) analysis = (/失业金/.test(e) ? -s : s) > 0 ? '就业数据强于预期，可能削弱降息预期，利好美元，利空黄金与长久期资产。' : '就业数据弱于预期，可能强化降息预期，利好美债与黄金，美元可能走弱。';
  else if (/PMI|GDP/.test(e)) analysis = s > 0 ? '经济数据好于预期，可能提振风险偏好与周期类资产。' : '经济数据弱于预期，可能压制风险偏好，并强化政策宽松预期。';
  else if (/利率|FOMC|央行/.test(e)) analysis = c.actual < c.previous ? '央行降息，通常利好权益资产与黄金，本币可能走弱。' : c.actual > c.previous ? '央行加息，通常压制估值，本币可能走强。' : '利率维持不变，关注会后表态对后续路径的指引。';
  else analysis = '影响取决于后续政策反应。';
  blocks.push(A(analysis));
  return { title: `${c.country}${c.event} 数据解读`, blocks, evidence: [{ id: ev[0], type: 'data', label: blocks[0].text, source: '经济日历（演示数据）', time: c.time }], surprise: s };
}

// ------------------------------------------------------------------
// 3. 公司研究框架 + 财报分析
// ------------------------------------------------------------------
export async function companyResearch(symbol, ctx = new Ctx()) {
  const kb = COMPANY_KB[symbol];
  const blocks = [];
  if (!kb) {
    blocks.push(T(`本地知识库暂无 ${name(symbol)} 的研究框架。配置 ANTHROPIC_API_KEY 后，OpenClaw 会基于财报、公告和新闻生成。`));
    return { title: `${name(symbol)} 公司研究`, blocks, evidence: [] };
  }
  const sections = [['公司做什么', kb.business], ['核心竞争力', kb.moat], ['增长驱动', kb.growth], ['核心风险', kb.risks], ['关键指标', kb.metrics], ['估值逻辑', kb.valuation], ['关键催化剂', kb.catalysts]];
  for (const [h, items] of sections) { blocks.push(H(h)); for (const it of [].concat(items)) blocks.push(A(it)); }
  return { title: `${name(symbol)} 公司研究框架`, blocks, evidence: ctx.ev() };
}

export async function earningsAnalysis(symbol, ctx = new Ctx()) {
  const { data, evidence } = await ctx.tool('company_financials', { symbol });
  if (data.error) return { title: '财报分析', blocks: [T(data.error)], evidence: [] };
  const ch = data.latestChanges;
  const e = evidence.map((x) => x.id);
  const by = Object.fromEntries(ch.items.map((i) => [i.metric, i]));
  const blocks = [
    H(`${ch.period} 财报变化`),
    F(`营收 ${by['营收'].value.toLocaleString()} 百万，同比 ${by['营收'].yoy}%、环比 ${by['营收'].qoq}%。`, e),
    F(`净利润 ${by['净利润'].value.toLocaleString()} 百万，同比 ${by['净利润'].yoy}%；自由现金流同比 ${by['自由现金流'].yoy}%。`, e),
    F(`毛利率 ${by['毛利率'].value}%（环比 ${by['毛利率'].delta >= 0 ? '+' : ''}${by['毛利率'].delta}pct），净利率 ${by['净利率'].value}%（环比 ${by['净利率'].delta >= 0 ? '+' : ''}${by['净利率'].delta}pct）。`, e),
  ];
  if (ch.guidance) blocks.push(F(`管理层指引：${ch.guidance}`, e));
  blocks.push(H('解读'));
  blocks.push(A(by['营收'].yoy > 15 ? '收入保持较高增速，增长动能仍在。' : by['营收'].yoy > 0 ? '收入保持正增长，但增速温和。' : '收入同比下滑，需要关注需求端变化。'));
  if (by['毛利率'].delta < -0.5) blocks.push(A(`毛利率环比下降 ${Math.abs(by['毛利率'].delta)}pct，可能与产品结构或新品爬坡有关，需观察是否为趋势性变化。`));
  else if (by['毛利率'].delta > 0.5) blocks.push(A('毛利率环比改善，定价能力或成本控制有所增强。'));
  blocks.push(U('是否超出 / 低于市场一致预期需要接入一致预期数据源后判断（当前未接入）。'));
  return { title: `${name(symbol)} ${ch.period} 财报分析`, blocks, evidence: ctx.ev() };
}

// ------------------------------------------------------------------
// 4. 重新检查用户投资逻辑：只生成建议，不修改用户计划
// ------------------------------------------------------------------
export async function recheckThesis(symbol, ctx = new Ctx(), { save: doSave = true } = {}) {
  const { data: r } = await ctx.tool('research_notes', { symbol });
  if (!r.thesis && !r.assumptions.length) return { title: '投资逻辑检查', blocks: [T(`你还没有为 ${name(symbol)} 记录投资逻辑。可以在详情页"我的研究"中添加。`)], evidence: [] };
  const fin = financialMetrics(symbol);
  const { data: news } = await ctx.tool('news_search', { symbol, hours: 24 * 14, limit: 6 });
  const blocks = [H('你的原始判断'), N(r.thesis, [`r:${symbol}:${r.updatedAt || ''}`])];
  const suggestions = [];
  for (const a of r.assumptions) {
    blocks.push(N(`核心假设：${a.text}（状态：${a.status}，最近检查 ${a.lastCheckedAt.slice(0, 10)}）`));
    const age = Math.floor((Date.now() - new Date(a.lastCheckedAt)) / 86400e3);
    if (/毛利率/.test(a.text) && fin) {
      if (![...ctx.evidence.keys()].some((k) => k.startsWith('fin:'))) await ctx.tool('company_financials', { symbol });
      const qs = fin.quarters; const cur = qs[qs.length - 1]; const prev = qs[qs.length - 2];
      const thr = Number((a.text.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1]);
      const fact = `最新季度（${cur.period}）毛利率 ${((cur.grossProfit / cur.revenue) * 100).toFixed(1)}%，上季度 ${((prev.grossProfit / prev.revenue) * 100).toFixed(1)}%。`;
      blocks.push(F(fact, [...ctx.evidence.keys()].filter((k) => k.startsWith('fin:'))));
      const gm = (cur.grossProfit / cur.revenue) * 100; const pgm = (prev.grossProfit / prev.revenue) * 100;
      if ((thr && gm < thr + 3) || gm < pgm - 0.5) {
        const s = `根据最新财报，毛利率为 ${gm.toFixed(1)}%（环比 ${(gm - pgm).toFixed(1)}pct），你之前的假设「${a.text}」可能需要重新检查。`;
        blocks.push(A(s)); suggestions.push({ text: s, assumptionId: a.id });
      } else blocks.push(A('最新财务数据仍支持该假设。'));
    }
    if (/资本开支|capex/i.test(a.text)) {
      const related = news.filter((e) => /资本开支|capex|数据中心/i.test(e.title + JSON.stringify(e.summary)));
      for (const e of related) {
        blocks.push(F(`相关事件：${e.summary.what.text}`, [`n:${e.id}`]));
        for (const c of e.summary.changes.filter((x) => x.kind === 'unverified')) blocks.push(U(c.text, [`n:${e.id}`]));
      }
      if (related.length) blocks.push(A('近期事件对该假设形成支持性信号，但其中部分信息来自知情人士，尚未被公司证实。'));
      else blocks.push(A('近两周没有找到与该假设直接相关的新信息。'));
    }
    if (/交付|销量/.test(a.text)) {
      const related = news.filter((e) => /交付|deliver/i.test(e.title));
      for (const e of related) blocks.push(F(e.summary.what.text, [`n:${e.id}`]));
      if (related.some((e) => /不及|低于|miss/i.test(e.title + e.lead + JSON.stringify(e.summary)))) {
        const s = `最新交付数据低于市场预期，你之前的假设「${a.text}」可能需要重新检查。`;
        blocks.push(A(s)); suggestions.push({ text: s, assumptionId: a.id });
      }
    }
    if (age >= db.settings.research.staleDays) {
      const s = `假设「${a.text}」已 ${age} 天未检查，建议结合最新信息确认是否仍然成立。`;
      blocks.push(A(s)); suggestions.push({ text: s, assumptionId: a.id });
    }
  }
  const saved = doSave ? suggestions.map((s) => addSuggestion({ symbol, ...s, evidence: ctx.ev().map((e) => e.id) })) : [];
  blocks.push(H('下一步'));
  blocks.push(T(saved.length ? `已生成 ${saved.length} 条建议，放在详情页"AI 建议"中。AI 不会修改你的研究记录和交易计划，是否调整由你决定。` : '暂无需要你调整的地方，系统会继续跟踪这些假设。'));
  return { title: `${name(symbol)} 投资逻辑检查`, blocks, evidence: ctx.ev(), suggestions: saved };
}

// ------------------------------------------------------------------
// 5. 其他问答能力
// ------------------------------------------------------------------
export async function marketOverview(ctx = new Ctx()) {
  const { data: macro } = await ctx.tool('macro_data', {});
  const { data: news } = await ctx.tool('news_search', { hours: 24, limit: 5 });
  const { data: cal } = await ctx.tool('economic_calendar', { status: 'released', hours: 24 });
  const movers = [...macro].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);
  const blocks = [H('宏观资产变动'), ...movers.map((m) => F(`${m.name} ${m.last}（${fmtPct(m.changePct)}）`, [`q:${m.id}`]))];
  if (cal.length) blocks.push(H('今日已公布数据'), ...cal.map((c) => F(`${c.country}${c.event}：${c.actual}${c.unit}（预期 ${c.forecast}${c.unit}）`, [`cal:${c.id}`])));
  blocks.push(H('重要事件'), ...news.map((e) => F(e.title, [`n:${e.id}`])));
  const spx = macro.find((m) => m.id === 'SP:SPX');
  const cpi = cal.find((c) => /CPI/.test(c.event) && c.surprise < 0);
  blocks.push(H('AI 解读'));
  if (cpi) blocks.push(A(`通胀数据低于预期，降息预期升温，这与美元走弱、美债收益率下行、黄金上涨的组合一致；美股${spx?.changePct >= 0 ? '整体偏强' : '仍偏弱'}。以上为基于公开数据的推断。`));
  else blocks.push(A('今日缺少明确的单一宏观驱动，资产表现更多受个别事件影响。'));
  return { title: '今日市场概览', blocks, evidence: ctx.ev() };
}

export async function newsForWatchlist(ctx = new Ctx(), symbol) {
  const watched = new Set(symbol ? [symbol] : watchedSymbols());
  const { data } = await ctx.tool('news_search', { hours: 72, limit: 30, ...(symbol ? { symbol } : {}) });
  const rel = data.filter((e) => e.entities.some((x) => watched.has(x))).slice(0, 8);
  const blocks = [];
  if (!rel.length) blocks.push(T('最近 72 小时没有与你的自选标的直接相关的重要事件。'));
  for (const e of rel) {
    blocks.push(H(e.title));
    blocks.push(F(`发生了什么：${e.summary.what.text}`, [`n:${e.id}`]));
    for (const c of e.summary.changes) blocks.push(c.kind === 'fact' ? F(`关键变化：${c.text}`, [`n:${e.id}`]) : U(c.text, [`n:${e.id}`]));
    blocks.push(T(`涉及资产：${e.entities.filter((x) => watched.has(x)).map((x) => `${name(x)}（${x}）`).join('、')}`));
    blocks.push(A(`潜在影响：${e.summary.impact.text}`));
  }
  return { title: symbol ? `${name(symbol)} 相关新闻` : '影响自选股的新闻', blocks, evidence: ctx.ev() };
}

export async function chatSummary(ctx = new Ctx(), minutes = 24 * 60) {
  const { data } = await ctx.tool('chat_stats', { minutes });
  const blocks = [H(`最近 ${minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`}群聊讨论最多的标的`)];
  if (!data.length) blocks.push(T('该时段内没有识别到投资标的相关讨论。'));
  data.slice(0, 5).forEach((s, i) => {
    blocks.push(F(`${i + 1}. ${s.name}（${s.symbol}）：${s.groups} 个群有效讨论，${s.users} 人，${s.messages} 条消息${s.topics.length ? `，主要话题：${s.topics.map((t) => t.name).join('、')}` : ''}`, [`c:${s.symbol}`].filter((x) => ctx.evidence.has(x))));
  });
  const top = data[0];
  if (top) {
    const st = symbolStats(top.symbol, db.chatMessages, { ...db.settings.chatHeat, windowMinutes: minutes });
    if (st.bull.length) blocks.push(H('看多观点'), ...st.bull.slice(0, 3).map((m) => U(`${m.groupName}·${m.user}：${m.content}`)));
    if (st.bear.length) blocks.push(H('看空观点'), ...st.bear.slice(0, 3).map((m) => U(`${m.groupName}·${m.user}：${m.content}`)));
    if (st.unverified.length) blocks.push(H('未证实消息'), ...st.unverified.map((m) => U(`${m.groupName}·${m.user}：${m.content}`)));
    if (st.spreading.length) blocks.push(A(`注意：有内容被复制到 ${st.spreading[0].groups.length} 个群，属于信息传播，不代表多个群形成了独立共识。`));
  }
  blocks.push(T('群聊热度仅代表关注度，不代表投资建议或买卖信号。'));
  return { title: '群聊热点总结', blocks, evidence: ctx.ev() };
}

export async function researchHistory(symbol, ctx = new Ctx()) {
  const { data: r } = await ctx.tool('research_notes', { symbol });
  const vs = versions(symbol);
  if (!r.thesis) return { title: '研究历史', blocks: [T(`你还没有记录过关注 ${name(symbol)} 的原因。`)], evidence: [] };
  const first = vs[vs.length - 1];
  const blocks = [
    H('你当时为什么关注'),
    N(`${(first?.createdAt || r.updatedAt || '').slice(0, 10)} 你记录：${first?.snapshot.thesis || r.thesis}`),
    ...r.assumptions.map((a) => N(`核心假设：${a.text}（${a.status}）`)),
  ];
  if (vs.length > 1) blocks.push(H('之后的变化'), ...vs.slice(0, -1).map((v) => N(`${v.createdAt.slice(0, 10)}：${v.reason}`)));
  if (r.questions.length) blocks.push(H('待验证问题'), ...r.questions.map((q) => N(`${q.resolved ? '✓' : '○'} ${q.text}`)));
  return { title: `${name(symbol)} 研究历史`, blocks, evidence: ctx.ev() };
}

export async function compare(a, b, ctx = new Ctx()) {
  const rows = [];
  for (const s of [a, b]) {
    const { data: md } = await ctx.tool('market_data', { symbol: s, period: '1M' });
    const fin = financialMetrics(s);
    const last = fin?.quarters.at(-1);
    tagMessages();
    const st = symbolStats(s, db.chatMessages, { ...db.settings.chatHeat, windowMinutes: 24 * 60 });
    const { data: news } = await ctx.tool('news_search', { symbol: s, hours: 72 });
    rows.push({ s, q: md.quote, m1: md.period?.change, last, chat: st.messageCount, news: news.length, research: !!getResearch(s).thesis });
  }
  const blocks = [H('关键数据对比')];
  for (const r of rows) {
    blocks.push(F(`${name(r.s)}：今日 ${fmtPct(r.q.changePct)}，近 1 月 ${r.m1 != null ? fmtPct(r.m1) : '—'}${r.last ? `；最新季度营收同比 ${r.last.revenueYoY ?? '—'}%，毛利率 ${((r.last.grossProfit / r.last.revenue) * 100).toFixed(1)}%，净利率 ${((r.last.netIncome / r.last.revenue) * 100).toFixed(1)}%` : '；暂无财务数据'}；近 3 天相关事件 ${r.news} 个，群聊提及 ${r.chat} 次。`, [`q:${r.s}`]));
  }
  blocks.push(H('AI 分析'));
  const [x, y] = rows;
  if (x.last && y.last) {
    const fx = x.last.revenueYoY ?? 0; const fy = y.last.revenueYoY ?? 0;
    blocks.push(A(`从增长看，${name(fx >= fy ? x.s : y.s)} 收入增速更高；从盈利质量看，${name((x.last.netIncome / x.last.revenue) >= (y.last.netIncome / y.last.revenue) ? x.s : y.s)} 净利率更高。`));
  }
  for (const r of rows) if (COMPANY_KB[r.s]) blocks.push(A(`${name(r.s)} 的核心风险：${[].concat(COMPANY_KB[r.s].risks)[0]}`));
  blocks.push(A('"哪个更值得关注"取决于你的投资逻辑与持有期：偏好增长确定性可以重点跟踪收入增速与指引，偏好安全边际可以重点跟踪估值与现金流。这里不构成买卖建议。'));
  return { title: `${name(a)} vs ${name(b)}`, blocks, evidence: ctx.ev() };
}

export async function riskView(symbol, ctx = new Ctx()) {
  const kb = COMPANY_KB[symbol];
  const { data: md } = await ctx.tool('market_data', { symbol, period: '1M' });
  const { data: plan } = await ctx.tool('trading_plan', { symbol });
  const blocks = [F(`${name(symbol)} 最新价 ${md.quote.last}，近 1 月 ${md.period?.change != null ? fmtPct(md.period.change) : '—'}。`, [`q:${symbol}`])];
  blocks.push(H('主要风险'));
  for (const r of [].concat(kb?.risks || ['本地知识库暂无该公司风险框架。'])) blocks.push(A(r));
  if (plan.plan?.stopLoss) blocks.push(H('与你的交易计划对照'), N(`你设定的止损价 ${plan.plan.stopLoss}，当前价距离止损 ${plan.distance.toStopLoss}%；目标价 ${plan.plan.target}。`));
  const st = symbolStats(symbol, db.chatMessages, db.settings.chatHeat);
  if (st.bear.length) blocks.push(H('群聊中的看空理由'), ...st.bear.slice(0, 3).map((m) => U(`${m.groupName}·${m.user}：${m.content}`)));
  return { title: `${name(symbol)} 风险分析`, blocks, evidence: ctx.ev() };
}

// ------------------------------------------------------------------
// 6. 研究报告
// ------------------------------------------------------------------
export function buildReport(symbol, { focus, save = true } = {}) {
  // 同步版本：直接读取数据层（report_generator 工具内部调用）
  const inst = instrument(symbol);
  const q = db.quotes[symbol];
  const kb = COMPANY_KB[symbol];
  const r = getResearch(symbol);
  const ch = earningsChanges(symbol);
  const events = db.events.filter((e) => e.entities.includes(symbol)).slice(0, 5);
  const filings = db.filings.filter((f) => f.symbol === symbol).slice(0, 5);
  tagMessages();
  const st = symbolStats(symbol, db.chatMessages, { ...db.settings.chatHeat, windowMinutes: 24 * 60 });
  const evidence = [];
  const blocks = [];
  blocks.push(H('一、摘要'));
  blocks.push(F(`${inst.name}（${symbol}）最新价 ${q.last}，今日 ${fmtPct(q.changePct)}。数据来源：${q.source}，时间 ${q.updatedAt.slice(0, 16).replace('T', ' ')} UTC。`, [`q:${symbol}`]));
  evidence.push({ id: `q:${symbol}`, type: 'data', label: `${inst.name} 最新价 ${q.last}`, source: q.source, time: q.updatedAt });
  if (focus) blocks.push(T(`报告侧重：${focus}`));
  if (ch) {
    blocks.push(H('二、财务与财报变化'));
    for (const it of ch.items) blocks.push(F(`${it.metric}：${it.unit === 'pct' ? `${it.value}%（环比 ${it.delta >= 0 ? '+' : ''}${it.delta}pct）` : `${it.value.toLocaleString()} 百万（同比 ${it.yoy ?? '—'}%${it.qoq != null ? `，环比 ${it.qoq}%` : ''}）`}`));
    if (ch.guidance) blocks.push(F(`管理层指引：${ch.guidance}`));
  }
  if (kb) {
    blocks.push(H('三、公司研究框架（AI 分析）'));
    for (const [h, v] of [['商业模式', kb.business], ['核心竞争力', kb.moat], ['增长驱动', kb.growth], ['估值逻辑', kb.valuation], ['关键催化剂', kb.catalysts]]) blocks.push(A(`${h}：${[].concat(v).join('；')}`));
  }
  blocks.push(H('四、近期事件与公告'));
  if (!events.length && !filings.length) blocks.push(T('近期无相关事件。'));
  for (const f of filings) { blocks.push(F(`${f.filedAt.slice(0, 10)} ${f.type}：${f.title}`, [`f:${f.id}`])); evidence.push({ id: `f:${f.id}`, type: 'filing', label: f.title, source: f.source, time: f.filedAt, url: f.url }); }
  for (const e of events) { blocks.push(F(`${e.firstSeen.slice(0, 10)} ${e.title}`, [`n:${e.id}`]), A(e.summary.impact.text)); evidence.push({ id: `n:${e.id}`, type: 'news', label: e.title, source: e.sources.map((s) => s.source).join('、'), time: e.firstSeen, url: e.sources[0]?.url }); }
  blocks.push(H('五、群聊关注度（未经证实）'));
  blocks.push(U(st.messageCount ? `最近 24 小时 ${st.groupCount} 个群、${st.userCount} 人讨论，共 ${st.messageCount} 条。${st.topics.length ? `话题：${st.topics.slice(0, 3).map((t) => t.name).join('、')}。` : ''}` : '最近 24 小时无相关群聊讨论。'));
  blocks.push(H('六、我的研究与交易计划（用户原始判断）'));
  if (r.thesis) {
    blocks.push(N(`投资逻辑：${r.thesis}`));
    for (const a of r.assumptions) blocks.push(N(`核心假设：${a.text}（${a.status}）`));
    const p = r.plan;
    blocks.push(N(`交易计划：买入区间 ${p.buyLow}–${p.buyHigh}，计划仓位 ${p.positionPct}%，止损 ${p.stopLoss}，目标 ${p.target}，有效期至 ${p.validUntil}`));
  } else blocks.push(T('尚未记录。'));
  blocks.push(H('七、核心风险'));
  for (const x of [].concat(kb?.risks || ['需进一步研究。'])) blocks.push(A(x));
  blocks.push(T('本报告由 AI 基于公开数据与你的研究记录生成，事实与推断已分别标注，不构成投资建议。'));
  const title = `${inst.name} 投资研究报告`;
  const saved = save ? addAnalysis({ symbol, kind: 'report', title, blocks, evidence }) : null;
  return { title, blocks, evidence, saved };
}

export { Ctx, hotSymbols };
