// 本机 OpenClaw 接入：
//  1. 聊天桥接：右下角对话框 → OpenClaw Gateway 的 /v1/chat/completions（OpenClaw 再通过 invest-workbench skill 回调本系统工具）
//  2. 任务派发：异动分析、开盘前/收盘后报告 → OpenClaw Gateway 的 /hooks/agent；OpenClaw 完成后用 skill 把结果写回 /api/agent/results
// 未配置或调用失败时，由调用方回退到本地规则引擎。
import { db } from '../store.js';

const env = (k, d = '') => process.env[k] ?? d;
export const OC = {
  url: () => env('OPENCLAW_URL', 'http://127.0.0.1:18789').replace(/\/$/, ''),
  token: () => env('OPENCLAW_TOKEN'),
  agent: () => env('OPENCLAW_AGENT', 'main'),
  hooksToken: () => env('OPENCLAW_HOOKS_TOKEN'),
  hooksPath: () => env('OPENCLAW_HOOKS_PATH', '/hooks').replace(/\/$/, ''),
  deliver: () => env('OPENCLAW_DELIVER') === '1',
  chatTimeoutMs: () => Number(env('OPENCLAW_CHAT_TIMEOUT', '180')) * 1000,
  resultTimeoutMs: () => Number(env('OPENCLAW_RESULT_TIMEOUT', '600')) * 1000,
};

export const chatEnabled = () => !!OC.token();
export const hooksEnabled = () => !!OC.hooksToken();

// ---------- OpenClaw 调用工具时返回的证据，缓存起来，回答里引用 [证据: id] 时可以还原 ----------
const evidenceCache = new Map();
export function rememberEvidence(list = []) {
  for (const e of list) {
    if (!e?.id) continue;
    evidenceCache.delete(e.id);
    evidenceCache.set(e.id, e);
  }
  while (evidenceCache.size > 2000) evidenceCache.delete(evidenceCache.keys().next().value);
}
export function resolveEvidence(blocks = []) {
  const ids = new Set(blocks.flatMap((b) => b.evidence || []));
  return [...ids].map((id) => evidenceCache.get(id)).filter(Boolean);
}

async function post(path, body, token, timeoutMs) {
  const res = await fetch(OC.url() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenClaw ${path} 返回 ${res.status}：${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { text }; }
}

const PAGE = { dashboard: '投资大屏', events: '投资事件流', stock: '标的详情', alerts: '提醒中心', chat: '群聊洞察', watchlist: '自选与导入', macro: '宏观指标', settings: '规则与任务' };

/** 聊天桥接：返回 OpenClaw 的原始文本 */
export async function chat(question, context = {}, sessionId) {
  const where = [context.page && `页面：${PAGE[context.page] || context.page}`, context.symbol && `当前标的：${context.symbol}`].filter(Boolean).join('，');
  const content = [
    `[来自投研工作台${where ? `｜${where}` : ''}]`,
    '请使用 invest-workbench skill 调用工作台工具取证后回答，并按 skill 规定的【事实】/【AI分析】/【待验证】/【用户研究】格式逐行输出。',
    '',
    question,
  ].join('\n');
  const r = await post('/v1/chat/completions', {
    model: `openclaw:${OC.agent()}`,
    user: `invest-workbench:${sessionId}`, // 同一个工作台会话对应同一个 OpenClaw 会话
    messages: [{ role: 'user', content }],
  }, OC.token(), OC.chatTimeoutMs());
  const text = r?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenClaw 没有返回内容');
  return Array.isArray(text) ? text.map((p) => p.text || '').join('') : String(text);
}

// ---------- 任务派发 ----------
const pending = new Map(); // taskId → { timer, fallback }

/**
 * 把一项分析任务交给 OpenClaw。返回 true 表示已受理；false 表示未配置或失败（调用方应走本地规则）。
 * fallback 会在 OpenClaw 超时未回写结果时执行。
 */
export async function dispatch(task, fallback) {
  if (!hooksEnabled()) return false;
  const message = [
    `[投研工作台任务] taskId=${task.id}`,
    `类型：${task.label}`,
    task.symbol ? `标的：${task.symbol}` : null,
    task.alertId ? `提醒：${task.alertId}` : null,
    '',
    task.instructions,
    '',
    `完成后必须用 invest-workbench skill 的 result 命令写回工作台：kind=${task.kind}，task=${task.id}${task.alertId ? `，alert=${task.alertId}` : ''}${task.symbol ? `，symbol=${task.symbol}` : ''}。`,
  ].filter((x) => x != null).join('\n');
  try {
    await post(`${OC.hooksPath()}/agent`, { message, name: '投研工作台', agentId: OC.agent(), wakeMode: 'now', deliver: OC.deliver(), timeoutSeconds: Math.round(OC.resultTimeoutMs() / 1000) }, OC.hooksToken(), 15000);
  } catch (e) {
    console.error('[openclaw] 派发失败，改用本地规则：', e.message);
    return false;
  }
  const timer = setTimeout(() => {
    pending.delete(task.id);
    console.warn(`[openclaw] ${task.label} 超时未回写，改用本地规则`);
    fallback?.();
  }, OC.resultTimeoutMs());
  timer.unref?.();
  pending.set(task.id, { timer, task });
  return true;
}

/** OpenClaw 写回结果后调用：取消超时回退，返回原任务（可能为空） */
export function complete(taskId) {
  const p = pending.get(taskId);
  if (!p) return null;
  clearTimeout(p.timer);
  pending.delete(taskId);
  return p.task;
}

export function status() {
  return {
    chat: chatEnabled(), hooks: hooksEnabled(), url: OC.url(), agent: OC.agent(), deliver: OC.deliver(),
    pending: [...pending.values()].map((p) => ({ id: p.task.id, label: p.task.label, symbol: p.task.symbol || null })),
    lastResults: db.aiAnalyses.filter((a) => a.model === 'openclaw').slice(0, 5).map((a) => ({ id: a.id, kind: a.kind, title: a.title, createdAt: a.createdAt })),
  };
}
