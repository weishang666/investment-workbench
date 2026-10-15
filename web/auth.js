// 登录与账号：本机 / 局域网端口免登录；公网入口未登录时显示登录页。只读账号隐藏群聊、自选管理、设置和 AI 助手。
import { api, esc, toast, timeAgo } from './ui.js';

export async function ensureLogin() {
  const res = await fetch('/api/me');
  if (res.status === 401) { showLogin(); return null; }
  const me = await res.json();
  document.body.dataset.role = me.user.role;
  if (!me.local) {
    const chip = document.createElement('span');
    chip.className = 'pill user-chip';
    chip.innerHTML = `${esc(me.user.name)} · ${esc(me.roles[me.user.role])} <a href="#" id="logout">退出</a>`;
    document.querySelector('.topbar-right').append(chip);
    chip.querySelector('#logout').onclick = async (e) => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
  }
  return me;
}

function showLogin() {
  document.body.dataset.role = 'guest';
  document.getElementById('app').innerHTML = `<form class="panel login-box" id="login-form">
    <h3>登录个人投研工作台</h3>
    <input name="name" placeholder="用户名" autocomplete="username" required />
    <input name="password" type="password" placeholder="密码" autocomplete="current-password" required />
    <button class="btn primary" type="submit">登录</button>
    <div class="small down" id="login-err"></div></form>`;
  const f = document.getElementById('login-form');
  f.name.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/auth/login', { method: 'POST', body: { name: f.name.value, password: f.password.value } }); location.reload(); }
    catch (err) { document.getElementById('login-err').textContent = err.message; }
  };
}

// 规则与任务页里的账号管理面板（仅管理员）
export async function usersPanel(host) {
  const users = await api('/api/users').catch(() => null);
  if (!users) return;
  const el = document.createElement('div');
  el.className = 'panel';
  el.innerHTML = `<div class="panel-head"><h3>公网登录账号</h3></div>
    <div class="small muted" style="margin-bottom:8px">只在公网入口需要登录；本机和局域网访问不受影响。只读账号能看大屏、个股、宏观、提醒和新闻，也能看群聊洞察（含原文），但不能改群聊设置，不能用 AI 助手，也不能改任何东西。</div>
    ${users.map((u) => `<div class="row" style="justify-content:space-between;padding:4px 0"><span>${esc(u.name)} <span class="faint small">${u.role === 'admin' ? '管理员' : '只读'} · 最近登录 ${u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}</span></span>
      <span class="row"><button class="btn sm" data-pw="${esc(u.id)}">重设密码</button><button class="btn sm" data-del="${esc(u.id)}" data-name="${esc(u.name)}">删除</button></span></div>`).join('') || '<div class="empty">还没有账号</div>'}
    <form class="row wrap" id="add-user" style="margin-top:10px">
      <input name="name" placeholder="用户名" required style="width:120px" />
      <input name="password" type="password" placeholder="密码（至少 8 位）" required style="width:150px" autocomplete="new-password" />
      <select name="role"><option value="viewer">只读</option><option value="admin">管理员</option></select>
      <button class="btn primary" type="submit">添加</button></form>`;
  host.append(el);
  const reload = () => { el.remove(); usersPanel(host); };
  el.querySelector('#add-user').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('/api/users', { method: 'POST', body: { name: f.name.value, password: f.password.value, role: f.role.value } }); toast('已添加账号', f.name.value); reload(); }
    catch (err) { toast('添加失败', err.message); }
  };
  el.querySelectorAll('[data-pw]').forEach((b) => { b.onclick = async () => {
    const pw = prompt('新密码（至少 8 位）'); if (!pw) return;
    try { await api(`/api/users/${b.dataset.pw}`, { method: 'PUT', body: { password: pw } }); toast('已重设密码', '该账号需要重新登录'); } catch (err) { toast('失败', err.message); }
  }; });
  el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
    if (!confirm(`删除账号 ${b.dataset.name}？`)) return;
    try { await api(`/api/users/${b.dataset.del}`, { method: 'DELETE' }); reload(); } catch (err) { toast('删除失败', err.message); }
  }; });
}
