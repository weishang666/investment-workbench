// OpenClaw Agent 编排层：理解问题 → 结合页面上下文 → 规划并调用工具 → 生成带证据链的回答 → 保存会话。
// 有 ANTHROPIC_API_KEY 时使用 Claude 进行工具调用推理；否则使用本地意图路由（规则版 OpenClaw）。
import { db, uid, save, instrument } from '../store.js';
import { findMentions } from '../lib/instruments.js';
import { TOOLS, runTool, toolManifest } from './tools.js';
import * as AN from './analysis.js';
import { addAnalysis } from '../research.js';
import * as OpenClaw from './openclaw.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export function llmEnabled() { return !!process.env.ANTHROPIC_API_KEY; }
/** 当前回答引擎：本机 OpenClaw > Claude API > 本地规则 */
export function engine() { return OpenClaw.chatEnabled() ? 'openclaw' : llmEnabled() ? MODEL : 'local-rules'; }

// ---------------- 会话 ----------------
export function listSessions() {
  return db.agentSessions.map(({ messages, apiMessages, ...s }) => ({ ...s, messageCount: messages.length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function getSession(id) { return db.agentSessions.find((s) => s.id === id); }

function newSession(question, symbols) {
  const s = { id: uid('s_'), title: question.slice(0, 28), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), symbols: [...symbols], toolsUsed: [], reports: [], messages: [] };
  db.agentSessions.push(s);
  return s;
}

// ---------------- 入口 ----------------
/**
 * @param {string} question 用户问题
 * @param {{page?: string, symbol?: string}} context 用户当前所在页面
 * @param {string} [sessionId] 继续某个历史会话
 */
export async function ask(question, context = {}, sessionId) {
  let session = sessionId ? getSession(sessionId) : null;
  // "继续之前关于 Nvidia 的分析"：自动找回最近一次相关会话
  const mentioned = findMentions(question, db.instruments).filter((id) => instrument(id));
  if (!session && /继续|接着|之前的分析|上次/.test(question)) {
    session = [...db.agentSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((s) => !mentioned.length || mentioned.some((m) => s.symbols.includes(m)));
  }
  const ctxSymbol = context.symbol && instrument(context.symbol) ? context.symbol : null;
  const lastSessionSymbol = session?.symbols?.[0];
  const symbols = mentioned.length ? mentioned : [ctxSymbol || lastSessionSymbol].filter(Boolean);
  if (!session) session = newSession(question, symbols);
  for (const s of symbols) if (!session.symbols.includes(s)) session.symbols.push(s);
  session.messages.push({ role: 'user', text: question, context, at: new Date().toISOString() });

  let result;
  let model = engine();
  try {
    if (model === 'openclaw') result = await askOpenClaw(question, context, session);
    else result = llmEnabled() ? await askLLM(question, context, symbols, session) : await askLocal(question, symbols, mentioned.length > 0);
  } catch (e) {
    console.error('[agent] 失败：', e.message);
    if (model === 'openclaw') {
      // 本机 OpenClaw 不可用时回退到本地规则，并在回答开头说明
      model = 'local-rules';
      result = await askLocal(question, symbols, mentioned.length > 0);
      result.blocks = [{ kind: 'note', text: `本机 OpenClaw 暂时连不上（${e.message}），以下由本地规则生成。` }, ...result.blocks];
    } else {
      result = { title: '分析失败', blocks: [{ kind: 'text', text: `分析过程出错：${e.message}。如果使用了大模型，请检查 ANTHROPIC_API_KEY 与网络。` }], evidence: [], toolCalls: [] };
    }
  }
  const msg = { role: 'assistant', title: result.title, blocks: result.blocks, evidence: result.evidence || [], toolCalls: result.toolCalls || [], model, resolvedSymbols: symbols, at: new Date().toISOString() };
  session.messages.push(msg);
  for (const t of msg.toolCalls) if (!session.toolsUsed.includes(t.name)) session.toolsUsed.push(t.name);
  if (result.saved) session.reports.push(result.saved.id);
  session.updatedAt = msg.at;
  save();
  return { sessionId: session.id, sessionTitle: session.title, message: msg };
}

// ---------------- 本地意图路由 ----------------
const has = (q, re) => re.test(q);

export async function askLocal(question, symbols, explicit = true) {
  const q = question.toLowerCase();
  const ctx = new AN.Ctx();
  const sym = symbols[0];
  const wrap = (r) => ({ ...r, toolCalls: ctx.toolCalls, evidence: r.evidence?.length ? r.evidence : ctx.ev() });

  if (symbols.length >= 2 && has(q, /和|vs|对比|比较|哪个/)) return wrap(await AN.compare(symbols[0], symbols[1], ctx));
  if (has(q, /报告/) && sym) {
    const r = AN.buildReport(sym, { save: true });
    ctx.toolCalls.push({ name: 'report_generator', input: { symbol: sym }, at: new Date().toISOString() });
    return { ...r, toolCalls: ctx.toolCalls };
  }
  // 问的是整体市场 / 自选股整体，而不是当前页面的标的
  if (!explicit && has(q, /自选|我的股票|持仓/) && has(q, /新闻|消息|事件|影响/)) return wrap(await AN.newsForWatchlist(ctx));
  if (!explicit && has(q, /市场|大盘|美股|宏观/)) return wrap(await AN.marketOverview(ctx));
  if (has(q, /群|讨论最多|热议/)) return wrap(await AN.chatSummary(ctx, has(q, /小时/) ? 60 : 24 * 60));
  if (sym && has(q, /重新检查|调整|需要修改|还成立|重新分析|有没有需要/)) {
    const r1 = await AN.recheckThesis(sym, ctx);
    if (has(q, /财报|重新分析/)) {
      const r2 = await AN.earningsAnalysis(sym, ctx);
      const r3 = await AN.newsForWatchlist(ctx, sym);
      return wrap({ title: `${instrument(sym).name} 综合复查`, blocks: [...r2.blocks, { kind: 'h', text: '相关新闻' }, ...r3.blocks.filter((b) => b.kind !== 'h'), ...r1.blocks] });
    }
    return wrap(r1);
  }
  if (sym && has(q, /之前|当时|为什么关注|历史/)) return wrap(await AN.researchHistory(sym, ctx));
  if (sym && has(q, /为什么|原因|怎么了|涨|跌|异动/)) return wrap(await AN.explainMove(sym, ctx));
  if (has(q, /新闻|消息|事件|影响/)) return wrap(await AN.newsForWatchlist(ctx, sym));
  if (sym && has(q, /风险/)) return wrap(await AN.riskView(sym, ctx));
  if (sym && has(q, /财报|业绩|财务/)) return wrap(await AN.earningsAnalysis(sym, ctx));
  if (sym) {
    // 标的研究：行情 + 公司研究框架 + 财报 + 用户研究
    const move = await AN.explainMove(sym, ctx);
    const co = await AN.companyResearch(sym, ctx);
    const er = instrument(sym).type === 'stock' ? await AN.earningsAnalysis(sym, ctx) : { blocks: [] };
    const r = await ctx.tool('research_notes', { symbol: sym });
    const notes = r.data.thesis ? [{ kind: 'h', text: '你的研究记录' }, { kind: 'note', text: r.data.thesis }, ...r.data.assumptions.map((a) => ({ kind: 'note', text: `核心假设：${a.text}（${a.status}）` }))] : [];
    const blocks = [move.blocks[0], ...co.blocks, ...er.blocks, ...notes];
    const res = wrap({ title: `${instrument(sym).name} 分析`, blocks });
    if (instrument(sym).type === 'stock') addAnalysis({ symbol: sym, kind: 'company_research', title: res.title, blocks, evidence: res.evidence });
    return res;
  }
  if (has(q, /市场|大盘|今天|宏观|美股/)) return wrap(await AN.marketOverview(ctx));
  return wrap({
    title: '我可以帮你做什么', blocks: [
      { kind: 'text', text: '我没能从问题里识别出具体标的。你可以这样问：' },
      { kind: 'text', text: '· 为什么黄金今天突然上涨？\n· 分析一下 NVDA\n· 最近有哪些新闻可能影响我的自选股？\n· 今天群里讨论最多的股票是什么？\n· META 和谷歌哪个更值得关注？\n· 根据最近财报重新检查我对特斯拉的投资逻辑\n· 帮我生成一份英伟达投资研究报告' },
    ],
  });
}

// ---------------- Claude 工具调用 ----------------
const SYSTEM = `你是 OpenClaw，一个个人投资研究工作台里的 AI 研究助手，用中文回答。
你通过工具获取数据：行情、宏观、经济日历、新闻事件、公告、财务、自选、用户研究记录、交易计划、群聊、提醒、报告生成。
回答前先用工具取证，不要凭记忆给出价格、财务数字或新闻。

输出格式：每一行以标签开头，便于界面区分可信度：
【事实】有工具返回数据或官方/多家媒体来源支持的内容，可在末尾用 [证据: n:xxx, q:xxx] 引用工具返回的 evidence id。
【AI分析】你的推理与判断。
【待验证】来自群聊、单一信源、知情人士的信息。
【用户研究】引用用户自己的研究记录或交易计划原文。
## 标题 用于分节。

规则：
- 事实和推断不得混为确定性结论；找不到原因时明确写"暂无明确原因"，严禁编造。
- 价格异动分析按"已确认事件 / 可能影响因素 / 暂无明确原因"组织。
- 你不能修改用户的研究记录和交易计划。认为某个假设需要重新检查时，用 research_notes 的 action=suggest 提交建议，并告诉用户由他决定。
- 群聊热度只代表关注度，不是买卖信号。不提供确定性的买卖建议。`;

let clientPromise = null;
async function client() {
  if (!clientPromise) clientPromise = import('@anthropic-ai/sdk').then((m) => new m.default()).catch(() => { throw new Error('未安装 @anthropic-ai/sdk，请在项目目录运行 npm install'); });
  return clientPromise;
}

async function askLLM(question, context, symbols, session) {
  const anthropic = await client();
  const tools = toolManifest().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const page = context.page === 'stock' && context.symbol ? `用户当前正在查看 ${instrument(context.symbol)?.name}（${context.symbol}）详情页。` : `用户当前在${context.page === 'alerts' ? '提醒中心' : '投资大屏'}。`;
  const resolved = symbols.length ? `问题涉及的标的：${symbols.join('、')}。` : '';
  // 历史：只回放文本（追加式，不改写历史）
  const history = [];
  for (const m of session.messages.slice(0, -1)) {
    if (m.role === 'user') history.push({ role: 'user', content: m.text });
    else history.push({ role: 'assistant', content: blocksToText(m.blocks) || '（无内容）' });
  }
  const messages = [...history, { role: 'user', content: `${page}${resolved}\n\n${question}` }];
  const evidence = new Map(); const toolCalls = [];
  for (let i = 0; i < 12; i++) {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 16000, system: SYSTEM, tools, messages,
      thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    });
    if (res.stop_reason === 'refusal') return { title: '无法回答', blocks: [{ kind: 'text', text: '模型拒绝了这个请求。' }], evidence: [], toolCalls };
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { title: question.slice(0, 30), blocks: parseTagged(text), evidence: [...evidence.values()], toolCalls };
    }
    const results = await Promise.all(uses.map(async (u) => {
      toolCalls.push({ name: u.name, input: u.input, at: new Date().toISOString() });
      try {
        const r = await runTool(u.name, u.input);
        for (const e of r.evidence || []) evidence.set(e.id, e);
        return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ data: r.data, evidence: r.evidence }).slice(0, 60000) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: u.id, content: e.message, is_error: true };
      }
    }));
    messages.push({ role: 'user', content: results });
  }
  return { title: question.slice(0, 30), blocks: [{ kind: 'text', text: '工具调用轮数过多，已停止。' }], evidence: [...evidence.values()], toolCalls };
}

const TAGS = [['【事实】', 'fact'], ['【AI分析】', 'analysis'], ['【AI 分析】', 'analysis'], ['【待验证】', 'unverified'], ['【用户研究】', 'note']];
async function askOpenClaw(question, context, session) {
  const text = await OpenClaw.chat(question, context, session.id);
  const blocks = parseTagged(text);
  return { title: question.slice(0, 30), blocks, evidence: OpenClaw.resolveEvidence(blocks), toolCalls: [] };
}

export function parseTagged(text) {
  const blocks = [];
  for (const raw of text.split('\n')) {
    // 兼容模型常见的 markdown 写法：列表符号、加粗标签
    const line = raw.trim().replace(/^([-*•]|\d+[.、)])\s+(?=\*{0,2}【)/, '').replace(/^\*\*(【[^】]+】)\*\*\s*/, '$1');
    if (!line) continue;
    if (/^#{1,4}\s/.test(line)) { blocks.push({ kind: 'h', text: line.replace(/^#+\s*/, '') }); continue; }
    const tag = TAGS.find(([t]) => line.startsWith(t));
    let body = tag ? line.slice(tag[0].length).trim() : line;
    const ev = [];
    body = body.replace(/\[证据[:：]\s*([^\]]+)\]/g, (_, ids) => { ev.push(...ids.split(/[,，\s]+/).filter(Boolean)); return ''; }).trim();
    blocks.push({ kind: tag ? tag[1] : 'text', text: body, evidence: ev });
  }
  return blocks;
}

function blocksToText(blocks = []) {
  const rev = Object.fromEntries(TAGS.map(([t, k]) => [k, t]));
  return blocks.map((b) => (b.kind === 'h' ? `## ${b.text}` : `${rev[b.kind] || ''}${b.text}`)).join('\n');
}

export { TOOLS };
