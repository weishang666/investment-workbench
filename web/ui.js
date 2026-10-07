// 通用 UI 工具：API、格式化、AI 区块渲染（事实 / AI 分析 / 待验证 / 用户研究）、SVG 图表。
export const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
export const sign = (x) => (x > 0 ? '+' : '');
export const pct = (x) => (x == null ? '—' : `${sign(x)}${Number(x).toFixed(2)}%`);
export const num = (x, d) => (x == null || x === '' ? '—' : Number(x).toLocaleString('zh-CN', { maximumFractionDigits: d ?? (Math.abs(x) < 10 ? 4 : 2) }));
export const vol = (v) => (v == null ? '—' : v >= 1e8 ? `${(v / 1e8).toFixed(2)}亿` : v >= 1e4 ? `${(v / 1e4).toFixed(0)}万` : String(v));
export const big = (v) => (v == null ? '—' : v >= 1e12 ? `${(v / 1e12).toFixed(2)}万亿` : v >= 1e8 ? `${(v / 1e8).toFixed(0)}亿` : num(v));
export const code = (id) => String(id).split(':')[1];

export function timeAgo(iso) {
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < -60) { const m = -d / 60; return m < 60 ? `${Math.round(m)} 分钟后` : m < 1440 ? `${Math.round(m / 60)} 小时后` : `${Math.round(m / 1440)} 天后`; }
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}
export const fmtTime = (iso) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtClock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function delayLabel(q) {
  return q.delayMinutes ? `延迟 ${q.delayMinutes} 分钟` : '实时';
}

const TAG = { fact: ['已确认事实', 'tag-fact'], analysis: ['AI 分析', 'tag-analysis'], unverified: ['待验证', 'tag-unverified'], note: ['你的研究', 'tag-note'] };

export function legend() {
  return `<div class="legend">${Object.values(TAG).map(([t, c]) => `<span><span class="tag ${c}">${t}</span></span>`).join('')}</div>`;
}

/** 渲染 AI 输出区块，事实 / 推断 / 待验证 / 用户研究在视觉上明确区分 */
export function renderBlocks(blocks = [], evidence = []) {
  const evMap = new Map(evidence.map((e) => [e.id, e]));
  return `<div class="blocks">${blocks.map((b) => {
    if (b.kind === 'h') return `<div class="blk blk-h">${esc(b.text)}</div>`;
    const tag = TAG[b.kind];
    const refs = (b.evidence || []).filter((id) => evMap.has(id)).map((id) => `<span class="ev-ref" title="${esc(evMap.get(id).label + ' · ' + evMap.get(id).source)}">[${esc(evType(evMap.get(id).type))}]</span>`).join('');
    return `<div class="blk blk-${b.kind}">${tag ? `<span class="tag ${tag[1]}">${tag[0]}</span>` : ''}${esc(b.text)}${refs}</div>`;
  }).join('')}</div>${renderEvidence(evidence)}`;
}

const EV_TYPE = { data: '数据', news: '新闻', filing: '公告', chat: '群聊', note: '我的研究' };
const evType = (t) => EV_TYPE[t] || t;

export function renderEvidence(evidence = []) {
  if (!evidence.length) return '';
  return `<details class="evidence"><summary>证据链 · ${evidence.length} 条依据</summary>${evidence.map((e) => `
    <div class="ev-item"><span class="ev-type">${esc(evType(e.type))}</span><span>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)} <span class="faint">· ${esc(e.source)}${e.time ? ` · ${fmtTime(e.time)}` : ''}</span></span></div>`).join('')}</details>`;
}

// ---------------- 图表 ----------------
export function chartSvg(series, { height = 240, prevClose } = {}) {
  const pts = series.points || [];
  if (!pts.length) return '<div class="empty">暂无数据</div>';
  const W = 800; const H = height; const padL = 8; const padR = 56; const padT = 10; const volH = 40; const padB = 20;
  const priceH = H - padT - padB - volH - 6;
  const highs = pts.map((p) => p.h ?? p.c); const lows = pts.map((p) => p.l ?? p.c);
  let max = Math.max(...highs); let min = Math.min(...lows);
  if (prevClose) { max = Math.max(max, prevClose); min = Math.min(min, prevClose); }
  const span = max - min || 1; max += span * 0.05; min -= span * 0.05;
  const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / pts.length);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * priceH;
  const vmax = Math.max(...pts.map((p) => p.v || 0)) || 1;
  const bw = Math.max(1, ((W - padL - padR) / pts.length) * 0.65);
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    out += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${W - padR + 4}" y="${y(v) + 3}">${num(v)}</text>`;
  }
  const up = getComputedStyle(document.documentElement).getPropertyValue('--up').trim();
  const down = getComputedStyle(document.documentElement).getPropertyValue('--down').trim();
  if (series.kind === 'line') {
    const base = prevClose ?? pts[0].c;
    const color = pts[pts.length - 1].c >= base ? up : down;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
    out += `<path d="${d}L${x(pts.length - 1)},${padT + priceH}L${x(0)},${padT + priceH}Z" fill="${color}" opacity=".08"/>`;
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
    if (prevClose) out += `<line x1="${padL}" x2="${W - padR}" y1="${y(prevClose)}" y2="${y(prevClose)}" stroke="var(--faint)" stroke-dasharray="4 4"/><text class="axis" x="${padL + 2}" y="${y(prevClose) - 3}">昨收 ${num(prevClose)}</text>`;
  } else {
    pts.forEach((p, i) => {
      const c = p.c >= p.o ? up : down;
      out += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(p.h)}" y2="${y(p.l)}" stroke="${c}"/>`;
      out += `<rect x="${x(i) - bw / 2}" y="${Math.min(y(p.o), y(p.c))}" width="${bw}" height="${Math.max(1, Math.abs(y(p.o) - y(p.c)))}" fill="${c}"/>`;
    });
  }
  const vy = H - padB - volH;
  pts.forEach((p, i) => {
    const c = (p.c >= (p.o ?? pts[i - 1]?.c ?? p.c)) ? up : down;
    const h = ((p.v || 0) / vmax) * volH;
    out += `<rect x="${x(i) - bw / 2}" y="${vy + volH - h}" width="${bw}" height="${h}" fill="${c}" opacity=".45"/>`;
  });
  const labels = [0, Math.floor(pts.length / 2), pts.length - 1];
  for (const i of labels) {
    const t = new Date(pts[i].t);
    const s = series.kind === 'line' ? t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : t.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    out += `<text class="axis" x="${Math.min(W - padR - 30, Math.max(padL, x(i) - 14))}" y="${H - 4}">${s}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="价格走势图">${out}</svg>`;
}

export const PERIODS = [['intraday', '分时'], ['1D', '1日'], ['1W', '1周'], ['1M', '1月'], ['3M', '3月'], ['1Y', '1年']];

export function toast(title, body, onClick) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="t">${esc(title)}</div><div class="small muted">${esc(body || '')}</div>`;
  el.onclick = () => { onClick?.(); el.remove(); };
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
