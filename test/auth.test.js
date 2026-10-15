// 公网入口登录与权限：起一个独立的工作台进程（临时数据目录，不连任何外部数据源）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-'));
const PORT = 3900 + Math.floor(Math.random() * 50); const PUB = PORT + 50;
const env = { ...process.env, DATA_DIR: dir, USERS_FILE: path.join(dir, 'users.json'), PORT: String(PORT), PUBLIC_PORT: String(PUB),
  WATCHLIST_FILE: '', GANGTISE_ACCESS_KEY: '', GANGTISE_SECRET_KEY: '', FINNHUB_API_KEY: '', NEWS_CLS: '0', DISCORD_MESSAGES_DIR: '', OPENCLAW_TOKEN: '', OPENCLAW_HOOKS_TOKEN: '' };
let proc;
const users = (...a) => execFileSync('node', ['scripts/users.mjs', ...a], { env: { ...env, WB_PASSWORD: 'secret-pass-1' } }).toString();
const call = async (port, p, { method = 'GET', body, cookie } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], json: await r.json().catch(() => null) };
};

before(async () => {
  users('add', 'boss', 'admin'); users('add', 'friend');
  proc = spawn('node', ['server/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PUB}/api/me`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('本机端口免登录，行为不变', async () => {
  assert.equal((await call(PORT, '/api/me')).json.local, true);
  assert.equal((await call(PORT, '/api/settings')).status, 200);
});

test('公网入口未登录一律 401，静态页面照常返回', async () => {
  assert.equal((await call(PUB, '/api/dashboard')).status, 401);
  assert.equal((await call(PUB, '/api/agent/tools')).status, 401);
  assert.equal((await call(PUB, '/api/stream')).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${PUB}/`)).status, 200);
});

test('密码错误被拒绝', async () => {
  assert.equal((await call(PUB, '/api/auth/login', { method: 'POST', body: { name: 'friend', password: 'wrong-pass' } })).status, 401);
});

test('只读账号：能看行情和群聊，不能改、不能用 AI', async () => {
  const { cookie, status } = await call(PUB, '/api/auth/login', { method: 'POST', body: { name: 'friend', password: 'secret-pass-1' } });
  assert.equal(status, 200);
  assert.equal((await call(PUB, '/api/me', { cookie })).json.user.role, 'viewer');
  assert.equal((await call(PUB, '/api/dashboard', { cookie })).status, 200);
  assert.equal((await call(PUB, '/api/chat/messages', { cookie })).status, 200);
  for (const p of ['/api/settings', '/api/agent/tools', '/api/users']) assert.equal((await call(PUB, p, { cookie })).status, 403, p);
  assert.equal((await call(PUB, '/api/agent/ask', { method: 'POST', body: { question: 'hi' }, cookie })).status, 403);
  assert.equal((await call(PUB, '/api/settings', { method: 'PUT', body: {}, cookie })).status, 403);
  assert.equal((await call(PUB, '/api/chat/view', { method: 'PUT', body: {}, cookie })).status, 403);
  const sym = (await call(PUB, '/api/dashboard', { cookie })).json.group?.items?.[0]?.id;
  if (sym) assert.ok(Array.isArray((await call(PUB, `/api/stock/${encodeURIComponent(sym)}`, { cookie })).json.chat.messages));
});

test('管理员：全部权限，可以管理账号；改密码后旧登录失效', async () => {
  const { cookie } = await call(PUB, '/api/auth/login', { method: 'POST', body: { name: 'boss', password: 'secret-pass-1' } });
  assert.equal((await call(PUB, '/api/settings', { cookie })).status, 200);
  const list = (await call(PUB, '/api/users', { cookie })).json;
  assert.equal(list.length, 2); assert.ok(!('hash' in list[0]) && !('salt' in list[0]));
  const friend = list.find((u) => u.name === 'friend');
  const f = (await call(PUB, '/api/auth/login', { method: 'POST', body: { name: 'friend', password: 'secret-pass-1' } })).cookie;
  assert.equal((await call(PUB, `/api/users/${friend.id}`, { method: 'PUT', body: { password: 'another-pass-2' }, cookie })).status, 200);
  assert.equal((await call(PUB, '/api/dashboard', { cookie: f })).status, 401);
  assert.equal((await call(PUB, `/api/users/${list.find((u) => u.name === 'boss').id}`, { method: 'DELETE', cookie })).status, 400); // 最后一个管理员不能删
});

test('伪造 / 篡改的会话令牌无效', async () => {
  assert.equal((await call(PUB, '/api/dashboard', { cookie: 'wb_session=eyJ1IjoieCJ9.abc' })).status, 401);
});
