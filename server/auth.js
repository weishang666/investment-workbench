// 登录与权限：给"公网入口"用。账号存 data/users.json（已在 .gitignore 的 data/* 里），密码用 scrypt 加盐哈希。
// 两个端口：PORT（默认 3000，本机 / 局域网，行为不变，免登录）；PUBLIC_PORT（如 3001，给公网隧道用，必须登录）。
// 角色：admin 全部权限；viewer 只读，只能访问下面白名单里的 GET 接口（含群聊洞察和群聊原文），AI 对话、设置、写操作一律拒绝。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.USERS_FILE || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/users.json');
const COOKIE = 'wb_session';
const TTL_DAYS = 30;
export const ROLES = { admin: '管理员', viewer: '只读' };

let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = { users: [] }; }
  if (!store.secret) { store.secret = crypto.randomBytes(32).toString('hex'); persist(); }
  return store;
}
function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
export function _reset(s = { users: [] }) { store = s; } // 测试用

const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const clean = (u) => u && { id: u.id, name: u.name, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
const find = (name) => load().users.find((u) => u.name.toLowerCase() === String(name || '').trim().toLowerCase());
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export const listUsers = () => load().users.map(clean);
export const hasUsers = () => load().users.length > 0;

export function addUser({ name, password, role = 'viewer' }) {
  name = String(name || '').trim();
  if (!/^[\w.\-一-龥]{2,32}$/.test(name)) throw bad('用户名 2-32 位，可用中文、字母、数字、_ . -');
  if (String(password || '').length < 8) throw bad('密码至少 8 位');
  if (!ROLES[role]) throw bad('角色只能是 admin 或 viewer');
  if (find(name)) throw bad('用户名已存在');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: 'u_' + crypto.randomBytes(6).toString('hex'), name, role, salt, hash: hash(password, salt), createdAt: new Date().toISOString() };
  load().users.push(u); persist();
  return clean(u);
}
export function updateUser(id, { password, role }) {
  const u = load().users.find((x) => x.id === id); if (!u) throw bad('用户不存在', 404);
  if (role) {
    if (!ROLES[role]) throw bad('角色只能是 admin 或 viewer');
    if (u.role === 'admin' && role !== 'admin' && load().users.filter((x) => x.role === 'admin').length === 1) throw bad('至少保留一个管理员');
    u.role = role;
  }
  if (password) {
    if (String(password).length < 8) throw bad('密码至少 8 位');
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hash(password, u.salt); // 改密码会让旧登录全部失效
  }
  persist(); return clean(u);
}
export function deleteUser(id) {
  const s = load(); const u = s.users.find((x) => x.id === id); if (!u) throw bad('用户不存在', 404);
  if (u.role === 'admin' && s.users.filter((x) => x.role === 'admin').length === 1) throw bad('至少保留一个管理员');
  s.users = s.users.filter((x) => x.id !== id); persist(); return { ok: true };
}

// 会话令牌：base64url(JSON) + HMAC。签名里带上用户密码哈希，删号 / 改密码后旧令牌立即失效。
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload, u) => crypto.createHmac('sha256', load().secret).update(payload + '|' + u.hash).digest('base64url');
function issue(u) {
  const payload = b64(JSON.stringify({ u: u.id, exp: Date.now() + TTL_DAYS * 86400e3 }));
  return `${payload}.${sign(payload, u)}`;
}
function verify(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  let p; try { p = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  const u = load().users.find((x) => x.id === p.u);
  if (!u || !(p.exp > Date.now())) return null;
  const want = Buffer.from(sign(payload, u)); const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? u : null;
}
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
export const sessionUser = (req) => verify(cookies(req)[COOKIE]);

// 登录失败限流：同一来源 IP 15 分钟内最多失败 10 次
const fails = new Map();
const clientIp = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
export function login(req, { name, password }) {
  const ip = clientIp(req); const now = Date.now();
  const f = (fails.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  if (f.length >= 10) throw bad('失败次数过多，请 15 分钟后再试', 429);
  const u = find(name);
  // 用户不存在时也算一次哈希，避免通过响应时间探测用户名
  const ok = u ? crypto.timingSafeEqual(Buffer.from(hash(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex')) : (hash(password, 'x'), false);
  if (!ok) { f.push(now); fails.set(ip, f); throw bad('用户名或密码错误', 401); }
  fails.delete(ip);
  u.lastLoginAt = new Date().toISOString(); persist();
  return { user: clean(u), cookie: cookieHeader(req, issue(u), TTL_DAYS * 86400) };
}
export const logoutCookie = (req) => cookieHeader(req, '', 0);
function cookieHeader(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// 只读账号可访问的接口（只限 GET）。新加的接口默认只有管理员能用。
const VIEWER_GET = [
  /^\/api\/meta$/, /^\/api\/me$/, /^\/api\/stream$/, /^\/api\/dashboard$/, /^\/api\/macro$/,
  /^\/api\/quote\/[^/]+$/, /^\/api\/bars\/[^/]+$/, /^\/api\/instruments\/search$/, /^\/api\/watchlist$/,
  /^\/api\/stock\/[^/]+$/, /^\/api\/stock\/[^/]+\/company$/, /^\/api\/research\/[^/]+\/diff$/,
  /^\/api\/news$/, /^\/api\/news\/status$/, /^\/api\/briefs$/, /^\/api\/chat\/hot$/, /^\/api\/alerts$/, /^\/api\/analyses\/[^/]+$/,
  /^\/api\/chat\/messages$/, /^\/api\/chat\/digest$/, /^\/api\/chat\/groups$/, /^\/api\/chat\/view$/,
];
export const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/me']);
export function allowed(user, method, pathname) {
  if (user.role === 'admin') return true;
  return method === 'GET' && VIEWER_GET.some((re) => re.test(pathname));
}
// 只读账号看到的数据再做一次裁剪的钩子；目前群聊原文也对只读账号开放，原样返回
export function redact(user, pathname, out) {
  return out;
}
