// 进程内事件总线：规则引擎 → SSE 推送 / Agent 事件触发任务。
const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (e) { console.error(`[bus] ${event} listener failed:`, e); }
  }
  for (const fn of listeners.get('*') || []) {
    try { fn(event, payload); } catch (e) { console.error('[bus] * listener failed:', e); }
  }
}
