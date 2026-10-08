// 读取工作台根目录的 .env（KEY=VALUE 每行一条，# 开头为注释）。已存在的环境变量优先，不会被覆盖。
// .env 已在 .gitignore 中，只放本机密钥，不进 git。
import fs from 'node:fs';
import path from 'node:path';

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadEnv(file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../.env')) {
  if (!fs.existsSync(file)) return {};
  const vars = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  return vars;
}
