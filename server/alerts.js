// 统一提醒中心。所有规则（价格、成交量、公司事件、新闻、群聊、研究）都通过 createAlert 进入。
// 状态：unread 未读 / read 已读 / handled 已处理 / ignored 忽略。dedupeKey 保证同一提醒不会重复发送。
import { db, uid, save } from './store.js';
import { emit } from './lib/bus.js';

export const ALERT_TYPES = {
  price: '涨跌幅异常', volume: '成交量异常', level: '关键价位', company: '公司事件', earnings: '财报',
  news: '重大新闻', chat: '群聊共振', research: '研究提醒', calendar: '经济数据',
};

export function createAlert({ type, symbol = null, title, body = '', severity = 'info', dedupeKey, data = {}, now = new Date() }) {
  if (dedupeKey && db.alerts.some((a) => a.dedupeKey === dedupeKey)) return null;
  const alert = {
    id: uid('al_'), type, category: ALERT_TYPES[type] || type, symbol, title, body, severity,
    status: 'unread', createdAt: now.toISOString(), dedupeKey: dedupeKey || null, data,
    analysis: null, // 第二阶段：Agent 原因分析结果
  };
  db.alerts.unshift(alert);
  if (db.alerts.length > 500) db.alerts.length = 500;
  save();
  emit('alert', alert);
  return alert;
}

export function setStatus(id, status) {
  if (!['unread', 'read', 'handled', 'ignored'].includes(status)) throw Object.assign(new Error('非法状态'), { status: 400 });
  const a = db.alerts.find((x) => x.id === id);
  if (!a) throw Object.assign(new Error('提醒不存在'), { status: 404 });
  a.status = status;
  a.statusAt = new Date().toISOString();
  save();
  emit('alert-updated', a);
  return a;
}

export function attachAnalysis(id, analysis) {
  const a = db.alerts.find((x) => x.id === id);
  if (!a) return null;
  a.analysis = analysis;
  save();
  emit('alert-updated', a);
  return a;
}

export function listAlerts({ status, type, symbol, limit = 100 } = {}) {
  return db.alerts
    .filter((a) => (!status || status === 'all' || (status === 'open' ? ['unread', 'read'].includes(a.status) : a.status === status)))
    .filter((a) => !type || a.type === type)
    .filter((a) => !symbol || a.symbol === symbol)
    .slice(0, limit);
}

export function counts() {
  const c = { unread: 0, read: 0, handled: 0, ignored: 0 };
  for (const a of db.alerts) c[a.status]++;
  return c;
}
