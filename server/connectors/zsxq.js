// 知识星球 Connector：读取宿主机 scripts/zsxq-sync.mjs 写出的帖子文件，作为一路新闻源进入事件流。
// 文件结构：data/zsxq/<目录>/YYYY-MM-DD.jsonl，每行一条：
//   { topic_id, group_id, group_name, create_time（+0800）, title, text, tags, author, images, files: [{name,size,file_id}], counts, url }
// 本模块只负责"接入"：增量读取 → 转成平台文章结构（feed: 'zsxq'）→ ingestArticles → 新闻流水线。
//
// 配置（环境变量）：
//   ZSXQ_DIR            帖子根目录，默认 data/zsxq；设为空字符串关闭
//   ZSXQ_POLL_SECONDS   轮询间隔，默认 60 秒
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../store.js';
import { feedMentions } from '../news.js';
import { ingestArticles } from '../newsFeeds.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const LEAD_MAX = 1500;
const offsets = new Map(); // 文件 → 已读取的字节数（增量读取）
let lastScan = null; let lastAdded = 0; let total = 0;

const zsxqDir = () => (process.env.ZSXQ_DIR === undefined ? path.join(ROOT, 'data', 'zsxq') : process.env.ZSXQ_DIR);
export const enabled = () => !!zsxqDir() && process.env.NODE_ENV !== 'test';

/** "2026-10-14T16:47:45.769+0800" → ISO UTC。 */
export const toIso = (t) => new Date(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString();

// 研报帖里券商绝大多数是观点出处（"摩根大通测算…""高盛梳理…"），不是关于该券商本身的消息。
// 识别标的前去掉券商名，除非紧跟的是券商自身的经营类词（财报、股价、CEO…）。
const BROKERS = '摩根大通|小摩|摩根士丹利|大摩|高盛|花旗|瑞银|美银|美国银行|富国银行|巴克莱|德意志银行|德银|野村|汇丰|杰富瑞|伯恩斯坦|中金公司|中金|中信证券|华泰证券|JPMorgan|J\\.P\\. ?Morgan|Morgan Stanley|Goldman Sachs|Citigroup|Citi|UBS|BofA|Jefferies|Bernstein';
const SELF = '第[一二三四]季度|Q[1-4]|[一二三四]季度|财报|业绩|净利|营收|收入|利润|股价|股票|市值|CEO|首席执行官|戴蒙|所罗门|董事|裁员|罚款|被罚|被诉|起诉|收购|并购|分红|回购|拨备|存款|贷款|投行业务|交易收入';
const BROKER_RE = new RegExp(`(?:据|根据)?(?:${BROKERS})(?:（[^）]{0,30}）|\\([^)]{0,30}\\))?(?!\\s*(?:${SELF}))`, 'gi');
export const stripBrokerCites = (text) => String(text).replace(BROKER_RE, ' ');

/** 单条帖子 → 平台文章结构。标题取正文第一行（星球自带的 title 是截断的）。 */
export function toArticle(rec) {
  const text = String(rec.text || '').trim();
  const firstLine = (text.split('\n').find((l) => l.trim()) || rec.title || '').trim();
  const title = (firstLine.match(/^[^。！？!?]+[。！？!?]?/)?.[0] || firstLine).slice(0, 80);
  const files = (rec.files || []).map((f) => f.name).filter(Boolean);
  const lead = [text, files.length ? `附件：${files.join('；')}` : ''].filter(Boolean).join('\n').slice(0, LEAD_MAX);
  const tags = rec.tags || [];
  return {
    id: `a_zsxq${rec.topic_id}`,
    publishedAt: toIso(rec.create_time),
    source: `知识星球·${rec.group_name || rec.group_id}`, sourceType: 'community', feed: 'zsxq',
    title, lead,
    url: rec.url || `https://wx.zsxq.com/group/${rec.group_id}/topic/${rec.topic_id}`,
    author: rec.author, tags, files: rec.files || [], images: rec.images || [],
    // 标的识别用全文 + 话题标签（lead 可能被截断），并去掉券商署名；流水线不再按 lead 重复识别
    symbols: feedMentions(stripBrokerCites(`${title}\n${text}\n${tags.join(' ')}\n${files.join(' ')}`)),
    symbolsOnly: true,
  };
}

/** 解析 jsonl 文本（容忍坏行），返回文章数组。 */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.topic_id && rec.create_time && (rec.text || rec.files?.length)) out.push(toArticle(rec));
    } catch { /* 跳过写入中途的半行或坏行 */ }
  }
  return out;
}

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'files') files.push(...walk(p)); }
    else if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(ent.name)) files.push(p);
  }
  return files.sort();
}

/** 扫描一次，增量读取新增行。返回新文章数组（尚未入库）。 */
export function readNew(dir = zsxqDir()) {
  const out = [];
  if (!dir) return out;
  for (const file of walk(dir)) {
    const size = fs.statSync(file).size;
    const from = offsets.get(file) || 0;
    if (size <= from) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) continue; // 还没有完整的一行
    offsets.set(file, from + Buffer.byteLength(text.slice(0, lastNl + 1)));
    out.push(...parseJsonl(text.slice(0, lastNl + 1)));
  }
  return out;
}

export const zsxqState = () => ({ enabled: enabled(), dir: zsxqDir() || null, lastScan, lastAdded, total, inFeed: db.articles.filter((a) => a.feed === 'zsxq').length });

/** 启动轮询。onIngest(now) 在有新文章入库后调用（跑流水线 + 提醒 + 保存）。 */
export function startZsxqPolling(onIngest) {
  if (!enabled()) return null;
  const sec = Number(process.env.ZSXQ_POLL_SECONDS || 60);
  let first = true;
  const tick = () => {
    const list = readNew();
    // 启动时文件是唯一来源：先清掉库里旧的星球文章，避免沿用旧规则识别出的标的（入库按 url 去重会合并旧标的）
    if (first && list.length) db.articles = db.articles.filter((a) => a.feed !== 'zsxq');
    first = false;
    total += list.length;
    lastScan = new Date().toISOString();
    lastAdded = ingestArticles(list);
    if (lastAdded) onIngest(new Date());
    return lastAdded;
  };
  try { console.log(`[zsxq] 读取 ${zsxqDir()}，首次导入 ${tick()} 条帖子，每 ${sec} 秒增量同步`); } catch (e) { console.error('[zsxq] 读取失败：', e.message); }
  return setInterval(() => {
    try { tick(); } catch (e) { console.error('[zsxq] 同步失败：', e.message); }
  }, sec * 1000);
}
