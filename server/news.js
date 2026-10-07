// 新闻处理流水线：采集 → 去重 → 事件聚合 → 实体识别 → 标的关联 → 摘要 → 重要性排序
// 摘要严格区分"事实"（来自原文 / 官方）与"AI 推断"（规则或模型生成）。
import { db, uid } from './store.js';
import { findMentions } from './lib/instruments.js';
import { watchedSymbols } from './watchlist.js';

const EVENT_WEIGHT = { macro_data: 0.9, central_bank: 0.85, company_deal: 0.8, company_operating: 0.75, earnings: 0.9, regulation: 0.65, commodity_supply: 0.7, product: 0.5, other: 0.4 };

// 事件类型 → 可能影响的资产（AI 推断模板，仅在没有大模型时使用，明确标记为推断）
const IMPACT_HINTS = {
  macro_data: (ev) => ev.title.includes('CPI') && /低于|回落/.test(ev.title)
    ? '通胀低于预期通常强化降息预期：可能压低美债收益率与美元，利好黄金与成长股估值。'
    : '宏观数据偏离预期可能影响利率预期，进而影响美元、美债与权益资产。',
  central_bank: () => '央行表态可能改变市场对利率路径的定价，影响美债收益率、美元与成长股估值。',
  company_deal: () => '大额合作可能提升市场对相关公司未来收入的预期，并带动产业链上下游情绪。',
  company_operating: (ev) => /不及|低于|miss/i.test(ev.allText) ? '经营数据低于预期可能导致市场下调盈利预测。' : /超预期|大增|beat/i.test(ev.allText) ? '经营数据强劲，可能推动市场上调盈利预测。' : '经营数据变化可能影响市场对未来盈利的预期，方向需结合一致预期判断。',
  regulation: () => '监管调查结果存在不确定性，短期更多影响情绪，长期影响取决于处罚与整改要求。',
  commodity_supply: () => '供给增加通常对油价形成压力，可能影响能源股与通胀预期。',
  product: () => '新产品发布对估值的影响取决于商业化进度，短期影响通常有限。',
};

function tokens(text) {
  const t = String(text).toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]+/g) || []) if (w.length > 1) out.add(w);
  const cjk = t.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  return out;
}

const COMMON_ACR = new Set(['AI', 'US', 'CEO', 'GPU', 'EU', 'UK']);
function acronyms(text) {
  return new Set((String(text).match(/\b[A-Z]{2,6}\+?/g) || []).filter((x) => !COMMON_ACR.has(x)));
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** 运行完整流水线，重建 db.events。返回新增的事件。 */
export function processNews(now = new Date()) {
  const before = new Set(db.events.map((e) => e.key));
  // 1. 去重：同 URL 或同标题视为同一篇
  const seen = new Set();
  const articles = [];
  for (const a of [...db.articles].sort((x, y) => x.publishedAt.localeCompare(y.publishedAt))) {
    const k = a.url || a.title;
    if (seen.has(k) || seen.has(a.title)) continue;
    seen.add(k); seen.add(a.title);
    a.entities = findMentions(`${a.title} ${a.lead}`, db.instruments);
    a._tok = tokens(`${a.title} ${a.lead}`);
    a._acr = acronyms(`${a.title} ${a.lead}`);
    articles.push(a);
  }
  // 2. 事件聚合：同类型 + 时间接近（12h）+ 文本相似或实体重合
  const clusters = [];
  for (const a of articles) {
    const t = new Date(a.publishedAt).getTime();
    let best = null; let bestScore = 0;
    for (const c of clusters) {
      if (c.eventType !== a.eventType) continue;
      if (Math.abs(t - c.t) > 12 * 3600e3) continue;
      const sim = jaccard(a._tok, c.tok);
      const ent = a.entities.length && a.entities.some((e) => c.entities.has(e)) ? 0.25 : 0;
      const acr = [...a._acr].some((x) => c.acr.has(x)) ? 0.25 : 0; // 共同的专有缩写（CPI、OPEC 等）
      const score = sim + ent + acr;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    if (best && bestScore >= 0.25) {
      best.articles.push(a);
      for (const e of a.entities) best.entities.add(e);
      for (const x of a._tok) best.tok.add(x);
      for (const x of a._acr) best.acr.add(x);
    } else {
      clusters.push({ eventType: a.eventType || 'other', t, tok: new Set(a._tok), acr: new Set(a._acr), entities: new Set(a.entities), articles: [a] });
    }
  }
  // 3. 生成事件 + 摘要 + 重要性
  const watched = new Set(watchedSymbols());
  db.events = clusters.map((c) => buildEvent(c, watched, now)).sort((a, b) => b.importance - a.importance);
  for (const a of db.articles) { delete a._tok; delete a._acr; }
  return db.events.filter((e) => !before.has(e.key));
}

function buildEvent(c, watched, now) {
  // 官方来源优先作为"发生了什么"的依据
  const sorted = [...c.articles].sort((a, b) => (a.sourceType === 'official' ? -1 : 0) - (b.sourceType === 'official' ? -1 : 0) || a.publishedAt.localeCompare(b.publishedAt));
  const primary = sorted[0];
  const facts = [...new Set(c.articles.flatMap((a) => a.facts || []))];
  const entities = [...c.entities];
  const latest = c.articles.reduce((m, a) => (a.publishedAt > m ? a.publishedAt : m), primary.publishedAt);
  const ageH = (now - new Date(latest)) / 3600e3;
  const recency = Math.exp(-ageH / 12);
  const impact = Math.min(1, (EVENT_WEIGHT[c.eventType] ?? 0.4) + (c.articles.some((a) => a.sourceType === 'official') ? 0.05 : 0) + Math.min(0.15, (c.articles.length - 1) * 0.05));
  const relevance = entities.some((e) => watched.has(e)) ? 1 : entities.length ? 0.4 : 0.2;
  const importance = +(0.35 * recency + 0.35 * impact + 0.3 * relevance).toFixed(3);
  const ev = {
    id: 'ev_' + primary.id.slice(2),
    key: primary.id,
    title: primary.title,
    lead: primary.lead,
    eventType: c.eventType,
    firstSeen: c.articles.reduce((m, a) => (a.publishedAt < m ? a.publishedAt : m), primary.publishedAt),
    latest,
    entities,
    watchedEntities: entities.filter((e) => watched.has(e)),
    importance,
    importanceParts: { recency: +recency.toFixed(2), impact: +impact.toFixed(2), relevance },
    sourceCount: c.articles.length,
    hasOfficial: c.articles.some((a) => a.sourceType === 'official'),
    sources: sorted.map((a) => ({ id: a.id, source: a.source, sourceType: a.sourceType, title: a.title, url: a.url, publishedAt: a.publishedAt })),
  };
  ev.allText = c.articles.map((a) => `${a.title} ${a.lead}`).join(' ');
  ev.summary = {
    what: { kind: 'fact', text: primary.lead, basis: primary.source },
    changes: facts.map((f) => ({ kind: /知情人士|未经/.test(f) ? 'unverified' : 'fact', text: f })),
    assets: entities,
    impact: { kind: 'analysis', text: IMPACT_HINTS[c.eventType]?.(ev) || '影响暂不明确。', by: 'rule' },
    sources: ev.sources.map((s) => `${s.source}（${s.sourceType === 'official' ? '官方' : '媒体'}）`),
  };
  delete ev.allText;
  return ev;
}

export function searchNews({ query, symbol, since, limit = 10 } = {}) {
  let list = db.events;
  if (symbol) list = list.filter((e) => e.entities.includes(symbol));
  if (since) list = list.filter((e) => e.latest >= since);
  if (query) {
    const q = tokens(query);
    const mentioned = findMentions(query, db.instruments);
    list = list
      .map((e) => ({ e, s: jaccard(q, tokens(`${e.title} ${e.lead}`)) + (mentioned.some((m) => e.entities.includes(m)) ? 0.5 : 0) }))
      .filter((x) => x.s > 0.02).sort((a, b) => b.s - a.s).map((x) => x.e);
  }
  return list.slice(0, limit);
}

/** 生成每日简报（确定性部分），由 Agent 定时任务调用。 */
export function dailyBrief(now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const top = db.events.filter((e) => e.latest >= since).slice(0, 6);
  return {
    id: uid('b_'), createdAt: now.toISOString(), title: `每日投资事件简报 · ${now.toISOString().slice(0, 10)}`,
    items: top.map((e) => ({ eventId: e.id, title: e.title, importance: e.importance, assets: e.entities, fact: e.summary.what.text, analysis: e.summary.impact.text })),
  };
}
