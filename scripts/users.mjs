// 管理公网登录账号（存 data/users.json）。Docker 里运行：docker exec -it invest-workbench node scripts/users.mjs list
//   node scripts/users.mjs add <用户名> [admin|viewer]   新建账号（默认 viewer 只读），随后输入密码
//   node scripts/users.mjs passwd <用户名>               重设密码（旧登录全部失效）
//   node scripts/users.mjs role <用户名> <admin|viewer>  改角色
//   node scripts/users.mjs del <用户名>                  删除账号
//   node scripts/users.mjs list                          列出账号
// 也可以用环境变量 WB_PASSWORD 传密码（脚本化时用）。
import readline from 'node:readline';
import * as Auth from '../server/auth.js';

function askHidden(q) {
  if (process.env.WB_PASSWORD) return Promise.resolve(process.env.WB_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); }; // 不回显密码
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}
async function newPassword() {
  const a = await askHidden('密码（至少 8 位）：');
  if (!process.env.WB_PASSWORD && a !== await askHidden('再输一次：')) throw new Error('两次密码不一致');
  return a;
}
const byName = (n) => Auth.listUsers().find((u) => u.name.toLowerCase() === String(n || '').toLowerCase()) || (() => { throw new Error(`没有用户 ${n}`); })();

const [cmd, name, arg] = process.argv.slice(2);
try {
  if (cmd === 'add') { const u = Auth.addUser({ name, role: arg || 'viewer', password: await newPassword() }); console.log(`已创建 ${u.name}（${Auth.ROLES[u.role]}）`); }
  else if (cmd === 'passwd') { Auth.updateUser(byName(name).id, { password: await newPassword() }); console.log('已重设密码'); }
  else if (cmd === 'role') { Auth.updateUser(byName(name).id, { role: arg }); console.log('已修改角色'); }
  else if (cmd === 'del') { Auth.deleteUser(byName(name).id); console.log('已删除'); }
  else if (cmd === 'list') { const us = Auth.listUsers(); console.log(us.length ? us.map((u) => `${u.name}\t${Auth.ROLES[u.role]}\t最近登录 ${u.lastLoginAt || '—'}`).join('\n') : '还没有账号'); }
  else { console.log('用法见脚本开头注释：add / passwd / role / del / list'); process.exitCode = 1; }
} catch (e) { console.error(e.message); process.exitCode = 1; }
