// Discord 群聊 Connector（适配用户现有的 discord-local 程序）。
// discord-local 把消息保存为 messages/<服务器或频道备注>/<日期>.jsonl，每行一条：
//   { time: "YYYY-MM-DD HH:MM:SS"（运行机器的本地时区）, message_id, channel_id, channel_name, remark,
//     author: { id, name }, forwarded, content, embeds: [{title, description, fields, url}], attachments: [...] }
// 本模块只负责"接入"：读取文件 → 转成平台标准消息结构 → ingestMessages。AI 分析只处理标准结构。
//
// 配置（环境变量）：
//   DISCORD_MESSAGES_DIR   discord-local 的 messages 目录路径（不配置则不启用轮询）
//   DISCORD_TZ             discord-local 运行机器的时区，默认 Asia/Shanghai
//   DISCORD_POLL_SECONDS   轮询间隔，默认 15 秒
import fs from 'node:fs';
import path from 'node:path';
import { ingestMessages } from '../rules/chatHeat.js';
import { save } from '../store.js';

const offsets = new Map(); // 文件 → 已读取的字节数（增量读取）

/** 把 "YYYY-MM-DD HH:MM:SS"（某时区本地时间）转为 ISO UTC。 */
export function localTimeToIso(text, tz = 'Asia/Shanghai') {
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return new Date(text).toISOString();
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // 计算该时区在这一时刻的偏移
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]));
  const tzAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offset = tzAsUtc - asUtc;
  return new Date(asUtc - offset).toISOString();
}

/** 单条 discord-local 记录 → 平台标准消息结构。folder 为 jsonl 所在目录相对 messages 的路径。 */
export function mapRecord(rec, folder = '', tz = 'Asia/Shanghai') {
  const embedText = (rec.embeds || []).map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  const content = [rec.content, embedText].filter(Boolean).join('\n').trim();
  const groupName = rec.remark || folder || rec.channel_name || String(rec.channel_id);
  return {
    groupId: `discord:${rec.channel_id || groupName}`,
    groupName: rec.channel_name && !groupName.includes(rec.channel_name) ? `${groupName} #${rec.channel_name}` : groupName,
    user: rec.author?.name || 'unknown',
    time: localTimeToIso(rec.time, tz),
    content,
    type: rec.forwarded ? 'forward' : (rec.attachments?.length && !rec.content ? 'image' : 'text'),
    rawId: String(rec.message_id),
    platform: 'discord',
  };
}

/** 解析 jsonl 文本（容忍坏行），返回标准消息数组。 */
export function parseJsonl(text, folder = '', tz) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = mapRecord(JSON.parse(line), folder, tz);
      if (m.content) out.push(m);
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
    else if (ent.name.endsWith('.jsonl')) files.push(p);
  }
  return files;
}

/** 扫描一次 messages 目录，增量读取新增行并入库。返回新增消息数。 */
export function scanOnce(dir = process.env.DISCORD_MESSAGES_DIR, tz = process.env.DISCORD_TZ || 'Asia/Shanghai') {
  if (!dir) return 0;
  let added = 0;
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
    const folder = path.relative(dir, path.dirname(file)).split(path.sep).join('/');
    added += ingestMessages(parseJsonl(text.slice(0, lastNl + 1), folder, tz), 'discord-local').length;
  }
  if (added) save();
  return added;
}

export function startDiscordPolling() {
  const dir = process.env.DISCORD_MESSAGES_DIR;
  if (!dir) return null;
  const sec = Number(process.env.DISCORD_POLL_SECONDS || 15);
  const n = scanOnce();
  console.log(`[discord-local] 读取 ${dir}，首次导入 ${n} 条消息，每 ${sec} 秒增量同步`);
  return setInterval(() => {
    try { scanOnce(); } catch (e) { console.error('[discord-local] 同步失败：', e.message); }
  }, sec * 1000);
}
