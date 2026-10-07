// 群聊统计 + 跨群热度规则（确定性计算）。
// 规则：滚动窗口（默认 60 分钟）内，同一标的被 ≥4 个不同群"有效讨论"时触发。
// 有效讨论：单群 ≥3 条相关消息，或 ≥2 名独立用户参与（阈值可配置）。
// 重复内容识别：同一段内容被复制到多个群时标记"信息正在传播"，不视为独立共识。
import crypto from 'node:crypto';
import { db, instrument } from '../store.js';
import { findMentions } from '../lib/instruments.js';
import { createAlert } from '../alerts.js';

const BULL = ['看多', '买入', '加仓', '强劲', '超预期', '利好', '起飞', '突破', '继续拿', 'breaking out', 'strong', 'bullish', 'insane'];
const BEAR = ['看空', '估值过高', '估值压力', '减仓', '风险', '利空', '泡沫', '别追', '失望', '不及预期', 'stretched', 'careful', 'miss', 'bearish', '跌了'];
const UNVERIFIED = ['听说', '传闻', '据说', '小道', '不知道真假', 'rumor'];
const TOPICS = {
  '新产品发布': ['新产品', '发布', 'blackwell', 'rubin', 'new product', '发布会'],
  '数据中心需求': ['数据中心', 'data center', 'capex', '订单', '云厂商'],
  '估值': ['估值', 'pe', 'valuation', '追高'],
  '财报与指引': ['财报', '指引', 'guide', '毛利率', 'gross margin'],
  '交付与销量': ['交付', 'delivery', '销量'],
  '监管': ['监管', '调查', '欧盟', '出口管制'],
  '宏观利率': ['cpi', '降息', '收益率', '美元'],
};

export function normalizeContent(text) {
  return String(text).toLowerCase().replace(/^【转】/, '').replace(/[\s\p{P}\p{S}]/gu, '');
}
export function contentHash(text) {
  return crypto.createHash('sha1').update(normalizeContent(text)).digest('hex').slice(0, 12);
}

/** 为消息打上标的标签（实体识别结果缓存在消息上）。 */
export function tagMessages(messages = db.chatMessages) {
  for (const m of messages) {
    if (!m.symbols) m.symbols = findMentions(m.content, db.instruments);
    if (!m.hash) m.hash = contentHash(m.content);
  }
  return messages;
}

// ---------- 用户的群聊视图：来源合并 + 屏蔽 ----------
// 来源（source）：把属于同一个博主/分类的多个频道合并成一个"群"来看，跨群热度里也只算一个群。
// 屏蔽：hiddenGroups 为不想看的频道，hiddenUsers 为不想看的发言人（按昵称）。
// Discord 的频道分类不在 discord-local 的消息里，所以来源由用户在"群聊洞察"页手动归组。
const DEFAULT_SOURCES = [
  { id: 'guigu', name: '硅谷照见', channels: ['美股聚合群/会员群', '美股聚合群/禁言群'] },
  { id: 'maojie', name: '猫姐', channels: ['猫姐盘中总结', '美股聚合群/猫姐聊天区', '美股聚合群/禅动买卖点指标base测试区'] },
  { id: 'tiange', name: '天哥复利之道', channels: ['天道复利之道', '美股聚合群/会员聊天区'] },
];

export function chatView() {
  if (!db.settings.chatView) {
    const idOf = (name) => db.chatGroups.find((g) => g.name === name)?.id;
    db.settings.chatView = {
      sources: DEFAULT_SOURCES.map((s) => ({ id: s.id, name: s.name, groupIds: s.channels.map(idOf).filter(Boolean) })),
      hiddenGroups: [], hiddenUsers: [],
    };
  }
  return db.settings.chatView;
}

/** 应用视图后的消息（副本）：去掉屏蔽的频道和人；同一来源的频道合并为一个群，原频道保留在 channel / channelId。 */
export function visibleMessages(list = db.chatMessages) {
  tagMessages(list);
  const v = chatView();
  const hg = new Set(v.hiddenGroups); const hu = new Set(v.hiddenUsers);
  const src = new Map();
  for (const s of v.sources) for (const g of s.groupIds) src.set(g, s);
  return list.filter((m) => !hg.has(m.groupId) && !hu.has(m.user)).map((m) => {
    const s = src.get(m.groupId);
    return s ? { ...m, groupId: `src:${s.id}`, groupName: s.name, channel: m.groupName, channelId: m.groupId } : m;
  });
}

function inWindow(messages, start, end) {
  return messages.filter((m) => m.time >= start && m.time < end);
}

function sentiment(text) {
  const t = text.toLowerCase();
  const bull = BULL.some((k) => t.includes(k));
  const bear = BEAR.some((k) => t.includes(k));
  return bull && !bear ? 'bull' : bear && !bull ? 'bear' : bull && bear ? 'mixed' : 'neutral';
}

/**
 * 计算某个标的在窗口内的跨群统计（纯函数，可单测）。
 */
export function symbolStats(symbol, messages, cfg, now = new Date()) {
  const end = now.toISOString();
  const start = new Date(now.getTime() - cfg.windowMinutes * 60000).toISOString();
  const prevStart = new Date(now.getTime() - 2 * cfg.windowMinutes * 60000).toISOString();
  const rel = inWindow(messages, start, end).filter((m) => m.symbols.includes(symbol));
  const prev = inWindow(messages, prevStart, start).filter((m) => m.symbols.includes(symbol));

  // 重复内容：同一 hash 出现在 ≥2 个群（且内容足够长，排除"666"之类）
  const hashGroups = new Map();
  for (const m of rel) {
    if (normalizeContent(m.content).length < 15) continue;
    if (!hashGroups.has(m.hash)) hashGroups.set(m.hash, new Set());
    hashGroups.get(m.hash).add(m.groupId);
  }
  const spreadHashes = new Set([...hashGroups].filter(([, g]) => g.size >= 2).map(([h]) => h));

  const byGroup = new Map();
  for (const m of rel) {
    if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, { groupId: m.groupId, groupName: m.groupName, platform: m.platform, messages: [], users: new Set(), original: [], originalUsers: new Set() });
    const g = byGroup.get(m.groupId);
    g.messages.push(m); g.users.add(m.user);
    if (!spreadHashes.has(m.hash)) { g.original.push(m); g.originalUsers.add(m.user); }
  }
  const effective = (msgs, users) => msgs >= cfg.minMessagesPerGroup || users >= cfg.minUsersPerGroup;
  const groups = [...byGroup.values()].map((g) => ({
    groupId: g.groupId, groupName: g.groupName, platform: g.platform,
    messages: g.messages.length, users: g.users.size,
    effective: effective(g.messages.length, g.users.size),
    // 剔除转发的重复内容后，是否仍然构成有效讨论（衡量"独立讨论"）
    independent: effective(g.original.length, g.originalUsers.size),
  }));
  const effectiveGroups = groups.filter((g) => g.effective);
  const independentGroups = groups.filter((g) => g.independent);

  const topics = {};
  const bull = []; const bear = []; const unverified = [];
  for (const m of rel) {
    const t = m.content.toLowerCase();
    for (const [topic, keys] of Object.entries(TOPICS)) if (keys.some((k) => t.includes(k))) topics[topic] = (topics[topic] || 0) + 1;
    const s = sentiment(m.content);
    if (s === 'bull') bull.push(m); else if (s === 'bear') bear.push(m);
    if (UNVERIFIED.some((k) => t.includes(k))) unverified.push(m);
  }
  const users = new Set(rel.map((m) => `${m.groupId}|${m.user}`));
  const heatChangePct = prev.length ? Math.round(((rel.length - prev.length) / prev.length) * 100) : (rel.length ? null : 0);
  return {
    symbol, windowMinutes: cfg.windowMinutes, start, end,
    groupCount: groups.length, effectiveGroupCount: effectiveGroups.length, independentGroupCount: independentGroups.length,
    userCount: users.size, messageCount: rel.length, prevMessageCount: prev.length, heatChangePct,
    groups,
    spreading: [...spreadHashes].map((h) => ({ hash: h, groups: [...hashGroups.get(h)], sample: rel.find((m) => m.hash === h).content })),
    topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    bull: bull.slice(0, 5).map(evidence), bear: bear.slice(0, 5).map(evidence), unverified: unverified.slice(0, 5).map(evidence),
    messageIds: rel.map((m) => m.id),
  };
}

function evidence(m) { return { id: m.id, groupName: m.groupName, user: m.user, time: m.time, content: m.content }; }

/** 窗口内所有被讨论标的的排行（大屏"群聊洞察"）。 */
export function hotSymbols(now = new Date(), cfg = db.settings.chatHeat) {
  const msgs = visibleMessages();
  const start = new Date(now.getTime() - cfg.windowMinutes * 60000).toISOString();
  const syms = new Set();
  for (const m of msgs) if (m.time >= start) m.symbols.forEach((s) => syms.add(s));
  return [...syms].map((s) => symbolStats(s, msgs, cfg, now))
    .sort((a, b) => b.effectiveGroupCount - a.effectiveGroupCount || b.messageCount - a.messageCount);
}

/** 规则：触发跨群热度提醒。 */
export function runChatHeatRule(now = new Date()) {
  const cfg = db.settings.chatHeat;
  const created = [];
  for (const st of hotSymbols(now, cfg)) {
    if (st.effectiveGroupCount < cfg.minGroups) continue;
    const bucket = Math.floor(now.getTime() / (cfg.cooldownMinutes * 60000));
    const inst = instrument(st.symbol);
    const code = st.symbol.split(':')[1];
    const a = createAlert({
      type: 'chat', symbol: st.symbol, severity: 'medium', now, dedupeKey: `chat:${st.symbol}:${bucket}`,
      title: `${code} 跨群讨论热度上升`,
      body: `最近 ${cfg.windowMinutes} 分钟：涉及群 ${st.effectiveGroupCount} 个，讨论人数 ${st.userCount} 人，相关消息 ${st.messageCount} 条${st.heatChangePct != null ? `，热度变化 ${st.heatChangePct >= 0 ? '+' : ''}${st.heatChangePct}%` : ''}。`
        + (st.spreading.length ? `其中有内容被复制到 ${Math.max(...st.spreading.map((s) => s.groups.length))} 个群：信息正在传播，不代表多个群形成独立共识。` : ''),
      data: { stats: st, name: inst?.name, disclaimer: '群聊热度仅代表关注度，不代表投资建议或买卖信号。' },
    });
    if (a) created.push(a);
  }
  return created;
}

export function searchChats({ query, symbol, groupId, since, limit = 30 } = {}) {
  let list = visibleMessages();
  if (symbol) list = list.filter((m) => m.symbols.includes(symbol));
  if (groupId) list = list.filter((m) => m.groupId === groupId || m.channelId === groupId);
  if (since) list = list.filter((m) => m.time >= since);
  if (query) {
    const ms = findMentions(query, db.instruments);
    const q = query.toLowerCase();
    list = list.filter((m) => m.content.toLowerCase().includes(q) || ms.some((s) => m.symbols.includes(s)));
  }
  return [...list].sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
}

/** 群摘要的确定性部分（主题、热门标的、观点、未证实消息），由 Agent 进一步生成文字摘要。 */
export function groupDigest({ groupId, minutes = 60, now = new Date() }) {
  const all = visibleMessages();
  const start = new Date(now.getTime() - minutes * 60000).toISOString();
  const msgs = all.filter((m) => m.time >= start && (!groupId || m.groupId === groupId || m.channelId === groupId));
  const symCount = {};
  for (const m of msgs) for (const s of m.symbols) symCount[s] = (symCount[s] || 0) + 1;
  const cfg = { ...db.settings.chatHeat, windowMinutes: minutes };
  const hot = Object.entries(symCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([symbol, count]) => ({ symbol, count, stats: symbolStats(symbol, groupId ? msgs : all, cfg, now) }));
  return { groupId: groupId || 'all', minutes, messageCount: msgs.length, hot };
}

export function ingestMessages(list, source = 'import') {
  // Connector / Adapter 层统一转成标准结构后写入；OpenClaw 只读取标准结构。
  const out = [];
  for (const raw of list) {
    const m = {
      id: 'm_' + crypto.randomBytes(5).toString('hex'),
      groupId: String(raw.groupId), groupName: raw.groupName || String(raw.groupId), user: String(raw.user),
      time: new Date(raw.time).toISOString(), content: String(raw.content), type: raw.type || 'text',
      rawId: String(raw.rawId ?? ''), platform: raw.platform || source,
    };
    if (m.rawId && db.chatMessages.some((x) => x.platform === m.platform && x.rawId === m.rawId)) continue; // 原始消息 ID 去重
    if (!db.chatGroups.some((g) => g.id === m.groupId)) db.chatGroups.push({ id: m.groupId, name: m.groupName, platform: m.platform, ingest: source });
    out.push(m);
  }
  db.chatMessages.push(...tagMessages(out));
  db.chatMessages.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}
