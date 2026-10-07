// 把 invest-workbench skill 安装到本机 OpenClaw 工作区：npm run openclaw:install [-- <工作区目录>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../openclaw/skills/invest-workbench');
const workspace = process.argv[2] || process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace');
const dest = path.join(workspace, 'skills', 'invest-workbench');

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true, force: true });
console.log(`已安装 skill：${dest}`);
console.log('在 OpenClaw 里开一个新会话（/new）后生效，可以问它："用投研工作台看一下英伟达今天的情况"。');
console.log('接下来按 openclaw/README.md 第 2、3 步配置 Gateway，让工作台能把对话和分析任务交给 OpenClaw。');
