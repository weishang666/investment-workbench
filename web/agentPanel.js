// 全局 OpenClaw AI Agent：右下角数字人入口 + 聊天窗口。
// 自动携带"用户当前在看什么"（页面 + 标的），支持历史会话与继续会话。
import { api, esc, renderBlocks, legend, timeAgo } from './ui.js';

const state = { open: false, sessionId: null, messages: [], view: 'chat', busy: false };
let getContext = () => ({ page: 'dashboard' });

const AVATAR = document.querySelector('#agent-fab svg').outerHTML;

export function initAgent(contextProvider) {
  getContext = contextProvider;
  document.getElementById('agent-fab').onclick = () => toggle();
}

export function toggle(force) {
  state.open = force ?? !state.open;
  const panel = document.getElementById('agent-panel');
  panel.hidden = !state.open;
  if (state.open) render();
}

/** 从页面任何位置发起提问（如提醒卡片上的"让 AI 分析"） */
export function askAgent(question) {
  toggle(true);
  send(question);
}

export function refreshContext() { if (state.open) renderContext(); }

function ctxLabel() {
  const c = getContext();
  if (c.page === 'stock' && c.symbol) return `当前页面：${c.name || c.symbol} 详情页，提问时无需重复股票名称`;
  return `当前页面：${{ dashboard: '投资大屏', events: '投资事件流', alerts: '提醒中心', chat: '群聊洞察', watchlist: '自选与导入', settings: '规则与任务' }[c.page] || c.page}`;
}

function renderContext() {
  const el = document.querySelector('.agent-ctx');
  if (el) el.innerHTML = `<span>📍 ${esc(ctxLabel())}</span>`;
}

function quickPrompts() {
  const c = getContext();
  if (c.page === 'stock' && c.symbol) return ['为什么今天涨跌这么多？', '现在最大的风险是什么？', '根据最近财报重新检查我的投资逻辑', '我之前为什么关注它？', '帮我生成一份投资研究报告'];
  return ['为什么黄金今天突然上涨？', '最近有哪些新闻可能影响我的自选股？', '今天群里讨论最多的股票是什么？', 'META 和谷歌哪个更值得关注？', '今天市场发生了什么？'];
}

function render() {
  const panel = document.getElementById('agent-panel');
  panel.innerHTML = `
    <div class="agent-head">${AVATAR}<div><b>OpenClaw</b><div class="small faint" id="agent-mode"></div></div><span class="spacer"></span>
      <button class="btn sm ghost" id="ag-new">新会话</button>
      <button class="btn sm ghost" id="ag-hist">${state.view === 'history' ? '返回对话' : '历史会话'}</button>
      <button class="btn sm ghost" id="ag-close" aria-label="关闭">✕</button></div>
    <div class="agent-ctx"></div>
    <div class="agent-body" id="ag-body"></div>
    <div class="agent-input">
      <div class="quick">${quickPrompts().map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div class="row"><textarea id="ag-input" rows="2" placeholder="问我任何研究问题，Enter 发送，Shift+Enter 换行"></textarea><button class="btn primary" id="ag-send">发送</button></div>
    </div>`;
  renderContext();
  api('/api/meta').then((m) => { document.getElementById('agent-mode').textContent = m.model === 'openclaw' ? '本机 OpenClaw' : m.llm ? `Claude 推理 · ${m.model}` : '本地规则模式（未接入 OpenClaw）'; });
  panel.querySelector('#ag-close').onclick = () => toggle(false);
  panel.querySelector('#ag-new').onclick = () => { state.sessionId = null; state.messages = []; state.view = 'chat'; render(); };
  panel.querySelector('#ag-hist').onclick = () => { state.view = state.view === 'history' ? 'chat' : 'history'; render(); };
  panel.querySelector('#ag-send').onclick = () => send();
  const input = panel.querySelector('#ag-input');
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  panel.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => send(b.dataset.q); });
  if (state.view === 'history') renderHistory(); else renderMessages();
  input.focus();
}

function renderMessages() {
  const body = document.getElementById('ag-body');
  if (!state.messages.length) {
    body.innerHTML = `<div class="bubble-ai"><b>你好，我是 OpenClaw。</b><div class="small muted" style="margin-top:4px">我会先调用行情、新闻、公告、财务、群聊和你的研究记录等工具取证，再给出分析。回答中的内容按可信度区分：</div><div style="margin-top:8px">${legend()}</div></div>`;
    return;
  }
  body.innerHTML = state.messages.map((m) => m.role === 'user'
    ? `<div class="bubble-user">${esc(m.text)}</div>`
    : m.pending ? '<div class="bubble-ai"><span class="typing"><i></i><i></i><i></i></span> <span class="small muted">正在调用工具分析…</span></div>'
      : `<div class="bubble-ai"><h4>${esc(m.title || '')}</h4>${renderBlocks(m.blocks, m.evidence)}${m.model === 'openclaw' ? '<div class="tools-used">由本机 OpenClaw 回答</div>' : ''}${m.toolCalls?.length ? `<div class="tools-used">调用工具：${[...new Set(m.toolCalls.map((t) => t.name))].map((n) => `<code>${esc(n)}</code>`).join(' ')} · ${esc(m.model || '')}</div>` : ''}</div>`).join('');
  body.scrollTop = body.scrollHeight;
}

async function renderHistory() {
  const body = document.getElementById('ag-body');
  body.innerHTML = '<div class="empty">加载中…</div>';
  const list = await api('/api/agent/sessions');
  body.innerHTML = list.length ? `<div class="sessions">${list.map((s) => `<div class="session" data-id="${s.id}"><b>${esc(s.title)}</b><div class="small faint">${timeAgo(s.updatedAt)} · ${s.messageCount} 条消息${s.symbols.length ? ` · ${s.symbols.map((x) => esc(x.split(':')[1])).join('、')}` : ''}${s.reports.length ? ` · ${s.reports.length} 份报告` : ''}</div><div class="small faint">${s.toolsUsed.map((t) => `<code>${esc(t)}</code>`).join(' ')}</div></div>`).join('')}</div>` : '<div class="empty">还没有历史会话</div>';
  body.querySelectorAll('.session').forEach((el) => {
    el.onclick = async () => {
      const s = await api(`/api/agent/sessions/${el.dataset.id}`);
      state.sessionId = s.id; state.messages = s.messages; state.view = 'chat';
      render();
    };
  });
}

async function send(text) {
  const input = document.getElementById('ag-input');
  const question = (text ?? input?.value ?? '').trim();
  if (!question || state.busy) return;
  if (input) input.value = '';
  state.view = 'chat';
  state.busy = true;
  state.messages.push({ role: 'user', text: question }, { role: 'assistant', pending: true });
  if (!document.getElementById('ag-body')) render(); else renderMessages();
  try {
    const r = await api('/api/agent/ask', { method: 'POST', body: { question, context: getContext(), sessionId: state.sessionId } });
    state.sessionId = r.sessionId;
    state.messages[state.messages.length - 1] = r.message;
  } catch (e) {
    state.messages[state.messages.length - 1] = { role: 'assistant', title: '出错了', blocks: [{ kind: 'text', text: e.message }] };
  }
  state.busy = false;
  renderMessages();
}
