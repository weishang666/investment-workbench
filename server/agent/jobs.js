// 主动式 Agent：定时任务 + 事件触发任务。
// 业务后端先做确定性判断并即时提醒（第一阶段），再异步调用 Agent 分析（第二阶段），两者解耦。
import { db, uid, save, instrument } from '../store.js';
import { on, emit } from '../lib/bus.js';
import { tick } from '../providers/market.js';
import * as GM from '../providers/gangtiseMarket.js';
import { runPriceMoveRule, runVolumeRule, runLevelRule } from '../rules/priceMove.js';
import { runChatHeatRule } from '../rules/chatHeat.js';
import { runResearchStaleRule, addAnalysis, earningsChanges } from '../research.js';
import { processNews, dailyBrief } from '../news.js';
import { createAlert, attachAnalysis } from '../alerts.js';
import { etHourMinute, usSession } from '../lib/sessions.js';
import { watchedSymbols } from '../watchlist.js';
import * as AN from './analysis.js';
import * as OpenClaw from './openclaw.js';
import { parseTagged } from './agent.js';

const recordRun = (name, detail = '') => {
  db.jobRuns.unshift({ id: uid('j_'), name, at: new Date().toISOString(), detail });
  if (db.jobRuns.length > 200) db.jobRuns.length = 200;
};

// ---------- 第二阶段：事件触发的 Agent 分析 ----------
// 配置了本机 OpenClaw（OPENCLAW_HOOKS_TOKEN）时交给 OpenClaw；未配置、派发失败或超时未回写时用本地规则。
async function localMove(a) {
  const r = await AN.explainMove(a.symbol);
  const saved = addAnalysis({ symbol: a.symbol, kind: 'move_analysis', title: r.title, blocks: r.blocks, evidence: r.evidence, trigger: `alert:${a.id}` });
  attachAnalysis(a.id, { status: 'done', summary: r.summary, analysisId: saved.id, blocks: r.blocks, evidence: r.evidence, confirmed: r.confirmed.length, possible: r.possible.length, noClearReason: r.noClearReason, at: new Date().toISOString() });
  recordRun('异动原因分析', `${a.symbol}：${r.summary}`);
}

const OUTPUT_RULES = '输出逐行使用【事实】/【AI分析】/【待验证】/【用户研究】标签，事实行末尾用 [证据: id] 引用工具返回的 evidence id；不得修改用户研究记录和交易计划，需要调整时用 research_notes 的 suggest 提交建议。';

export const TASK_PROMPTS = {
  move_analysis: (a) => `${a.title}。${a.body}
后端已完成第一阶段提醒，请做第二阶段原因分析：
用 market_data、news_search、filing_search、economic_calendar、chat_stats、research_notes 等工具取证，按 "## 已确认事件" / "## 可能影响因素" / "## 暂无明确原因" 三节组织。只有带来源的事件才能写进"已确认事件"；群聊、单一信源写成【待验证】；找不到证据就明确写"暂无明确原因"，严禁编造原因。最后简要对照用户的投资逻辑与交易计划（关键价位）。
${OUTPUT_RULES}`,
  premarket: () => `生成"今日市场重点"开盘前简报：隔夜宏观行情（macro_data）、今日经济日历（economic_calendar）、重大新闻事件（news_search）、自选股相关公告与新闻、昨日异动与未读提醒（alerts）、今天需要留意的研究假设或交易计划价位。
${OUTPUT_RULES}`,
  postclose: () => `生成"自选股每日复盘"收盘后报告：自选股涨跌概览（watchlist、market_data）、涨跌幅较大的标的及原因（按已确认 / 可能 / 暂无明确原因区分）、相关新闻与公告、群聊热度（chat_stats，热度不是买卖信号）、对照用户研究记录指出需要重新检查的假设（只能提交 suggest 建议）。
${OUTPUT_RULES}`,
};

export function wireEventTriggers() {
  on('alert', (a) => {
    if (a.type === 'price') {
      // 不阻塞第一阶段提醒：异步执行
      setTimeout(async () => {
        const task = { id: uid('t_'), kind: 'move_analysis', label: '异动原因分析', symbol: a.symbol, alertId: a.id, instructions: TASK_PROMPTS.move_analysis(a) };
        if (await OpenClaw.dispatch(task, () => localMove(a))) {
          attachAnalysis(a.id, { status: 'pending', summary: '已交给本机 OpenClaw 分析原因…', taskId: task.id, at: new Date().toISOString() });
          recordRun('异动原因分析（已派发 OpenClaw）', a.symbol);
        } else await localMove(a);
      }, 50);
    }
    if (a.type === 'chat') {
      setTimeout(async () => {
        const r = await AN.chatSummary(undefined, db.settings.chatHeat.windowMinutes);
        attachAnalysis(a.id, { status: 'done', summary: '群聊热点分析', blocks: r.blocks, evidence: r.evidence, at: new Date().toISOString() });
        recordRun('群聊热点分析', a.symbol);
      }, 50);
    }
  });
}

// ---------- 定时检查 ----------
function runRules(now) {
  runPriceMoveRule(now);
  runVolumeRule(now);
  runLevelRule(now);
}

export function runNewsJob(now = new Date()) {
  const fresh = processNews(now);
  const watched = new Set(watchedSymbols());
  for (const e of db.events) {
    if (e.importance < db.settings.news.majorImportance || e.alertable === false) continue;
    if (!e.entities.some((x) => watched.has(x)) && e.eventType !== 'macro_data' && e.eventType !== 'central_bank') continue;
    createAlert({
      type: 'news', symbol: e.watchedEntities[0] || e.entities[0] || null, severity: 'medium', dedupeKey: `news:${e.key}`, now,
      title: e.title, body: `${e.summary.what.text}（${e.sourceCount} 个来源${e.hasOfficial ? '，含官方' : ''}）`,
      data: { eventId: e.id, impact: e.summary.impact },
    });
  }
  return fresh;
}

export function runCalendarJob(now = new Date()) {
  for (const c of db.calendar) {
    if (c.actual == null || new Date(c.time) > now || (now - new Date(c.time)) > 36 * 3600e3) continue;
    const r = AN.calendarImpact(c);
    const a = createAlert({
      type: 'calendar', severity: c.importance >= 3 ? 'medium' : 'low', dedupeKey: `cal:${c.id}`, now,
      title: `${c.country}${c.event} 公布：${c.actual}${c.unit}（预期 ${c.forecast}${c.unit}）`,
      body: r.blocks.filter((b) => b.kind === 'analysis').map((b) => b.text).join(''),
      data: { calendarId: c.id, surprise: r.surprise },
    });
    if (a) attachAnalysis(a.id, { status: 'done', summary: '数据解读', blocks: r.blocks, evidence: r.evidence, at: now.toISOString() });
  }
}

export function runFilingJob(now = new Date()) {
  const watched = new Set(watchedSymbols());
  for (const f of db.filings) {
    if (!watched.has(f.symbol) || (now - new Date(f.filedAt)) > 3 * 86400e3) continue;
    const isEarnings = /10-Q|10-K|财报|业绩/.test(f.type + f.title);
    const a = createAlert({
      type: isEarnings ? 'earnings' : 'company', symbol: f.symbol, severity: 'medium', dedupeKey: `filing:${f.id}`, now,
      title: `${f.symbol.split(':')[1]} ${f.type}：${f.title}`, body: f.summary, data: { filingId: f.id, url: f.url },
    });
    if (a && isEarnings && earningsChanges(f.symbol)) {
      AN.earningsAnalysis(f.symbol).then((r) => {
        const saved = addAnalysis({ symbol: f.symbol, kind: 'earnings', title: r.title, blocks: r.blocks, evidence: r.evidence, trigger: `filing:${f.id}` });
        attachAnalysis(a.id, { status: 'done', summary: '财报变化分析', analysisId: saved.id, blocks: r.blocks, evidence: r.evidence, at: new Date().toISOString() });
      });
    }
  }
}

// ---------- OpenClaw 回写结果 ----------
const RESULT_KINDS = { move_analysis: '异动原因分析', premarket: '今日市场重点', postclose: '自选股每日复盘', chat_summary: '群聊热点分析', research: '研究分析', report: '研究报告', other: 'OpenClaw 分析' };

export function acceptResult(body = {}) {
  const kind = RESULT_KINDS[body.kind] ? body.kind : 'other';
  const blocks = Array.isArray(body.blocks) ? body.blocks : parseTagged(String(body.text || ''));
  if (!blocks.length) throw Object.assign(new Error('结果为空：需要 text（带标签的文本）或 blocks'), { status: 400 });
  const task = body.task ? OpenClaw.complete(body.task) : null;
  const alertId = body.alert || task?.alertId || null;
  const alert = alertId ? db.alerts.find((x) => x.id === alertId) : null;
  const symbol = body.symbol ? (instrument(body.symbol) ? body.symbol : null) : (task?.symbol || alert?.symbol || null);
  const evidence = OpenClaw.resolveEvidence(blocks);
  const day = new Date().toISOString().slice(0, 10);
  const title = body.title || (kind === 'move_analysis' && symbol ? `${instrument(symbol)?.name || symbol} 异动原因分析` : `${RESULT_KINDS[kind]} · ${day}`);
  const saved = addAnalysis({ symbol, kind, title, blocks, evidence, model: 'openclaw', trigger: task ? `openclaw:${task.id}` : 'openclaw' });
  if (alert) {
    const count = (re) => blocks.filter((b) => b.kind === 'h' && re.test(b.text)).length;
    const summary = body.summary || (blocks.some((b) => /暂无明确原因/.test(b.text)) && !count(/已确认/) ? '暂无明确原因' : (blocks.find((b) => b.kind === 'analysis' || b.kind === 'fact')?.text || '已完成').slice(0, 60));
    attachAnalysis(alert.id, { status: 'done', source: 'openclaw', summary, analysisId: saved.id, blocks, evidence, at: saved.createdAt });
  }
  if (kind === 'premarket' || kind === 'postclose') {
    db.briefs.unshift({ id: uid('b_'), createdAt: saved.createdAt, title, analysisId: saved.id, kind, items: [], source: 'openclaw' });
    emit('brief', saved);
  }
  recordRun(`OpenClaw 回写：${RESULT_KINDS[kind]}`, symbol || saved.id);
  save();
  return { ok: true, analysisId: saved.id, attachedTo: alert?.id || null, evidenceResolved: evidence.length };
}

// ---------- 定时任务（按美东时间） ----------
export const SCHEDULE = [
  { name: 'premarket', label: '开盘前：今日市场重点', at: 8 * 60 + 30 },
  { name: 'postclose', label: '收盘后：自选股每日复盘', at: 16 * 60 + 30 },
];

export async function runScheduled(name, now = new Date(), { local = false } = {}) {
  if ((name === 'premarket' || name === 'postclose') && !local && OpenClaw.hooksEnabled()) {
    const job = SCHEDULE.find((j) => j.name === name);
    const task = { id: uid('t_'), kind: name, label: job.label, instructions: TASK_PROMPTS[name]() };
    if (await OpenClaw.dispatch(task, () => runScheduled(name, new Date(), { local: true }))) {
      recordRun(`${job.label}（已派发 OpenClaw）`, task.id);
      return { dispatched: true, taskId: task.id };
    }
  }
  if (name === 'premarket') {
    const r = await AN.marketOverview();
    const brief = dailyBrief(now);
    const saved = addAnalysis({ kind: 'premarket', title: `今日市场重点 · ${now.toISOString().slice(0, 10)}`, blocks: [...r.blocks, { kind: 'h', text: '每日事件简报' }, ...brief.items.map((i) => ({ kind: 'fact', text: i.title }))], evidence: r.evidence, trigger: 'schedule:premarket' });
    db.briefs.unshift({ ...brief, analysisId: saved.id, kind: 'premarket' });
    recordRun('开盘前：今日市场重点', saved.id);
    emit('brief', saved);
    return saved;
  }
  if (name === 'postclose') {
    const blocks = [{ kind: 'h', text: '自选股今日表现' }];
    const rows = watchedSymbols('stock').map((id) => ({ id, q: db.quotes[id] })).filter((x) => x.q).sort((a, b) => Math.abs(b.q.changePct) - Math.abs(a.q.changePct));
    for (const { id, q } of rows) blocks.push({ kind: 'fact', text: `${instrument(id).name}（${id}）收于 ${q.last}，${q.changePct > 0 ? '+' : ''}${q.changePct}%`, evidence: [`q:${id}`] });
    const movers = rows.filter((x) => Math.abs(x.q.changePct) >= 3).slice(0, 3);
    for (const m of movers) {
      const r = await AN.explainMove(m.id);
      blocks.push({ kind: 'h', text: r.title }, ...r.blocks.slice(1));
    }
    blocks.push({ kind: 'h', text: '今日提醒回顾' }, { kind: 'text', text: `今日共 ${db.alerts.filter((a) => a.createdAt.slice(0, 10) === now.toISOString().slice(0, 10)).length} 条提醒。` });
    const saved = addAnalysis({ kind: 'postclose', title: `自选股每日复盘 · ${now.toISOString().slice(0, 10)}`, blocks, evidence: [], trigger: 'schedule:postclose' });
    db.briefs.unshift({ id: uid('b_'), createdAt: now.toISOString(), title: saved.title, analysisId: saved.id, kind: 'postclose', items: [] });
    recordRun('收盘后：自选股每日复盘', saved.id);
    emit('brief', saved);
    return saved;
  }
  if (name === 'news') { runNewsJob(now); recordRun('新闻流水线'); return { ok: true }; }
  if (name === 'chat') { runChatHeatRule(now); recordRun('跨群热度检查'); return { ok: true }; }
  if (name === 'research') { runResearchStaleRule(now); recordRun('研究假设检查'); return { ok: true }; }
  throw Object.assign(new Error(`未知任务 ${name}`), { status: 404 });
}

function checkSchedule(now) {
  const { tradeDate } = usSession(now);
  const m = etHourMinute(now);
  for (const job of SCHEDULE) {
    const key = `${job.name}:${tradeDate}`;
    if (m >= job.at && m < job.at + 90 && !db.jobRuns.some((r) => r.detail === key || r.key === key)) {
      db.jobRuns.unshift({ id: uid('j_'), name: job.label, key, at: now.toISOString(), detail: key });
      runScheduled(job.name, now).catch((e) => console.error('[jobs]', e));
    }
  }
}

// ---------- Gangtise 真实数据 ----------
// 行情每 60 秒轮询一次（免费接口），驱动异动 / 成交量规则；日 K 启动后后台预取；
// 业绩日历与置顶股票的公告每天拉一次（按行计费，受 GANGTISE_DAILY_POINTS 日上限约束）。
export async function runGangtisePoll(now = new Date(), opts) {
  const changed = await GM.pollQuotes(now, opts);
  if (changed.length) { runRules(now); emit('quotes', changed); save(); }
  return changed.length;
}

export async function runGangtiseDaily(now = new Date()) {
  // 记在 db 里，重启不会重复拉（按行计费）
  const day = new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  if (db.gangtiseDailyAt === day) return;
  db.gangtiseDailyAt = day;
  try {
    const n = await GM.refreshEarningsCalendar(watchedSymbols('stock'), now);
    const pinned = [...new Set(db.watchlist.groups.filter((g) => g.kind === 'stock').flatMap((g) => g.items.filter((i) => i.pinned).map((i) => i.symbol)))];
    for (const id of pinned) await GM.ensureFilings(id, { size: 5, now });
    recordRun('Gangtise 每日同步', `业绩日历 ${n} 条，置顶股票公告 ${pinned.length} 只`);
    runFilingJob(now); save();
  } catch (e) { console.error('[gangtise] 每日同步失败：', e.message); }
}

export function startGangtise() {
  if (!GM.enabled()) return () => {};
  console.log('[gangtise] 已启用：股票 / 指数行情每 60 秒轮询，财报与公告按需拉取');
  const boot = async () => {
    await runGangtisePoll(new Date(), { force: true });
    await runGangtiseDaily(new Date());
    const n = await GM.preloadDaily();
    console.log(`[gangtise] 日 K 预取完成：${n} 个标的`);
    save();
  };
  boot().catch((e) => console.error('[gangtise] 启动同步失败：', e.message));
  const timers = [
    setInterval(() => runGangtisePoll(new Date()).catch((e) => console.error('[gangtise]', e.message)), Number(process.env.GANGTISE_POLL_MS || 60000)),
    setInterval(() => runGangtiseDaily(new Date()), 3600e3),
  ];
  return () => timers.forEach(clearInterval);
}

export function startJobs({ tickMs = 5000 } = {}) {
  wireEventTriggers();
  const boot = new Date();
  runNewsJob(boot); runCalendarJob(boot); runFilingJob(boot); runRules(boot); runChatHeatRule(boot); runResearchStaleRule(boot);
  recordRun('启动检查');
  const timers = [
    setInterval(() => { const now = new Date(); const changed = tick(now); runRules(now); emit('quotes', changed); }, tickMs),
    setInterval(() => { const now = new Date(); runChatHeatRule(now); runNewsJob(now); runCalendarJob(now); runFilingJob(now); checkSchedule(now); save(); }, 60000),
    setInterval(() => runResearchStaleRule(new Date()), 3600e3),
  ];
  const stopGts = startGangtise();
  return () => { timers.forEach(clearInterval); stopGts(); };
}
