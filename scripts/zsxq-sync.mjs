#!/usr/bin/env node
// 知识星球帖子同步（宿主机运行，只读）：调用官方 zsxq-cli 拉取星球主题，增量写入
//   data/zsxq/<目录>/YYYY-MM-DD.jsonl（按帖子发布日期，东八区），每行一条：
//   { topic_id, group_id, group_name, create_time, title, text, tags, author, images, files, counts, url }
// 状态（已见 topic_id）保存在同目录 state.json。首次运行回补约 3 天；之后向前翻页直到遇到已见的帖子。
// zsxq-cli 的登录凭据由它自己管理，本脚本不读取也不保存任何凭据。
//
// 用法：node scripts/zsxq-sync.mjs [--group-id 48885454415828] [--dir 404k] [--backfill-days 3]
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const GROUP_ID = arg('group-id', '48885454415828');
const OUT_DIR = path.join(ROOT, 'data', 'zsxq', arg('dir', '404k'));
const BACKFILL_DAYS = Number(arg('backfill-days', 3));
const MAX_PAGES = Number(arg('max-pages', 40));
const PAGE_DELAY_MS = Number(arg('delay-ms', 3000));
const CLI = process.env.ZSXQ_CLI || 'zsxq-cli';
const KEEP_SEEN = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args) {
  return new Promise((resolve, reject) => {
    execFile(CLI, args, { maxBuffer: 64 << 20, timeout: 60000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      resolve(stdout);
    });
  });
}

/** 拉一页（最多 30 条）；429 / 临时错误退避重试。 */
async function fetchPage(endTime) {
  const args = ['group', '+topics', '--group-id', GROUP_ID, '--limit', '30', '--json'];
  if (endTime) args.push('--end-time', endTime);
  for (let attempt = 0; ; attempt++) {
    try {
      const j = JSON.parse(await cli(args));
      if (j.success === false) throw new Error(JSON.stringify(j).slice(0, 300));
      return j;
    } catch (e) {
      if (attempt >= 4) throw e;
      const wait = (/429|rate|频繁/i.test(e.message) ? 30000 : 5000) * 2 ** attempt;
      console.warn(`[zsxq-sync] 拉取失败，${wait / 1000}s 后重试：${e.message}`);
      await sleep(wait);
    }
  }
}

const decode = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

/** 去掉 <e .../> 富文本标签：话题标签收进 tags，提及 / 链接保留可读文字。 */
export function cleanText(raw, tags = new Set()) {
  const text = String(raw || '').replace(/<e\s[^>]*?\/?>/g, (tag) => {
    const type = attr(tag, 'type');
    const title = decode(attr(tag, 'title'));
    if (type === 'hashtag') { const t = title.replace(/^#|#$/g, '').trim(); if (t) tags.add(t); return ''; }
    if (type === 'mention') return title ? `@${title.replace(/^@/, '')}` : '';
    if (type === 'web') return title || decode(attr(tag, 'href'));
    return title;
  });
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 东八区日期 YYYY-MM-DD（create_time 形如 2026-10-14T16:47:45.769+0800）。 */
const cstDate = (iso) => new Date(new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() + 8 * 3600e3).toISOString().slice(0, 10);

export function toRecord(t) {
  const tags = new Set();
  for (const m of String(t.annotation || '').matchAll(/<e\s[^>]*?\/?>/g)) cleanText(m[0], tags);
  const text = cleanText(t.content, tags);
  return {
    topic_id: String(t.topic_id),
    group_id: String(t.group?.group_id || GROUP_ID),
    group_name: t.group?.name || '',
    create_time: t.create_time,
    type: t.type,
    title: cleanText(t.title),
    text,
    tags: [...tags],
    author: t.owner?.name || '',
    images: (t.images || []).map((i) => i.original?.url || i.large?.url || i.thumbnail?.url).filter(Boolean),
    files: (t.files || []).map((f) => ({ name: f.name, size: f.size, file_id: String(f.file_id) })),
    counts: t.counts || {},
    digested: !!t.digested,
    url: `https://wx.zsxq.com/group/${t.group?.group_id || GROUP_ID}/topic/${t.topic_id}`,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stateFile = path.join(OUT_DIR, 'state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { seen: [] };
  const seen = new Set(state.seen);
  const firstRun = seen.size === 0;
  const cutoff = Date.now() - BACKFILL_DAYS * 86400e3;
  const fresh = [];
  let endTime = null;
  let pages = 0;
  for (; pages < MAX_PAGES; pages++) {
    if (pages) await sleep(PAGE_DELAY_MS);
    const j = await fetchPage(endTime);
    const list = j.topics_brief || [];
    let hitSeen = false; let hitCutoff = false;
    for (const t of list) {
      const id = String(t.topic_id);
      if (seen.has(id)) { if (!t.sticky) hitSeen = true; continue; } // end_time 游标是闭区间，翻页会重复上一页最后一条
      if (new Date(String(t.create_time).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() < cutoff) { hitCutoff = true; continue; }
      seen.add(id);
      fresh.push(toRecord(t));
    }
    // 非首次运行遇到已见的非置顶帖子即停（置顶帖总在第一页，不作为停止依据）
    if (!j.has_more || !j.next_end_time || hitCutoff || (!firstRun && hitSeen)) { pages++; break; }
    endTime = j.next_end_time;
  }
  // 按日期分文件追加，同一天内按时间升序
  fresh.sort((a, b) => a.create_time.localeCompare(b.create_time));
  const byDay = new Map();
  for (const r of fresh) { const d = cstDate(r.create_time); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
  for (const [d, list] of byDay) fs.appendFileSync(path.join(OUT_DIR, `${d}.jsonl`), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  state.seen = [...seen].slice(-KEEP_SEEN);
  state.groupId = GROUP_ID;
  state.lastRun = new Date().toISOString();
  state.lastAdded = fresh.length;
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state));
  fs.renameSync(stateFile + '.tmp', stateFile);
  console.log(`[zsxq-sync] ${new Date().toISOString()} 星球 ${GROUP_ID}：${pages} 页，新增 ${fresh.length} 条${firstRun ? `（首次回补 ${BACKFILL_DAYS} 天）` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error(`[zsxq-sync] 失败：${e.message}`); process.exit(1); });
}
