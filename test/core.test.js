// 核心业务规则测试：node --test test/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.MOCK_SESSION = 'regular';
process.env.WATCHLIST_FILE = ''; // 测试使用演示自选，不读个人关注列表
let M;

before(async () => {
  const [store, seed, pm, ch, wl, news, research, agent, analysis, discord] = await Promise.all([
    import('../server/store.js'), import('../server/seed.js'), import('../server/rules/priceMove.js'), import('../server/rules/chatHeat.js'),
    import('../server/watchlist.js'), import('../server/news.js'), import('../server/research.js'), import('../server/agent/agent.js'),
    import('../server/agent/analysis.js'), import('../server/connectors/discordLocal.js'),
  ]);
  M = { store, seed, pm, ch, wl, news, research, agent, analysis, discord };
  seed.seed(new Date());
  news.processNews();
});

const cfg = () => ({ threshold: 5, sessions: { pre: false, regular: true, post: false }, sessionThresholds: { pre: 5, regular: 5, post: 5 }, perSymbol: {}, escalateEvery: 5 });
const quote = (o) => ({ id: 'NASDAQ:TEST', last: 105.3, prevClose: 100, session: 'regular', tradeDate: '2026-10-06', ...o });

test('5% 异动：按昨收计算，≥5% 触发', () => {
  assert.equal(M.pm.changePct(105, 100), 5);
  const hit = M.pm.evaluatePriceMove(quote(), cfg());
  assert.equal(hit.direction, 'up');
  assert.equal(hit.pct, 5.3);
  assert.equal(M.pm.evaluatePriceMove(quote({ last: 104.99 }), cfg()), null);
  assert.equal(M.pm.evaluatePriceMove(quote({ last: 95 }), cfg()).direction, 'down');
});

test('5% 异动：盘前盘后默认不启用，可独立配置', () => {
  assert.equal(M.pm.evaluatePriceMove(quote({ session: 'pre' }), cfg()), null);
  assert.equal(M.pm.evaluatePriceMove(quote({ session: 'post' }), cfg()), null);
  const c = cfg(); c.sessions.post = true; c.sessionThresholds.post = 3;
  assert.ok(M.pm.evaluatePriceMove(quote({ session: 'post', last: 103.5 }), c));
});

test('5% 异动：同一交易日同方向只提醒一次，扩大到 10% 再提醒', () => {
  const a = M.pm.evaluatePriceMove(quote({ last: 106 }), cfg());
  const b = M.pm.evaluatePriceMove(quote({ last: 108 }), cfg());
  const c = M.pm.evaluatePriceMove(quote({ last: 111 }), cfg());
  assert.equal(a.dedupeKey, b.dedupeKey);
  assert.notEqual(a.dedupeKey, c.dedupeKey);
});

test('异动规则在演示数据上触发 NVDA，且不重复创建', () => {
  const first = M.pm.runPriceMoveRule();
  assert.ok(first.some((a) => a.symbol === 'NASDAQ:NVDA'));
  assert.equal(M.pm.runPriceMoveRule().length, 0);
});

test('跨群热度：NVDA 6 个群有效讨论触发，TSLA 不足 4 个群不触发', () => {
  const { db } = M.store;
  M.ch.tagMessages();
  const nv = M.ch.symbolStats('NASDAQ:NVDA', db.chatMessages, db.settings.chatHeat);
  const ts = M.ch.symbolStats('NASDAQ:TSLA', db.chatMessages, db.settings.chatHeat);
  assert.ok(nv.effectiveGroupCount >= 4);
  assert.ok(ts.effectiveGroupCount < 4);
  const created = M.ch.runChatHeatRule();
  assert.deepEqual(created.map((a) => a.symbol), ['NASDAQ:NVDA']);
});

test('跨群热度：同一段内容复制到多个群被标记为"信息正在传播"', () => {
  const { db } = M.store;
  const nv = M.ch.symbolStats('NASDAQ:NVDA', db.chatMessages, db.settings.chatHeat);
  assert.equal(nv.spreading.length, 1);
  assert.equal(nv.spreading[0].groups.length, 3);
  assert.ok(nv.independentGroupCount <= nv.effectiveGroupCount);
});

test('跨群热度：有效讨论阈值（≥3 条或 ≥2 人）', () => {
  const now = new Date();
  const mk = (g, u, i) => ({ id: `t${g}${u}${i}`, groupId: g, groupName: g, user: u, time: new Date(now - (5 + i) * 60000).toISOString(), content: `AMD 第${i}条`, symbols: ['NASDAQ:AMD'], hash: `h${g}${i}` });
  const msgs = [mk('a', 'x', 1), mk('a', 'x', 2), mk('a', 'x', 3), mk('b', 'x', 1), mk('b', 'y', 2), mk('c', 'x', 1)];
  const st = M.ch.symbolStats('NASDAQ:AMD', msgs, { windowMinutes: 60, minGroups: 4, minMessagesPerGroup: 3, minUsersPerGroup: 2 }, now);
  assert.equal(st.groupCount, 3);
  assert.equal(st.effectiveGroupCount, 2);
});

test('标的识别：NVDA / Nvidia / 英伟达 统一映射到 NASDAQ:NVDA', async () => {
  const { findMentions } = await import('../server/lib/instruments.js');
  const { db } = M.store;
  for (const t of ['NVDA 涨了', 'Nvidia earnings', '英伟达不错', '$NVDA']) assert.deepEqual(findMentions(t, db.instruments), ['NASDAQ:NVDA']);
  assert.deepEqual(findMentions('fbi news', db.instruments), []);
});

test('TradingView 导入：自动分类、去重、重复导入幂等', () => {
  const text = fs.readFileSync(new URL('../samples/tradingview_watchlist.txt', import.meta.url), 'utf8');
  const r1 = M.wl.importTradingView(text);
  const gold = [...r1.added, ...r1.duplicates].find((a) => a.raw === 'TVC:GOLD');
  assert.equal(gold.symbol, 'OANDA:XAUUSD', 'TVC:GOLD 应映射到现货黄金');
  assert.equal(gold.group, '宏观观察', '宏观资产进入宏观观察列表');
  assert.ok(r1.added.some((a) => a.symbol === 'NASDAQ:AMZN' && a.kind === 'stock'));
  assert.ok(r1.added.some((a) => a.symbol === 'HKEX:700'), 'HKEX:00700 应规范为 HKEX:700');
  assert.ok(r1.duplicates.some((d) => d.symbol === 'NASDAQ:NVDA' && d.reason === '文件内重复'), '文件内重复应去重');
  assert.ok(r1.duplicates.some((d) => d.symbol === 'OANDA:XAUUSD' && d.reason === '已在分组中'), '已有标的应去重');
  assert.ok(r1.groupsCreated.includes('科技股'));
  const r2 = M.wl.importTradingView(text);
  assert.equal(r2.added.length, 0);
  assert.equal(r2.duplicates.length, r1.added.length + r1.duplicates.length);
});

test('新闻流水线：多家媒体报道同一事件被聚合，官方来源优先', () => {
  const { db } = M.store;
  const nv = db.events.find((e) => e.entities.includes('NASDAQ:NVDA') && e.eventType === 'company_deal');
  assert.equal(nv.sourceCount, 4);
  assert.equal(nv.sources[0].sourceType, 'official');
  assert.equal(nv.summary.what.kind, 'fact');
  assert.equal(nv.summary.impact.kind, 'analysis');
  assert.ok(nv.summary.changes.some((c) => c.kind === 'unverified'), '知情人士消息应标为待验证');
  const cpi = db.events.filter((e) => /CPI/.test(e.title));
  assert.equal(cpi.length, 1);
});

test('研究记录：AI 不能修改用户计划，只能提交建议', async () => {
  assert.throws(() => M.research.saveResearch('NASDAQ:NVDA', { thesis: 'x' }, { author: 'agent' }), /只有用户/);
  const before = JSON.stringify(M.store.db.research['NASDAQ:NVDA']);
  const r = await M.analysis.recheckThesis('NASDAQ:NVDA');
  assert.equal(JSON.stringify(M.store.db.research['NASDAQ:NVDA']), before);
  assert.ok(r.suggestions.length >= 1);
});

test('研究版本：保存产生版本，并能对比差异', () => {
  M.research.saveResearch('NASDAQ:NVDA', { plan: { target: 170 } }, { reason: '上调目标价' });
  const vs = M.research.versions('NASDAQ:NVDA');
  const diff = M.research.diffVersions(vs[1], vs[0]);
  assert.ok(diff.some((d) => d.field === '交易计划.目标价' && d.after === 170));
});

test('异动原因分析：无新闻无公告时输出"暂无明确原因"，不编造', async () => {
  const { db } = M.store;
  const q = db.quotes['NASDAQ:GOOGL'];
  const saved = { ...q };
  q.last = q.prevClose * 0.94; q.changePct = -6;
  const peers = ['NASDAQ:META'].map((id) => [id, db.quotes[id].changePct]);
  db.quotes['NASDAQ:META'].changePct = 0.1;
  const calendar = db.calendar; db.calendar = [];
  const r = await M.analysis.explainMove('NASDAQ:GOOGL');
  assert.equal(r.noClearReason, true);
  assert.ok(r.blocks.some((b) => b.text.includes('暂无明确原因')));
  Object.assign(q, saved); db.calendar = calendar; for (const [id, v] of peers) db.quotes[id].changePct = v;
});

test('Agent：识别页面上下文，"为什么今天跌这么多"指向当前标的', async () => {
  const r = await M.agent.ask('为什么今天涨这么多？', { page: 'stock', symbol: 'NASDAQ:NVDA' });
  assert.deepEqual(r.message.resolvedSymbols, ['NASDAQ:NVDA']);
  assert.ok(r.message.toolCalls.some((t) => t.name === 'market_data'));
  assert.ok(r.message.blocks.some((b) => b.kind === 'fact'));
});

test('Agent：继续之前关于 Nvidia 的分析会找回历史会话', async () => {
  const first = await M.agent.ask('分析一下英伟达', {});
  const r = await M.agent.ask('继续之前关于 Nvidia 的分析', {});
  assert.equal(r.sessionId, first.sessionId);
});

test('Discord 连接器：discord-local jsonl 转为标准消息结构', () => {
  const line = JSON.stringify({ time: '2026-10-06 22:30:00', message_id: '42', channel_id: '7', channel_name: '盘中', remark: '美股聚合群/盘中', author: { id: '1', name: 'Alice' }, forwarded: true, content: '', embeds: [{ title: 'NVDA 新高' }], attachments: [] });
  const [m] = M.discord.parseJsonl(`${line}\n{坏行\n`, '', 'Asia/Shanghai');
  assert.equal(m.time, '2026-10-06T14:30:00.000Z');
  assert.equal(m.platform, 'discord');
  assert.equal(m.rawId, '42');
  assert.equal(m.type, 'forward');
  assert.ok(m.content.includes('NVDA 新高'));
  const n1 = M.ch.ingestMessages([m]).length; const n2 = M.ch.ingestMessages([m]).length;
  assert.deepEqual([n1, n2], [1, 0], '按原始消息 ID 去重');
});

test('表格导入：一级/二级分类成为分组，价差表达式按两腿计算', () => {
  const csv = '完整代码,名称,一级,二级,简介\nNASDAQ:NVDA,英伟达,美股,AI算力,GPU\nAMEX:GDX/TVC:GOLD,金矿股/金价,宏观指标,黄金,比价\nNASDAQ:NVDA,英伟达,美股,AI算力,重复\n';
  const { format, rows } = M.wl.parseWatchlistFile('list.csv', Buffer.from(csv));
  assert.equal(format, 'table');
  assert.equal(rows.length, 3);
  const r = M.wl.importTable(rows, { mode: 'merge' });
  assert.ok(r.groupsCreated.includes('美股/AI算力'));
  assert.ok(r.added.some((a) => a.symbol === 'AMEX:GDX/TVC:GOLD' && a.kind === 'macro'));
  assert.ok(r.duplicates.some((d) => d.reason === '文件内重复'));
  const spread = M.store.instrument('AMEX:GDX/TVC:GOLD');
  assert.equal(spread.type, 'spread');
  const q = M.store.db.quotes['AMEX:GDX/TVC:GOLD'];
  assert.ok(q && Number.isFinite(q.last), '价差应由两腿计算出报价');
});

test('xlsx 读取：共享字符串与工作表', async () => {
  const f = new URL('../data/my-watchlist.xlsx', import.meta.url);
  if (!fs.existsSync(f)) return; // 个人文件不在仓库中时跳过
  const { readXlsx } = await import('../server/lib/xlsx.js');
  const sheets = readXlsx(fs.readFileSync(f));
  assert.ok(sheets.length > 0);
  assert.ok(sheets.some((s) => M.wl.rowsFromTable(s.rows).length > 0));
});

test('OpenClaw 回写：带标签文本解析为分块，挂到提醒并还原证据', async () => {
  const { acceptResult } = await import('../server/agent/jobs.js');
  const OpenClaw = await import('../server/agent/openclaw.js');
  const { createAlert } = await import('../server/alerts.js');
  const a = createAlert({ type: 'company', symbol: 'NASDAQ:NVDA', title: '测试提醒', dedupeKey: 'test:openclaw' });
  OpenClaw.rememberEvidence([{ id: 'q:NASDAQ:NVDA', type: 'data', label: '测试行情' }]);
  const r = acceptResult({ kind: 'move_analysis', alert: a.id, text: '## 已确认事件\n- **【事实】** 公告 [证据: q:NASDAQ:NVDA]\n【待验证】群聊传闻' });
  assert.equal(r.attachedTo, a.id);
  assert.equal(r.evidenceResolved, 1);
  const saved = M.store.db.aiAnalyses.find((x) => x.id === r.analysisId);
  assert.equal(saved.model, 'openclaw');
  assert.deepEqual(saved.blocks.map((b) => b.kind), ['h', 'fact', 'unverified']);
  assert.equal(M.store.db.alerts.find((x) => x.id === a.id).analysis.source, 'openclaw');
  assert.throws(() => acceptResult({ kind: 'premarket', text: '  ' }), /结果为空/);
});

test('知识星球：帖子映射为新闻源文章，识别标的并进入事件流', async () => {
  const Z = await import('../server/connectors/zsxq.js');
  const { ingestArticles } = await import('../server/newsFeeds.js');
  const now = new Date();
  const ct = new Date(now.getTime() - 3600e3 + 8 * 3600e3).toISOString().replace('Z', '+0800');
  const rec = { topic_id: '123456', group_id: '48885454415828', group_name: '404K Semi-Ai', create_time: ct, title: '英伟达...', text: '英伟达下一代AI机柜采用新材料。\n\n详见附件。', tags: ['算力'], author: '测试', files: [{ name: '英伟达PTFE战略.pdf', size: 1, file_id: '9' }] };
  const [a] = Z.parseJsonl(`${JSON.stringify(rec)}\n{坏行\n`);
  assert.equal(a.id, 'a_zsxq123456');
  assert.equal(a.feed, 'zsxq');
  assert.equal(a.title, '英伟达下一代AI机柜采用新材料。');
  assert.equal(a.publishedAt, new Date(now.getTime() - 3600e3).toISOString().replace(/\.\d{3}Z$/, (m) => m));
  assert.match(a.lead, /附件：英伟达PTFE战略\.pdf/);
  assert.ok(a.symbols.includes('NASDAQ:NVDA'));
  assert.equal(ingestArticles([a], now), 1);
  assert.equal(ingestArticles([a], now), 0); // 按 url 去重
  M.news.processNews(now);
  const ev = M.news.searchNews({ symbol: 'NASDAQ:NVDA', limit: 100 }).find((e) => e.sources.some((s) => s.id === a.id));
  assert.ok(ev, '帖子应出现在标的事件流中');
  assert.equal(ev.sources.find((s) => s.id === a.id).source, '知识星球·404K Semi-Ai');
  // 券商作为观点出处不关联标的；券商自身的经营消息照常识别
  assert.equal(Z.stripBrokerCites('摩根大通测算DRAM涨价').includes('摩根大通'), false);
  assert.equal(Z.stripBrokerCites('摩根大通（J.P. Morgan）在报告中指出').includes('摩根大通'), false);
  assert.ok(Z.stripBrokerCites('摩根大通第三季度净利润增长').includes('摩根大通'));
  const [cite] = Z.parseJsonl(JSON.stringify({ ...rec, topic_id: '7', text: '摩根大通测算，英伟达下季度营收超预期。' }));
  assert.ok(cite.symbolsOnly && !cite.symbols.includes('NYSE:JPM') && cite.symbols.includes('NASDAQ:NVDA'));
});
