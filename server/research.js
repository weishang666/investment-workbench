// 个人研究记录、交易计划、研究版本、AI 建议、财务指标计算。
// 原则：研究记录与交易计划只能由用户修改；AI 只能写入 aiSuggestions，由用户决定接受或忽略。
import { db, uid, save, instrument } from './store.js';
import { createAlert } from './alerts.js';

const EMPTY = () => ({
  thesis: '', assumptions: [], questions: [],
  plan: { watchPrice: '', buyLow: '', buyHigh: '', positionPct: '', addCondition: '', reduceCondition: '', stopLoss: '', target: '', validUntil: '' },
  review: '', createdAt: new Date().toISOString(), updatedAt: null,
});

export function getResearch(symbol) {
  return db.research[symbol] || EMPTY();
}

/** 用户保存研究记录。每次保存生成一个版本（含保存原因），用于"之前怎么看 → 现在怎么看"对比。 */
export function saveResearch(symbol, patch, { reason = '用户更新', author = 'user' } = {}) {
  if (author !== 'user') throw Object.assign(new Error('只有用户可以修改研究记录与交易计划'), { status: 403 });
  const cur = db.research[symbol] || EMPTY();
  const next = { ...cur };
  if (patch.thesis !== undefined) next.thesis = String(patch.thesis);
  if (patch.review !== undefined) next.review = String(patch.review);
  if (patch.plan) next.plan = { ...cur.plan, ...patch.plan };
  if (patch.assumptions) {
    next.assumptions = patch.assumptions.map((a) => {
      const old = cur.assumptions.find((x) => x.id === a.id);
      const changed = !old || old.text !== a.text || old.status !== a.status;
      return {
        id: a.id || uid('as_'), text: String(a.text), status: a.status || '待验证',
        createdAt: old?.createdAt || new Date().toISOString(),
        lastCheckedAt: changed || a.checked ? new Date().toISOString() : old.lastCheckedAt,
      };
    });
  }
  if (patch.questions) next.questions = patch.questions.map((q) => ({ id: q.id || uid('q_'), text: String(q.text), resolved: !!q.resolved }));
  next.updatedAt = new Date().toISOString();
  db.research[symbol] = next;
  const { createdAt, ...snapshot } = next;
  db.researchVersions.push({ id: uid('rv_'), symbol, createdAt: next.updatedAt, reason, snapshot: structuredClone(snapshot) });
  save();
  return next;
}

export function versions(symbol) {
  return db.researchVersions.filter((v) => v.symbol === symbol).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 两个版本的字段级差异（之前怎么看 → 现在怎么看）。 */
export function diffVersions(a, b) {
  const out = [];
  const A = a.snapshot; const B = b.snapshot;
  if (A.thesis !== B.thesis) out.push({ field: '投资逻辑', before: A.thesis, after: B.thesis });
  const plan = new Set([...Object.keys(A.plan || {}), ...Object.keys(B.plan || {})]);
  for (const k of plan) if (String(A.plan?.[k] ?? '') !== String(B.plan?.[k] ?? '')) out.push({ field: `交易计划.${PLAN_LABEL[k] || k}`, before: A.plan?.[k], after: B.plan?.[k] });
  const asA = new Map((A.assumptions || []).map((x) => [x.id, x])); const asB = new Map((B.assumptions || []).map((x) => [x.id, x]));
  for (const [id, x] of asB) {
    const o = asA.get(id);
    if (!o) out.push({ field: '核心假设（新增）', before: '', after: x.text });
    else if (o.text !== x.text || o.status !== x.status) out.push({ field: '核心假设', before: `${o.text}【${o.status}】`, after: `${x.text}【${x.status}】` });
  }
  for (const [id, x] of asA) if (!asB.has(id)) out.push({ field: '核心假设（删除）', before: x.text, after: '' });
  if (A.review !== B.review) out.push({ field: '复盘结论', before: A.review, after: B.review });
  return out;
}

export const PLAN_LABEL = { watchPrice: '关注价', buyLow: '买入区间下沿', buyHigh: '买入区间上沿', positionPct: '计划仓位%', addCondition: '加仓条件', reduceCondition: '减仓条件', stopLoss: '止损', target: '目标价', validUntil: '有效期' };

// ---------- AI 建议（不修改用户计划） ----------
export function addSuggestion({ symbol, text, assumptionId = null, evidence = [], source = 'agent' }) {
  const dup = db.aiSuggestions.find((s) => s.symbol === symbol && s.text === text && s.status === 'pending');
  if (dup) return dup;
  const s = { id: uid('sg_'), symbol, text, assumptionId, evidence, source, status: 'pending', createdAt: new Date().toISOString() };
  db.aiSuggestions.unshift(s);
  save();
  return s;
}

export function resolveSuggestion(id, status) {
  const s = db.aiSuggestions.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error('建议不存在'), { status: 404 });
  if (!['accepted', 'dismissed'].includes(status)) throw Object.assign(new Error('非法状态'), { status: 400 });
  s.status = status; s.resolvedAt = new Date().toISOString();
  save();
  return s;
}

// ---------- AI 分析历史版本 ----------
export function addAnalysis({ symbol = null, kind, title, blocks, evidence = [], model = 'local-rules', trigger = 'user' }) {
  const prev = db.aiAnalyses.filter((a) => a.symbol === symbol && a.kind === kind);
  const a = { id: uid('an_'), symbol, kind, title, blocks, evidence, model, trigger, version: prev.length + 1, createdAt: new Date().toISOString() };
  db.aiAnalyses.unshift(a);
  save();
  return a;
}

export function analyses(symbol, kind) {
  return db.aiAnalyses.filter((a) => (!symbol || a.symbol === symbol) && (!kind || a.kind === kind));
}

// ---------- 研究提醒：假设长期未检查 ----------
export function runResearchStaleRule(now = new Date()) {
  const days = db.settings.research.staleDays;
  const created = [];
  for (const [symbol, r] of Object.entries(db.research)) {
    for (const a of r.assumptions || []) {
      const age = (now - new Date(a.lastCheckedAt)) / 86400000;
      if (age < days) continue;
      const al = createAlert({
        type: 'research', symbol, severity: 'low', now, dedupeKey: `research:${symbol}:${a.id}:${a.lastCheckedAt}`,
        title: `${symbol.split(':')[1]} 研究假设已 ${Math.floor(age)} 天未检查：${a.text.slice(0, 16)}`,
        body: `你在 ${a.lastCheckedAt.slice(0, 10)} 记录的假设「${a.text}」已超过 ${days} 天未检查。`,
        data: { assumptionId: a.id },
      });
      if (al) created.push(al);
    }
  }
  return created;
}

// ---------- 财务指标 ----------
export function financialMetrics(symbol) {
  const rows = db.financials[symbol];
  if (!rows) return null;
  const out = rows.map((r, i) => {
    const prevQ = rows[i - 1]; const prevY = rows[i - 4];
    const pct = (a, b) => (b ? +(((a - b) / Math.abs(b)) * 100).toFixed(1) : null);
    return {
      ...r,
      grossMargin: r.revenue && r.grossProfit != null ? +((r.grossProfit / r.revenue) * 100).toFixed(1) : null,
      netMargin: r.revenue && r.netIncome != null ? +((r.netIncome / r.revenue) * 100).toFixed(1) : null,
      revenueYoY: prevY ? pct(r.revenue, prevY.revenue) : null,
      revenueQoQ: prevQ ? pct(r.revenue, prevQ.revenue) : null,
      netIncomeYoY: prevY ? pct(r.netIncome, prevY.netIncome) : null,
      epsYoY: prevY ? pct(r.eps, prevY.eps) : null,
      fcfYoY: prevY ? pct(r.fcf, prevY.fcf) : null,
    };
  });
  const meta = db.financialsMeta?.[symbol];
  return { symbol, currency: meta?.currency || instrument(symbol)?.currency || 'USD', unit: '百万', source: meta?.source || 'Mock 财务数据（演示）', real: !!meta, quarters: out };
}

/** 财报变化：最新季度 vs 上一季度 / 去年同期（确定性部分）。 */
export function earningsChanges(symbol) {
  const m = financialMetrics(symbol);
  if (!m) return null;
  const q = m.quarters; const cur = q[q.length - 1]; const prev = q[q.length - 2];
  return {
    period: cur.period,
    items: [
      { metric: '营收', value: cur.revenue, yoy: cur.revenueYoY, qoq: cur.revenueQoQ },
      { metric: '净利润', value: cur.netIncome, yoy: cur.netIncomeYoY },
      { metric: '自由现金流', value: cur.fcf, yoy: cur.fcfYoY },
      { metric: '毛利率', value: cur.grossMargin, delta: cur.grossMargin != null && prev?.grossMargin != null ? +(cur.grossMargin - prev.grossMargin).toFixed(1) : null, unit: 'pct' },
      { metric: '净利率', value: cur.netMargin, delta: cur.netMargin != null && prev?.netMargin != null ? +(cur.netMargin - prev.netMargin).toFixed(1) : null, unit: 'pct' },
    ],
    guidance: cur.guidance,
  };
}
