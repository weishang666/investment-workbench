#!/usr/bin/env node
// 投研工作台命令行客户端（供 OpenClaw 的 invest-workbench skill 调用）。只用 Node 内置模块。
//   node wb.mjs tools                         列出工具
//   node wb.mjs schema <tool>                 查看某个工具的参数
//   node wb.mjs call <tool> ['<json 参数>']    执行工具，输出 { data, evidence }
//   node wb.mjs result <kind> [--task ID] [--alert ID] [--symbol S] [--title T] [--file F]
//                                             把带标签的分析文本写回工作台（默认从 stdin 读取）
//   node wb.mjs ping                          检查工作台是否在运行
import fs from 'node:fs';

const BASE = (process.env.WORKBENCH_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const [cmd, ...args] = process.argv.slice(2);

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    fail(`连不上投研工作台 ${BASE}（${e.cause?.code || e.message}）。请确认已在本机运行 npm start，或设置 WORKBENCH_URL。`);
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) fail(`工作台返回 ${res.status}：${typeof data === 'string' ? data : data.error || JSON.stringify(data)}`);
  return data;
}

function fail(msg) { console.error(msg); process.exit(1); }
function flag(name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 1));

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

switch (cmd) {
  case 'ping': {
    const m = await req('GET', '/api/meta');
    out(`工作台在线：${BASE}；演示数据：${(m.mocked || []).join('、') || '无'}`);
    break;
  }
  case 'tools': {
    const tools = await req('GET', '/api/agent/tools');
    out(tools.map((t) => `${t.name}: ${t.description}`).join('\n'));
    break;
  }
  case 'schema': {
    const tools = await req('GET', '/api/agent/tools');
    const t = tools.find((x) => x.name === args[0]);
    if (!t) fail(`没有工具 ${args[0]}，可用：${tools.map((x) => x.name).join(', ')}`);
    out(t);
    break;
  }
  case 'call': {
    const [name, json] = args;
    if (!name) fail('用法：node wb.mjs call <tool> \'{"symbol":"NVDA"}\'');
    let input = {};
    if (json) { try { input = JSON.parse(json); } catch { fail(`参数不是合法 JSON：${json}`); } }
    out(await req('POST', `/api/agent/tools/${encodeURIComponent(name)}`, input));
    break;
  }
  case 'result': {
    const kind = args[0];
    if (!kind || kind.startsWith('--')) fail('用法：node wb.mjs result <move_analysis|premarket|postclose|chat_summary|research|report|other> [--task ID] [--alert ID] [--symbol S] [--title T] [--file F] < 报告.md');
    const file = flag('file');
    const text = file ? fs.readFileSync(file, 'utf8') : await readStdin();
    if (!text.trim()) fail('结果为空：请通过 stdin 或 --file 提供带【事实】/【AI分析】/【待验证】/【用户研究】标签的文本');
    const r = await req('POST', '/api/agent/results', { kind, text, task: flag('task'), alert: flag('alert'), symbol: flag('symbol'), title: flag('title') });
    out(`已写回工作台：analysisId=${r.analysisId}${r.attachedTo ? `，已挂到提醒 ${r.attachedTo}` : ''}，解析到 ${r.evidenceResolved} 条证据`);
    break;
  }
  default:
    out('命令：ping | tools | schema <tool> | call <tool> [json] | result <kind> [--task --alert --symbol --title --file]');
    if (cmd) process.exit(1);
}
