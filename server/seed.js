// 演示数据（Mock）。所有时间相对于启动时刻生成，保证每次启动都"像今天"。
// 新闻链接统一使用 example.com 占位，明确标记为演示数据，避免与真实报道混淆。
import { db, uid } from './store.js';
import { allSeedInstruments } from './lib/instruments.js';
import { seedInstrument } from './providers/market.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseWatchlistFile, importTable } from './watchlist.js';

// 你的关注列表：存在时启动用它替换演示自选（文件只在本地，不进 git）
export const WATCHLIST_FILE = process.env.WATCHLIST_FILE ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/my-watchlist.xlsx');
// 顶部宏观条默认展示的核心资产（存在于列表中时置顶）
const MACRO_CORE = ['OANDA:XAUUSD', 'TVC:SILVER', 'OANDA:XAGUSD', 'ICMARKETS:XTIUSD', 'NYMEX:CL1!', 'TVC:DXY', 'TVC:US10Y', 'FX:SPX500', 'SP:SPX', 'NASDAQ:NDX', 'NASDAQ:IXIC', 'TVC:VIX', 'TVC:HSI', 'HSI:HSI', 'OANDA:USDCNH', 'FX_IDC:USDCNH', 'COMEX:HG1!'];

const ago = (now, min) => new Date(now.getTime() - min * 60000).toISOString();
const later = (now, min) => new Date(now.getTime() + min * 60000).toISOString();
const daysAgo = (now, d) => new Date(now.getTime() - d * 86400000).toISOString();

export function seed(now = new Date()) {
  db.instruments = allSeedInstruments();
  db.settings = defaultSettings();
  for (const inst of db.instruments) seedInstrument(inst.id, now);

  db.watchlist = {
    groups: [
      { id: 'g_macro', name: '宏观观察', kind: 'macro', category: '宏观', items: ['OANDA:XAUUSD', 'COMEX:GC1!', 'OANDA:XAGUSD', 'NYMEX:CL1!', 'ICEEUR:BRN1!', 'TVC:DXY', 'TVC:US10Y', 'SP:SPX', 'NASDAQ:IXIC', 'DJ:DJI', 'SSE:000001', 'HSI:HSI', 'FX_IDC:USDCNH'].map(item) },
      { id: 'g_core', name: '核心持仓', kind: 'stock', category: '演示', items: ['NASDAQ:NVDA', 'NASDAQ:AAPL', 'NASDAQ:TSLA', 'NASDAQ:META', 'NASDAQ:GOOGL'].map(item) },
      { id: 'g_ai', name: 'AI 产业链', kind: 'stock', category: '演示', items: ['NASDAQ:NVDA', 'NYSE:TSM', 'NASDAQ:AMD', 'NASDAQ:MSFT'].map(item) },
      { id: 'g_cnhk', name: 'A 股 / 港股', kind: 'stock', category: '演示', items: ['SSE:600519', 'HKEX:700', 'HKEX:9988'].map(item) },
    ],
  };
  db.watchlist.groups[1].items[0].pinned = true;
  for (const it of db.watchlist.groups[0].items) it.pinned = MACRO_CORE.includes(it.symbol);
  loadUserWatchlist();

  db.articles = seedArticles(now);
  db.calendar = seedCalendar(now);
  db.filings = seedFilings(now);
  db.financials = seedFinancials();
  db.chatGroups = [
    { id: 'wx_1', name: '美股价值投资交流', platform: 'wechat', ingest: 'import' },
    { id: 'wx_2', name: '科技股研究小组', platform: 'wechat', ingest: 'import' },
    { id: 'tg_1', name: 'US Tech Traders', platform: 'telegram', ingest: 'bot' },
    { id: 'tg_2', name: 'AI 产业链跟踪', platform: 'telegram', ingest: 'bot' },
    { id: 'dc_1', name: 'Semis Deep Dive', platform: 'discord', ingest: 'api' },
    { id: 'wx_3', name: '港美股实盘群', platform: 'wechat', ingest: 'import' },
    { id: 'wx_4', name: '宏观与大类资产', platform: 'wechat', ingest: 'import' },
  ];
  db.chatMessages = seedChats(now);
  db.research = seedResearch(now);
  db.researchVersions = [];
  db.aiAnalyses = [];
  db.aiSuggestions = [];
  db.alerts = [];
  db.agentSessions = [];
  db.briefs = [];
  db.jobRuns = [];
  db.events = [];
  db.companyProfiles = {};
  // 初始研究版本
  for (const [sym, r] of Object.entries(db.research)) {
    db.researchVersions.push({ id: uid('rv_'), symbol: sym, createdAt: r.createdAt, reason: '初始记录', snapshot: structuredClone(stripMeta(r)) });
  }
}

export function loadUserWatchlist(file = WATCHLIST_FILE) {
  if (!file || !fs.existsSync(file)) return null;
  const parsed = parseWatchlistFile(file, fs.readFileSync(file));
  if (parsed.format !== 'table' || !parsed.rows.length) return null;
  const report = importTable(parsed.rows, { mode: 'replace' });
  for (const g of db.watchlist.groups) if (g.kind === 'macro') for (const it of g.items) it.pinned = MACRO_CORE.includes(it.symbol);
  console.log(`[seed] 已从 ${path.basename(file)} 导入关注列表：${report.added.length} 个标的，${db.watchlist.groups.length} 个分组`);
  return report;
}

function stripMeta(r) { const { createdAt, ...rest } = r; return rest; }

function item(symbol, i) { return { symbol, pinned: false, order: i, addedAt: new Date().toISOString() }; }

export function defaultSettings() {
  return {
    priceMove: {
      threshold: 5,                       // 涨跌幅绝对值 ≥ 5%
      sessions: { pre: false, regular: true, post: false },
      sessionThresholds: { pre: 5, regular: 5, post: 5 },
      perSymbol: {},                      // { 'NASDAQ:NVDA': 4 }
      escalateEvery: 5,                   // 每再扩大 5 个百分点再提醒一次（5%、10%、15%…）
    },
    volume: { ratio: 2.0 },               // 成交量 ≥ 20 日均量 × 2（按交易时段进度折算）
    chatHeat: {
      windowMinutes: 60,
      minGroups: 4,                       // 至少 4 个不同群有效讨论
      minMessagesPerGroup: 3,             // 单群 ≥3 条相关消息
      minUsersPerGroup: 2,                // 或 ≥2 名独立用户
      cooldownMinutes: 60,
    },
    research: { staleDays: 30 },
    news: { majorImportance: 0.75 },
  };
}

function seedArticles(now) {
  const A = (min, source, sourceType, title, lead, extra = {}) => ({
    id: uid('a_'), publishedAt: ago(now, min), source, sourceType, title, lead,
    url: `https://example.com/mock/${encodeURIComponent(source)}/${Math.round(min)}`, ...extra,
  });
  return [
    // 事件 1：英伟达与大型云厂商扩大合作（官方 + 多家媒体，应聚合为同一事件）
    A(95, 'NVIDIA 官方新闻稿', 'official', '英伟达宣布与微软扩大 AI 数据中心合作，追加下一代 GPU 供货协议', '英伟达表示，微软将在未来两个财年扩大采购其下一代数据中心 GPU，合作覆盖 Azure 多个区域。', { eventType: 'company_deal', facts: ['双方签署扩大供货协议', '公司未披露协议金额'] }),
    A(80, 'Reuters', 'media', '英伟达与微软扩大数据中心 GPU 合作，股价盘中走高', '路透报道，英伟达与微软扩大 AI 数据中心合作，协议金额未披露。', { eventType: 'company_deal' }),
    A(72, 'Bloomberg', 'media', '微软扩大采购英伟达下一代 GPU，数据中心资本开支继续上调', '彭博援引知情人士称，微软本财年数据中心资本开支计划可能进一步上调。', { eventType: 'company_deal', facts: ['知情人士称微软资本开支可能上调（未经公司确认）'] }),
    A(60, 'CNBC', 'media', 'Nvidia shares jump after expanded Microsoft data center GPU deal', 'Nvidia shares rose more than 5% after the company announced an expanded GPU supply deal with Microsoft.', { eventType: 'company_deal' }),
    // 事件 2：美国 CPI 低于预期
    A(150, '美国劳工统计局 BLS', 'official', '美国 9 月 CPI 同比 2.3%，低于市场预期的 2.5%', '美国劳工统计局公布 9 月 CPI 同比上涨 2.3%，核心 CPI 同比 3.1%。', { eventType: 'macro_data', facts: ['CPI 同比 2.3%，预期 2.5%，前值 2.5%', '核心 CPI 同比 3.1%，预期 3.2%'] }),
    A(140, 'Reuters', 'media', '美国 9 月 CPI 低于预期，交易员加大降息押注', '数据公布后，美债收益率下行，美元走弱，金价上涨。', { eventType: 'macro_data' }),
    A(130, '华尔街见闻', 'media', '美国 CPI 超预期回落，黄金突破前高', 'CPI 公布后现货黄金快速拉升，美元指数走低。', { eventType: 'macro_data' }),
    // 事件 3：OPEC+ 增产
    A(300, 'Reuters', 'media', 'OPEC+ 同意自 12 月起小幅增产，油价下跌', 'OPEC+ 部长级会议同意自 12 月起每日增产 18 万桶。', { eventType: 'commodity_supply', facts: ['OPEC+ 12 月起日增产 18 万桶'] }),
    A(280, 'FT', 'media', 'OPEC+ 增产计划超出部分分析师预期，布伦特原油跌近 2%', '部分分析师此前预计增产将推迟。', { eventType: 'commodity_supply' }),
    // 事件 4：特斯拉交付
    A(600, 'Tesla 投资者关系', 'official', '特斯拉公布三季度交付量 46.2 万辆', '特斯拉三季度共交付 46.2 万辆汽车，市场预期约 47 万辆。', { eventType: 'company_operating', facts: ['三季度交付 46.2 万辆，预期约 47 万辆'] }),
    A(560, 'Bloomberg', 'media', 'Tesla deliveries miss estimates as competition intensifies', 'Tesla delivered 462,000 vehicles in the third quarter, below analyst estimates.', { eventType: 'company_operating' }),
    // 事件 5：苹果欧盟
    A(420, 'WSJ', 'media', '欧盟就应用商店规则对苹果展开新一轮调查', '欧盟委员会表示将评估苹果应用商店条款是否符合数字市场法。', { eventType: 'regulation', facts: ['欧盟委员会宣布启动评估'] }),
    // 事件 6：中国 PMI
    A(900, '国家统计局', 'official', '9 月制造业 PMI 为 49.8，环比回升 0.7 个百分点', '国家统计局数据显示，9 月制造业 PMI 49.8，仍处收缩区间。', { eventType: 'macro_data', facts: ['制造业 PMI 49.8，前值 49.1'] }),
    // 事件 7：台积电月营收
    A(240, '台积电官网', 'official', '台积电 9 月营收同比增长 39.6%', '台积电公布 9 月合并营收同比增长 39.6%，环比增长 2.1%。', { eventType: 'company_operating', facts: ['9 月营收同比 +39.6%，环比 +2.1%'] }),
    A(225, '财新', 'media', '台积电 9 月营收同比大增近四成，AI 需求强劲', '分析认为 AI 加速器需求仍是主要增长来源。', { eventType: 'company_operating' }),
    // 事件 8：美联储官员讲话
    A(50, '美联储官网', 'official', '美联储理事讲话：通胀进展令人鼓舞，政策将保持灵活', '理事在讲话中表示，近期通胀数据显示进一步改善。', { eventType: 'central_bank', facts: ['理事称通胀进展令人鼓舞'] }),
    // 事件 9：Meta
    A(1300, 'CNBC', 'media', 'Meta 发布新一代 AR 眼镜原型', 'Meta 在年度开发者大会上展示新一代 AR 眼镜原型。', { eventType: 'product' }),
  ];
}

function seedCalendar(now) {
  const C = (min, country, event, importance, previous, forecast, actual, unit = '%') => ({
    id: uid('c_'), time: min >= 0 ? later(now, min) : ago(now, -min), country, event, importance, previous, forecast, actual, unit,
  });
  return [
    C(-150, '美国', '9 月 CPI 同比', 3, 2.5, 2.5, 2.3),
    C(-150, '美国', '9 月核心 CPI 同比', 3, 3.2, 3.2, 3.1),
    C(-900, '中国', '9 月官方制造业 PMI', 2, 49.1, 49.4, 49.8, ''),
    C(-4320, '美国', '9 月非农就业人数', 3, 159, 140, 254, '千人'),
    C(180, '美国', '初请失业金人数', 2, 225, 230, null, '千人'),
    C(1260, '美国', '9 月 PPI 同比', 2, 1.7, 1.6, null),
    C(1440 * 2, '欧元区', '欧洲央行利率决议', 3, 3.5, 3.25, null),
    C(1440 * 3 + 60, '中国', '三季度 GDP 同比', 3, 4.7, 4.6, null),
    C(1440 * 8, '美国', 'FOMC 利率决议（上限）', 3, 5.0, 4.75, null),
    C(1440 * 9, '日本', '日本央行利率决议', 2, 0.25, 0.25, null),
  ];
}

function seedFilings(now) {
  return [
    { id: uid('f_'), symbol: 'NASDAQ:NVDA', type: '8-K', title: '重大协议：与微软扩大数据中心产品供货安排', filedAt: ago(now, 100), source: 'SEC EDGAR（演示）', url: 'https://example.com/mock/sec/nvda-8k', summary: '公司披露与微软签订扩大供货协议，未披露金额。' },
    { id: uid('f_'), symbol: 'NASDAQ:NVDA', type: '10-Q', title: '季度报告（截至 7 月末）', filedAt: daysAgo(now, 40), source: 'SEC EDGAR（演示）', url: 'https://example.com/mock/sec/nvda-10q', summary: '数据中心收入同比大幅增长，毛利率环比小幅回落。' },
    { id: uid('f_'), symbol: 'NASDAQ:TSLA', type: '8-K', title: '三季度生产与交付数据', filedAt: ago(now, 610), source: 'SEC EDGAR（演示）', url: 'https://example.com/mock/sec/tsla-8k', summary: '三季度交付 46.2 万辆。' },
    { id: uid('f_'), symbol: 'NASDAQ:AAPL', type: '10-K', title: '年度报告', filedAt: daysAgo(now, 330), source: 'SEC EDGAR（演示）', url: 'https://example.com/mock/sec/aapl-10k', summary: '服务业务收入占比持续提升。' },
    { id: uid('f_'), symbol: 'NYSE:TSM', type: '6-K', title: '9 月营收报告', filedAt: ago(now, 245), source: 'SEC EDGAR（演示）', url: 'https://example.com/mock/sec/tsm-6k', summary: '9 月营收同比 +39.6%。' },
    { id: uid('f_'), symbol: 'SSE:600519', type: '公告', title: '关于回购股份进展的公告', filedAt: daysAgo(now, 3), source: '上交所（演示）', url: 'https://example.com/mock/sse/600519', summary: '公司披露回购进展。' },
  ];
}

function seedFinancials() {
  // 单位：百万美元（A 股 / 港股为本币百万）。季度顺序：旧 → 新。
  const q = ['2024Q3', '2024Q4', '2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2'];
  const make = (rev, gm, om, nm, shares, fcfM, cash, debt, growth, guidance) => q.map((period, i) => {
    const revenue = Math.round(rev * (1 + growth) ** i);
    const g = gm + Math.sin(i) * 0.01 - (i === 7 ? 0.025 : 0); // 最新季度毛利率小幅回落，用于演示假设检查
    return {
      period, revenue, grossProfit: Math.round(revenue * g), operatingIncome: Math.round(revenue * om),
      netIncome: Math.round(revenue * nm), eps: +(revenue * nm / shares).toFixed(2), fcf: Math.round(revenue * fcfM),
      cash: Math.round(cash * (1 + 0.05 * i)), debt: Math.round(debt), guidance: i === 7 ? guidance : null,
    };
  });
  return {
    'NASDAQ:NVDA': make(30040, 0.75, 0.62, 0.55, 24500, 0.48, 34800, 8460, 0.11, '下季度收入指引 540 亿美元 ±2%，毛利率指引 73.5% ±0.5pct'),
    'NASDAQ:AAPL': make(94930, 0.462, 0.31, 0.25, 15200, 0.28, 65200, 101300, 0.012, '管理层预计下季度收入同比低至中个位数增长'),
    'NASDAQ:TSLA': make(25180, 0.18, 0.08, 0.07, 3200, 0.1, 33600, 7500, -0.005, '未提供具体交付指引，强调 2026 年推出更低价车型'),
    'NASDAQ:META': make(40590, 0.82, 0.43, 0.38, 2530, 0.33, 70900, 28800, 0.04, '下季度收入指引 445–475 亿美元；全年资本开支指引上调'),
    'NASDAQ:GOOGL': make(88270, 0.58, 0.32, 0.29, 12300, 0.21, 93000, 13200, 0.03, '未提供量化指引'),
    'NASDAQ:MSFT': make(65590, 0.69, 0.46, 0.36, 7430, 0.29, 78400, 42900, 0.035, 'Azure 增速预计维持 30%+'),
    'NYSE:TSM': make(23500, 0.57, 0.47, 0.42, 5190, 0.3, 70000, 29000, 0.07, '下季度毛利率指引 57%–59%'),
  };
}

function seedChats(now) {
  const msgs = [];
  const M = (min, groupId, user, content, type = 'text') => msgs.push({
    id: uid('m_'), groupId, groupName: '', user, time: ago(now, min), content, type,
    rawId: `${groupId}-${Math.round(min * 100)}-${user}`, platform: '',
  });
  const forward = '【转】彭博：微软本财年数据中心资本开支可能进一步上调，英伟达下一代 GPU 订单排到明年下半年。';
  // NVDA：最近 60 分钟 6 个群讨论，其中 3 个群转发同一段内容
  M(55, 'wx_1', '老王', 'NVDA 今天涨了 5 个点，和微软那个合作有关吧'); M(52, 'wx_1', '静水', '英伟达这估值还能买吗，PE 已经很高了'); M(40, 'wx_1', '老王', '数据中心需求还是强劲，我继续拿着'); M(33, 'wx_1', 'Kevin', '估值过高，我先减仓一点');
  M(50, 'wx_2', 'Lily', forward, 'forward'); M(48, 'wx_2', '阿杰', 'Nvidia 这波新产品发布节奏很快，Blackwell 之后还有 Rubin'); M(30, 'wx_2', 'Lily', '老黄的数据中心订单太猛了，看多'); M(12, 'wx_2', '小周', '听说下季度指引会再上调，不知道真假');
  M(45, 'tg_1', 'mike_t', '$NVDA breaking out, data center demand is insane'); M(41, 'tg_1', 'chen88', forward, 'forward'); M(20, 'tg_1', 'mike_t', 'valuation stretched though, careful');
  M(44, 'tg_2', 'AI观察员', forward, 'forward'); M(35, 'tg_2', '半导体老兵', '英伟达和台积电都在涨，AI 链条情绪很好'); M(18, 'tg_2', 'AI观察员', '云厂商 capex 上修是核心逻辑，利好 NVDA');
  M(38, 'dc_1', 'semi_guy', 'NVDA gross margin guide is the thing to watch'); M(26, 'dc_1', 'quant_lee', 'Nvidia new product cadence = strong, but 估值压力 增加'); M(10, 'dc_1', 'semi_guy', 'NVDA 突破前高');
  M(15, 'wx_3', '港股小白', '英伟达还能追吗'); M(9, 'wx_3', '老司机', '英伟达 别追高，等回调'); M(5, 'wx_3', '小白2', '英伟达 今天的量很大');
  // NVDA 上一个窗口（60–120 分钟前）较少讨论，用于计算热度变化
  M(100, 'wx_1', '老王', '英伟达最近横盘好久了'); M(90, 'tg_1', 'mike_t', 'NVDA quiet today');
  // TSLA：3 个群讨论（不足 4 个群，不触发）
  M(42, 'wx_1', '静水', '特斯拉交付不及预期，有点失望'); M(37, 'wx_1', 'Kevin', 'TSLA 看空，竞争太激烈'); M(28, 'wx_3', '老司机', '特斯拉 Robotaxi 发布会还是值得期待'); M(22, 'wx_3', '港股小白', 'TSLA 跌了好多'); M(16, 'tg_1', 'chen88', 'TSLA delivery miss, not great');
  // 宏观：黄金
  M(70, 'wx_4', '宏观小李', 'CPI 低于预期，黄金突破了'); M(65, 'wx_4', '大类配置', '美元走弱，金价还有空间'); M(58, 'wx_4', '宏观小李', '美债收益率下来了，降息预期升温');
  // 苹果
  M(47, 'wx_2', '阿杰', '苹果被欧盟又调查了，利空不大'); M(25, 'wx_3', '小白2', 'AAPL 最近没什么动静');
  const groups = Object.fromEntries([['wx_1', ['美股价值投资交流', 'wechat']], ['wx_2', ['科技股研究小组', 'wechat']], ['tg_1', ['US Tech Traders', 'telegram']], ['tg_2', ['AI 产业链跟踪', 'telegram']], ['dc_1', ['Semis Deep Dive', 'discord']], ['wx_3', ['港美股实盘群', 'wechat']], ['wx_4', ['宏观与大类资产', 'wechat']]]);
  for (const m of msgs) { m.groupName = groups[m.groupId][0]; m.platform = groups[m.groupId][1]; }
  return msgs.sort((a, b) => a.time.localeCompare(b.time));
}

function seedResearch(now) {
  return {
    'NASDAQ:NVDA': {
      thesis: 'AI 数据中心资本开支仍处于上行周期，英伟达凭借 GPU + CUDA 生态维持定价权，是 AI 基础设施最直接的受益者。',
      assumptions: [
        { id: 'as_nv1', text: 'AI 数据中心资本开支未来两年继续增长。', status: '待验证', createdAt: '2026-09-15T02:00:00.000Z', lastCheckedAt: '2026-09-15T02:00:00.000Z' },
        { id: 'as_nv2', text: '毛利率能维持在 70% 以上。', status: '待验证', createdAt: '2026-09-15T02:00:00.000Z', lastCheckedAt: '2026-09-15T02:00:00.000Z' },
      ],
      questions: [
        { id: 'q_nv1', text: '毛利率是否能够维持？新产品爬坡期会不会拉低毛利？', resolved: false },
        { id: 'q_nv2', text: '大客户自研芯片会在多大程度上替代 GPU？', resolved: false },
      ],
      plan: { watchPrice: 120, buyLow: 115, buyHigh: 125, positionPct: 15, addCondition: '数据中心收入环比增长 >10% 且毛利率 ≥72%', reduceCondition: '大客户资本开支指引下调', stopLoss: 105, target: 160, validUntil: '2026-12-31' },
      review: '',
      createdAt: '2026-09-15T02:00:00.000Z', updatedAt: '2026-09-15T02:00:00.000Z',
    },
    'NASDAQ:TSLA': {
      thesis: '关注自动驾驶与储能业务带来的估值重估机会，汽车业务利润率是短期压力。',
      assumptions: [
        { id: 'as_ts1', text: '季度交付量能恢复同比增长。', status: '待验证', createdAt: '2026-08-20T02:00:00.000Z', lastCheckedAt: '2026-08-20T02:00:00.000Z' },
        { id: 'as_ts2', text: '储能业务毛利率高于汽车业务。', status: '成立', createdAt: '2026-08-20T02:00:00.000Z', lastCheckedAt: '2026-08-20T02:00:00.000Z' },
      ],
      questions: [{ id: 'q_ts1', text: 'Robotaxi 商业化时间表是否可信？', resolved: false }],
      plan: { watchPrice: 230, buyLow: 220, buyHigh: 235, positionPct: 5, addCondition: 'FSD 订阅渗透率明显提升', reduceCondition: '汽车毛利率继续下滑', stopLoss: 200, target: 320, validUntil: '2026-12-31' },
      review: '',
      createdAt: '2026-08-20T02:00:00.000Z', updatedAt: '2026-08-20T02:00:00.000Z',
    },
  };
}
