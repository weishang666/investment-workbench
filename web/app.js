// 个人投研工作台前端：投资大屏 / 标的研究详情 / 提醒中心 / 群聊洞察 / 自选与导入 / 规则与任务
import { api, esc, cls, pct, num, vol, big, code, timeAgo, fmtTime, fmtClock, delayLabel, srcBadge, isReal, renderBlocks, legend, chartSvg, PERIODS, toast } from './ui.js';
import { initAgent, askAgent, refreshContext } from './agentPanel.js';

const app = document.getElementById('app');
const S = { route: null, ctx: { page: 'dashboard' }, dash: null, focus: null, groupTab: null, period: 'intraday', meta: null, stock: null, detailPeriod: 'intraday', expanded: new Set() };

try { const ud = localStorage.getItem('updown'); if (ud) document.documentElement.dataset.updown = ud; } catch { /* 无痕模式 */ }

initAgent(() => S.ctx);

// ---------------- 路由 ----------------
const routes = [
  [/^#?\/?$/, () => dashboard()],
  [/^#\/stock\/(.+)$/, (m) => stockPage(decodeURIComponent(m[1]))],
  [/^#\/alerts$/, () => alertsPage()],
  [/^#\/macro$/, () => macroPage()],
  [/^#\/chat$/, () => chatPage()],
  [/^#\/watchlist$/, () => watchlistPage()],
  [/^#\/settings$/, () => settingsPage()],
];

async function router() {
  const h = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      S.route = h;
      document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === h || (h === '#/' && a.dataset.nav === 'dashboard')));
      try { await fn(m); } catch (e) { app.innerHTML = `<div class="panel"><b>页面加载失败</b><div class="muted">${esc(e.message)}</div></div>`; console.error(e); }
      refreshContext();
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); router(); });

// ---------------- 元信息 / 搜索 / 实时推送 ----------------
async function loadMeta() {
  S.meta = await api('/api/meta');
  const pill = document.getElementById('meta-pill');
  pill.textContent = `${S.meta.model === 'openclaw' ? '本机 OpenClaw' : S.meta.llm ? 'Claude' : '本地规则'} · ${S.meta.gangtise ? 'Gangtise 实时 + 部分演示' : '演示数据'}`;
  pill.className = S.meta.gangtise ? 'pill' : 'pill warn';
  pill.title = `${S.meta.real?.length ? `真实数据：${S.meta.real.join('、')}。\n` : ''}演示数据（Mock）：${S.meta.mocked.join('、')}。\n行情来源：${S.meta.marketSource}。`;
}

const searchInput = document.getElementById('global-search');
const searchBox = document.getElementById('search-results');
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = searchInput.value.trim();
    if (!q) { searchBox.hidden = true; return; }
    const rows = await api(`/api/instruments/search?q=${encodeURIComponent(q)}`);
    searchBox.innerHTML = rows.length ? rows.map((r) => `<a href="#/stock/${encodeURIComponent(r.id)}"><span>${esc(r.name)} <span class="faint small">${esc(r.id)}</span></span><span class="${cls(r.quote.changePct)} mono">${pct(r.quote.changePct)}</span></a>`).join('') : '<div class="empty">没有匹配的标的</div>';
    searchBox.hidden = false;
  }, 150);
});
searchBox.addEventListener('click', () => { searchBox.hidden = true; searchInput.value = ''; });
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) searchBox.hidden = true; });

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('quotes', (e) => onQuotes(JSON.parse(e.data)));
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    toast(`【${a.category}】${a.title}`, a.body, () => { location.hash = a.symbol ? `#/stock/${encodeURIComponent(a.symbol)}` : '#/alerts'; });
    bumpUnread(1);
    if (S.route === '#/' || S.route === '#/alerts') softRefresh();
  });
  es.addEventListener('alert-updated', () => { if (S.route === '#/alerts' || S.route === '#/') softRefresh(); });
}
let refreshTimer;
function softRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(router, 400); }

function onQuotes(list) {
  for (const q of list) {
    document.querySelectorAll(`[data-q="${CSS.escape(q.id)}"]`).forEach((el) => {
      const f = el.dataset.f;
      if (f === 'last') el.textContent = num(q.last);
      if (f === 'pct') { el.textContent = pct(q.changePct); el.className = `${cls(q.changePct)} mono`; }
      if (f === 'chg') { el.textContent = `${q.change > 0 ? '+' : ''}${num(q.change)}`; el.className = `${cls(q.change)} mono`; }
      if (f === 'vol') el.textContent = vol(q.volume);
      if (f === 'time') el.textContent = fmtClock(q.updatedAt);
    });
  }
  const t = document.getElementById('dash-updated');
  if (t && list.length) t.textContent = `最近数据更新 ${fmtClock(list[0].updatedAt)}`;
}

let unread = 0;
function bumpUnread(n, set) {
  unread = set ? n : unread + n;
  const b = document.getElementById('nav-unread');
  b.hidden = !unread; b.textContent = unread;
}

// ---------------- 通用片段 ----------------
const dn = (i) => i.userName || i.name;
const live = (id, f, text, extra = '') => `<span data-q="${esc(id)}" data-f="${f}" ${extra}>${text}</span>`;
const stars = (n) => `<span class="stars" title="重要程度 ${n}/3">${'★'.repeat(n)}${'☆'.repeat(3 - n)}</span>`;
const SESSION = { pre: '盘前', regular: '交易中', post: '盘后', closed: '休市' };

function alertCard(a, { compact } = {}) {
  const sym = a.symbol ? `<a class="chip" href="#/stock/${encodeURIComponent(a.symbol)}">${esc(code(a.symbol))}</a>` : '';
  let extra = '';
  if (a.type === 'chat' && a.data?.stats) {
    const st = a.data.stats;
    extra = `<div class="heat-card"><div><b>${st.effectiveGroupCount}</b><span>涉及群</span></div><div><b>${st.userCount}</b><span>讨论人数</span></div><div><b>${st.messageCount}</b><span>相关消息</span></div><div><b class="${cls(st.heatChangePct)}">${st.heatChangePct == null ? '新' : `${st.heatChangePct > 0 ? '+' : ''}${st.heatChangePct}%`}</b><span>热度变化</span></div></div>
      ${st.topics.length ? `<div class="small">主要讨论：${st.topics.slice(0, 4).map((t) => esc(t.name)).join('、')}</div>` : ''}
      ${st.bull[0] ? `<div class="small"><span class="up">看多：</span>${esc(st.bull[0].content)}</div>` : ''}
      ${st.bear[0] ? `<div class="small"><span class="down">看空：</span>${esc(st.bear[0].content)}</div>` : ''}
      ${st.spreading.length ? `<div class="small" style="color:var(--unverified)">信息正在传播：同一段内容出现在 ${st.spreading[0].groups.length} 个群，不代表独立共识。</div>` : ''}
      <details class="evidence"><summary>查看群聊证据</summary>${st.groups.map((g) => `<div class="small">${esc(g.groupName)} <span class="faint">(${esc(g.platform)})</span>：${g.messages} 条 / ${g.users} 人 ${g.effective ? '· 有效讨论' : ''} ${g.effective && !g.independent ? '· 主要为转发内容' : ''}</div>`).join('')}
        <div style="margin-top:6px"><a href="#/chat" class="small">打开群聊洞察 →</a></div></details>
      <div class="disclaimer">${esc(a.data.disclaimer)}</div>`;
  }
  let analysis = '';
  if (a.analysis?.status === 'pending') {
    analysis = `<div class="small faint">${esc(a.analysis.summary || 'OpenClaw 正在分析原因…')}</div>`;
  } else if (a.analysis && !compact) {
    analysis = `<details class="evidence" ${S.expanded.has(a.id) ? 'open' : ''} data-exp="${a.id}"><summary>OpenClaw 分析：${esc(a.analysis.summary || '已完成')}</summary>${renderBlocks(a.analysis.blocks, a.analysis.evidence)}</details>`;
  } else if (a.analysis && compact) {
    analysis = `<div class="small" style="color:var(--analysis)">AI：${esc(a.analysis.summary)}</div>`;
  } else if (a.type === 'price') {
    analysis = '<div class="small faint">OpenClaw 正在分析原因…</div>';
  }
  return `<div class="alert ${a.status} sev-${a.severity}">
    <div class="alert-meta"><span class="cat">${esc(a.category)}</span>${sym}<span>${timeAgo(a.createdAt)}</span><span class="spacer"></span><span>${{ unread: '未读', read: '已读', handled: '已处理', ignored: '已忽略' }[a.status]}</span></div>
    <div class="alert-title">${esc(a.title)}</div>
    ${compact ? '' : `<div class="alert-body">${esc(a.body)}</div>`}
    ${extra}${analysis}
    <div class="alert-actions">
      ${a.status === 'unread' ? `<button class="btn sm" data-st="read" data-id="${a.id}">标为已读</button>` : ''}
      ${a.status !== 'handled' ? `<button class="btn sm" data-st="handled" data-id="${a.id}">已处理</button>` : ''}
      ${a.status !== 'ignored' ? `<button class="btn sm ghost" data-st="ignored" data-id="${a.id}">忽略</button>` : ''}
      ${a.symbol && !compact ? `<button class="btn sm ghost" data-ask="${esc(`${code(a.symbol)} ${a.title}，帮我分析原因`)}">问 OpenClaw</button>` : ''}
    </div></div>`;
}

function bindAlertActions(root) {
  root.querySelectorAll('[data-st]').forEach((b) => { b.onclick = async (e) => { e.stopPropagation(); await api(`/api/alerts/${b.dataset.id}/status`, { method: 'POST', body: { status: b.dataset.st } }); router(); }; });
  root.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => askAgent(b.dataset.ask); });
  root.querySelectorAll('[data-exp]').forEach((d) => { d.ontoggle = () => (d.open ? S.expanded.add(d.dataset.exp) : S.expanded.delete(d.dataset.exp)); });
}

function eventItem(e, open) {
  const s = e.summary;
  return `<div class="event">
    <div class="event-title" data-toggle>${esc(e.title)}</div>
    <div class="event-meta"><span class="imp" title="重要性 ${e.importance}（时效 ${e.importanceParts.recency} / 影响 ${e.importanceParts.impact} / 自选相关 ${e.importanceParts.relevance}）"><i style="width:${Math.round(e.importance * 100)}%"></i></span>
      <span>${timeAgo(e.firstSeen)}</span><span>${e.sourceCount} 个来源${e.hasOfficial ? ' · 含官方' : ''}</span>
      ${e.entities.slice(0, 4).map((x) => `<a class="chip" href="#/stock/${encodeURIComponent(x)}">${esc(code(x))}</a>`).join('')}</div>
    <div class="event-body" ${open ? '' : 'hidden'}>
      <div class="blk blk-fact"><span class="tag tag-fact">发生了什么</span>${esc(s.what.text)}</div>
      ${s.changes.map((c) => `<div class="blk blk-${c.kind}"><span class="tag tag-${c.kind}">${c.kind === 'fact' ? '关键变化' : '待验证'}</span>${esc(c.text)}</div>`).join('')}
      <div class="blk blk-analysis"><span class="tag tag-analysis">潜在影响 · AI 推断</span>${esc(s.impact.text)}</div>
      <div class="small faint">信息来源：${e.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)}</a>${x.sourceType === 'official' ? '（官方）' : ''} ${fmtTime(x.publishedAt)}`).join('；')}</div>
    </div></div>`;
}
function bindToggles(root) {
  root.querySelectorAll('[data-toggle]').forEach((t) => { t.onclick = () => { const b = t.parentElement.querySelector('.event-body'); b.hidden = !b.hidden; }; });
}

// ================= 投资大屏 =================
async function dashboard() {
  S.ctx = { page: 'dashboard' };
  const d = await api(`/api/dashboard${S.groupTab ? `?group=${S.groupTab}` : ''}`);
  S.dash = d;
  bumpUnread(d.alertCounts.unread, true);
  const group = d.group;
  S.groupTab = group?.id;
  const cats = [...new Set(d.groups.map((g) => g.category))];
  const curCat = group?.category || cats[0];
  if (!S.focus || !group?.items.find((i) => i.symbol === S.focus)) S.focus = group?.items[0]?.symbol;

  app.innerHTML = `
    <div class="strip-head"><h2>宏观行情</h2><span class="small faint" id="dash-updated">最近数据更新 ${fmtClock(d.updatedAt)}</span><span class="spacer"></span><a class="small" href="#/macro">全部宏观指标（${d.macroCount}）→</a></div>
    <div class="macro-strip">${d.macro.map((m) => `
      <div class="macro-card" data-go="${esc(m.id)}" title="${esc(`${m.name}（${m.id}）\n来源：${m.quote.source}\n${delayLabel(m.quote)} · ${SESSION[m.quote.session]}${m.contract ? `\n合约：${m.contract.kind === 'continuous' ? '连续合约' : '具体合约'}，当前 ${m.contract.current}，主力 ${m.contract.main}\n换月：${m.contract.rollRule}` : ''}`)}">
        <div class="name">${esc(dn(m))}</div>
        <div class="price mono">${live(m.id, 'last', num(m.quote.last))}</div>
        <div class="row" style="justify-content:space-between">${live(m.id, 'pct', pct(m.quote.changePct), `class="${cls(m.quote.changePct)} mono"`)}<span class="small faint">${esc(code(m.id))}</span></div>
        <div class="meta"><span>${m.contract ? `连续·${esc(m.contract.main)}` : esc(m.market)} ${srcBadge(isReal(m.quote), m.quote.source)}</span><span>${delayLabel(m.quote)} · ${SESSION[m.quote.session]}</span></div>
      </div>`).join('')}</div>

    <div class="dash-grid">
      <div class="col-left">
        <div class="panel"><div class="panel-head"><h3>投资事件流</h3>${srcBadge(false, '新闻暂为演示数据，后续接入真实新闻源')}<span class="spacer"></span><span class="small faint">已去重 · 已聚合</span></div>
          ${d.news.slice(0, 7).map((e, i) => eventItem(e, i === 0)).join('') || '<div class="empty">暂无事件</div>'}</div>
        <div class="panel"><div class="panel-head"><h3>经济日历 · 财报日</h3><span class="spacer"></span><span class="small faint">宏观数据 ${srcBadge(false, '宏观经济日历暂为演示数据')} · 自选股财报日 ${srcBadge(d.calendar.some((c) => c.kind === 'earnings'), 'Gangtise 业绩日历')}</span></div>
          ${d.calendar.map((c) => c.kind === 'earnings'
            ? `<div class="cal-row"><span class="small">${esc(c.time.slice(0, 10))}</span>
            <span>${stars(c.importance)} <a href="#/stock/${encodeURIComponent(c.symbol)}">${esc(c.country)}</a> ${esc(c.event)}</span>
            <span class="cal-vals">${srcBadge(true, c.source)}</span></div>`
            : `<div class="cal-row"><span class="small ${new Date(c.time) < Date.now() ? 'faint' : ''}">${fmtTime(c.time)}</span>
            <span>${stars(c.importance)} <span class="small muted">${esc(c.country)}</span> ${esc(c.event)}</span>
            <span class="cal-vals">前值 ${c.previous}${esc(c.unit)} · 预期 ${c.forecast}${esc(c.unit)} · ${c.actual != null ? `<b class="${cls(c.actual - c.forecast)}">公布 ${c.actual}${esc(c.unit)}</b>` : '<span class="faint">待公布</span>'}</span></div>`).join('')}</div>
      </div>

      <div class="col-center">
        <div class="panel"><div class="panel-head"><h3>自选标的</h3><div class="tabs">${cats.map((c) => `<button class="tab ${c === curCat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
          <div class="row wrap" style="margin-bottom:8px">${d.groups.filter((g) => g.category === curCat).map((g) => `<button class="chip ${g.id === S.groupTab ? 'chip-on' : ''}" data-group="${g.id}">${esc(g.name)} · ${g.count}${g.moved ? ` <span class="flag move">${g.moved} 异动</span>` : ''}</button>`).join('')}</div>
          <div class="table-wrap"><table class="grid"><thead><tr><th>股票</th><th class="num">最新价</th><th class="num">涨跌幅</th><th class="num">成交量</th><th>状态</th><th></th></tr></thead><tbody>
          ${(group?.items || []).map((i) => `<tr class="clickable ${i.symbol === S.focus ? 'focused' : ''}" data-focus="${esc(i.symbol)}">
            <td>${i.pinned ? '<span class="pin" title="置顶">▲</span> ' : ''}<a href="#/stock/${encodeURIComponent(i.symbol)}"><b>${esc(code(i.symbol))}</b></a> <span class="muted">${esc(dn(i))}</span><div class="small faint intro" title="${esc(i.intro || '')}">${esc(i.id.split(':')[0])}${i.intro && i.intro !== dn(i) ? ` · ${esc(i.intro)}` : ''}</div></td>
            <td class="num mono">${live(i.symbol, 'last', num(i.quote.last))}</td>
            <td class="num">${live(i.symbol, 'pct', pct(i.quote.changePct), `class="${cls(i.quote.changePct)} mono"`)}</td>
            <td class="num mono">${live(i.symbol, 'vol', vol(i.quote.volume))}</td>
            <td class="small">${i.moved ? '<span class="flag move">异动</span> ' : ''}<span class="faint">${SESSION[i.quote.session]}${!isReal(i.quote) && i.quote.delayMinutes ? ` · 延迟${i.quote.delayMinutes}分` : ''}</span> ${srcBadge(isReal(i.quote), i.quote.source)}</td>
            <td><a class="small" href="#/stock/${encodeURIComponent(i.symbol)}">研究 →</a></td></tr>`).join('')}
          </tbody></table></div>
          <div class="chart-box" id="focus-chart"></div>
        </div>
        ${d.briefs.length ? `<div class="panel"><div class="panel-head"><h3>每日简报</h3></div>${d.briefs.map((b) => `<div class="small"><a href="#" data-analysis="${b.analysisId}">${esc(b.title)}</a> <span class="faint">${timeAgo(b.createdAt)}</span></div>`).join('')}<div id="brief-view"></div></div>` : ''}
      </div>

      <div class="col-right">
        <div class="panel"><div class="panel-head"><h3>群聊洞察</h3><span class="spacer"></span><span class="small faint">最近 60 分钟</span></div>
          ${d.chat.length ? d.chat.map((s) => {
            const max = Math.max(...d.chat.map((x) => x.messageCount));
            const b = s.bull.length; const r = s.bear.length;
            return `<div class="hot"><div class="row"><a href="#/stock/${encodeURIComponent(s.symbol)}"><b>${esc(code(s.symbol))}</b></a><span class="muted small">${esc(s.name || '')}</span><span class="spacer"></span>
              <span class="small ${cls(s.heatChangePct)}">${s.heatChangePct == null ? '新出现' : `${s.heatChangePct > 0 ? '+' : ''}${s.heatChangePct}%`}</span></div>
              <div class="heat-bar"><i style="width:${Math.round((s.messageCount / max) * 100)}%"></i></div>
              <div class="small muted">${s.effectiveGroupCount}/${s.groupCount} 个群有效讨论 · ${s.userCount} 人 · ${s.messageCount} 条${s.spreading.length ? ' · <span style="color:var(--unverified)">有转发传播</span>' : ''}</div>
              ${s.topics.length ? `<div class="small faint">话题：${s.topics.slice(0, 3).map((t) => esc(t.name)).join('、')}</div>` : ''}
              ${b + r ? `<div class="row small" style="margin-top:4px"><span class="up">多 ${b}</span><div class="split" style="flex:1"><div class="b" style="width:${(b / (b + r)) * 100}%"></div><div class="s" style="width:${(r / (b + r)) * 100}%"></div></div><span class="down">空 ${r}</span></div>` : ''}
            </div>`;
          }).join('') : '<div class="empty">最近 60 分钟没有识别到标的讨论</div>'}
          <div class="disclaimer">群聊热度仅代表关注度，不代表投资建议或买卖信号。</div>
        </div>
      </div>

      <div class="col-alerts">
        <div class="panel"><div class="panel-head"><h3>统一提醒中心</h3><span class="badge">${d.alertCounts.unread}</span><span class="spacer"></span><a class="small" href="#/alerts">全部 →</a></div>
          <div id="dash-alerts">${d.alerts.slice(0, 10).map((a) => alertCard(a, { compact: true })).join('') || '<div class="empty">没有待处理的提醒</div>'}</div></div>
      </div>
    </div>`;

  app.querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => { location.hash = `#/stock/${encodeURIComponent(el.dataset.go)}`; }; });
  app.querySelectorAll('[data-group]').forEach((el) => { el.onclick = () => { S.groupTab = el.dataset.group; S.focus = null; dashboard(); }; });
  app.querySelectorAll('[data-cat]').forEach((el) => { el.onclick = () => { S.groupTab = d.groups.find((g) => g.category === el.dataset.cat)?.id; S.focus = null; dashboard(); }; });
  app.querySelectorAll('[data-focus]').forEach((el) => { el.onclick = (e) => { if (e.target.closest('a')) return; S.focus = el.dataset.focus; app.querySelectorAll('[data-focus]').forEach((r) => r.classList.toggle('focused', r === el)); renderFocusChart(); }; });
  app.querySelectorAll('[data-analysis]').forEach((el) => { el.onclick = async (e) => { e.preventDefault(); const a = await api(`/api/analyses/${el.dataset.analysis}`); document.getElementById('brief-view').innerHTML = `<div style="margin-top:10px">${renderBlocks(a.blocks, a.evidence)}</div>`; }; });
  bindToggles(app);
  bindAlertActions(app);
  renderFocusChart();
}

async function renderFocusChart() {
  const box = document.getElementById('focus-chart');
  if (!box || !S.focus) return;
  const item = S.dash.group?.items.find((i) => i.symbol === S.focus);
  const series = await api(`/api/bars/${encodeURIComponent(S.focus)}?period=${S.period}`);
  box.innerHTML = `<div class="row"><b>${esc(item ? dn(item) : S.focus)}</b><span class="faint small">${esc(S.focus)}</span><span class="spacer"></span>
    <div class="tabs">${PERIODS.map(([k, l]) => `<button class="tab ${k === S.period ? 'active' : ''}" data-period="${k}">${l}</button>`).join('')}</div></div>
    ${chartSvg(series, { prevClose: series.kind === 'line' ? item?.quote.prevClose : undefined })}
    <div class="small faint">来源：${esc(item?.quote.source)} · ${delayLabel(item?.quote || {})} · 更新于 ${live(S.focus, 'time', fmtClock(item?.quote.updatedAt))}</div>`;
  box.querySelectorAll('[data-period]').forEach((b) => { b.onclick = () => { S.period = b.dataset.period; renderFocusChart(); }; });
}

// ================= 宏观指标 =================
async function macroPage() {
  S.ctx = { page: 'macro' };
  const groups = await api('/api/macro');
  app.innerHTML = `<div class="strip-head"><h2>宏观指标与商品</h2><span class="small faint">现货、期货、CFD、ETF 分别列示，始终标注来源与延迟</span></div>
    <div class="macro-groups">${groups.map((g) => `<div class="panel"><div class="panel-head"><h3>${esc(g.name)}</h3><span class="small faint">${g.items.length}</span></div>
      <div class="table-wrap"><table class="grid"><thead><tr><th>名称</th><th>代码</th><th>类型</th><th class="num">最新</th><th class="num">涨跌幅</th><th>状态</th></tr></thead><tbody>
      ${g.items.filter((i) => i.quote).map((i) => `<tr class="clickable" data-go="${esc(i.symbol)}"><td>${i.pinned ? '<span class="pin" title="显示在大屏顶部">▲</span> ' : ''}${esc(dn(i))}</td><td class="small faint">${esc(i.symbol)}</td><td class="small">${esc(TYPE_LABEL[i.type] || i.type)}${i.contract ? ` · ${esc(i.contract.main)}` : ''}</td>
        <td class="num mono">${live(i.symbol, 'last', num(i.quote.last))}</td><td class="num">${live(i.symbol, 'pct', pct(i.quote.changePct), `class="${cls(i.quote.changePct)} mono"`)}</td><td class="small faint">${SESSION[i.quote.session]} · ${delayLabel(i.quote)}</td></tr>`).join('')}
      </tbody></table></div></div>`).join('')}</div>`;
  app.querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => { location.hash = `#/stock/${encodeURIComponent(el.dataset.go)}`; }; });
}
const TYPE_LABEL = { commodity_spot: '现货', future: '期货', index: '指数', fx: '汇率', bond_yield: '收益率', cfd: 'CFD', stock: '股票/ETF', crypto: '加密', spread: '比值/价差', econ: '经济数据' };

// ================= 标的研究详情页 =================
async function stockPage(id) {
  const d = await api(`/api/stock/${encodeURIComponent(id)}`);
  S.stock = d;
  S.ctx = { page: 'stock', symbol: id, name: dn(d) };
  const q = d.quote;
  const isStock = d.type === 'stock';
  const hasCompany = isStock && (d.financials || d.hasCompanyKb);
  app.innerHTML = `
    <div class="stock-head">
      <div><div class="muted small">${esc(d.market)} · ${esc(d.id)}${d.sector ? ` · ${esc(d.sector)}` : ''}${d.themes?.length ? ` · ${d.themes.map(esc).join('、')}` : ''}</div><h1>${esc(dn(d))} <span class="muted" style="font-size:16px">${esc(code(d.id))}</span></h1>${d.intro ? `<div class="small muted">${esc(d.intro)}</div>` : ''}${d.origins?.length ? `<div class="small faint">TradingView 原列表：${d.origins.map(esc).join('；')}</div>` : ''}</div>
      <div><div class="px mono">${live(d.id, 'last', num(q.last))}</div></div>
      <div>${live(d.id, 'chg', `${q.change > 0 ? '+' : ''}${num(q.change)}`, `class="${cls(q.change)} mono"`)} ${live(d.id, 'pct', pct(q.changePct), `class="${cls(q.changePct)} mono"`)}<div class="small faint">${SESSION[q.session]} · ${delayLabel(q)}</div></div>
      <span class="spacer"></span>
      <button class="btn" data-ask="为什么今天${q.changePct >= 0 ? '涨' : '跌'}这么多？">为什么${q.changePct >= 0 ? '涨' : '跌'}？</button>
      <button class="btn" data-ask="根据最近财报重新检查我的投资逻辑">检查我的投资逻辑</button>
      <button class="btn primary" data-ask="帮我生成一份投资研究报告">生成研究报告</button>
    </div>
    <div class="kv" style="margin-bottom:14px">
      <div><span>昨收</span><b class="mono">${num(q.prevClose)}</b></div><div><span>今开</span><b class="mono">${num(q.open)}</b></div>
      <div><span>最高 / 最低</span><b class="mono">${num(q.high)} / ${num(q.low)}</b></div>
      ${q.volume != null ? `<div><span>成交量</span><b class="mono">${live(d.id, 'vol', vol(q.volume))}</b></div>` : ''}
      ${q.marketCap ? `<div><span>市值</span><b class="mono">${big(q.marketCap)}</b></div>` : ''}
      <div><span>数据来源</span><b class="small">${srcBadge(isReal(q), q.source)} ${esc(q.source)}${q.asOf ? ` · 交易所时间 ${esc(q.asOf)}` : ''}</b></div>
      <div><span>行情时间</span><b class="mono small">${live(d.id, 'time', fmtClock(q.updatedAt))}</b></div>
      ${d.contract ? `<div><span>合约</span><b class="small">${d.contract.kind === 'continuous' ? '连续合约' : '具体合约'} · 当前 ${esc(d.contract.current)} · 主力 ${esc(d.contract.main)}</b></div><div style="grid-column: span 2"><span>换月规则</span><b class="small">${esc(d.contract.rollRule)}</b></div>` : ''}
    </div>

    <div class="detail-grid">
      <div>
        <div class="panel" id="sec-chart"></div>
        ${isStock && d.financials ? financialPanel(d) : ''}
        ${hasCompany ? `<div class="panel" id="sec-company"><div class="panel-head"><h3>AI 公司研究</h3><span class="ai-badge">AI 分析</span><span class="spacer"></span><button class="btn sm" data-ask="分析一下${esc(d.name)}">让 OpenClaw 重新分析</button></div><div id="company-body" class="empty">加载中…</div></div>` : ''}
        <div class="panel"><div class="panel-head"><h3>相关新闻</h3><span class="spacer"></span><span class="small faint">${d.news.length} 个事件</span></div>${d.news.map((e, i) => eventItem(e, i === 0)).join('') || '<div class="empty">暂无相关事件</div>'}</div>
        ${isStock ? `<div class="panel"><div class="panel-head"><h3>公司公告</h3><span class="small faint">官方来源优先</span></div>${d.filings.map((f) => `<div class="msg"><span class="cat">${esc(f.type)}</span> ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a>` : esc(f.title)} ${srcBadge(!/演示/.test(f.source), f.source)}<div class="who">${esc(f.source)} · ${fmtTime(f.filedAt)}${f.summary ? ` · ${esc(f.summary)}` : ''}</div></div>`).join('') || '<div class="empty">暂无公告</div>'}</div>` : ''}
        ${chatPanel(d)}
      </div>
      <div>
        ${researchPanel(d)}
        ${suggestionsPanel(d)}
        ${versionsPanel(d)}
        <div class="panel"><div class="panel-head"><h3>AI 分析历史版本</h3></div>${d.analyses.length ? d.analyses.map((a) => `<details class="evidence"><summary>${esc(a.title)} · v${a.version} · ${fmtTime(a.createdAt)} <span class="faint">${esc(a.trigger.startsWith('alert') ? '异动触发' : a.trigger.startsWith('filing') ? '财报触发' : '用户提问')}</span></summary>${renderBlocks(a.blocks, a.evidence)}</details>`).join('') : '<div class="empty">还没有 AI 分析记录</div>'}</div>
        <div class="panel"><div class="panel-head"><h3>相关提醒</h3></div>${d.alerts.map((a) => alertCard(a)).join('') || '<div class="empty">暂无提醒</div>'}</div>
      </div>
    </div>`;
  renderDetailChart();
  if (hasCompany) api(`/api/stock/${encodeURIComponent(id)}/company`).then((r) => { const el = document.getElementById('company-body'); if (el) { el.className = ''; el.innerHTML = renderBlocks(r.blocks, r.evidence); } });
  bindToggles(app);
  bindAlertActions(app);
  bindResearch(d);
  app.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => askAgent(b.dataset.ask); });
}

async function renderDetailChart() {
  const d = S.stock; const box = document.getElementById('sec-chart');
  const series = await api(`/api/bars/${encodeURIComponent(d.id)}?period=${S.detailPeriod}`);
  box.innerHTML = `<div class="panel-head"><h3>K 线与走势</h3><span class="spacer"></span><div class="tabs">${PERIODS.map(([k, l]) => `<button class="tab ${k === S.detailPeriod ? 'active' : ''}" data-period="${k}">${l}</button>`).join('')}</div></div>
    ${chartSvg(series, { height: 280, prevClose: series.kind === 'line' ? d.quote.prevClose : undefined })}`;
  box.querySelectorAll('[data-period]').forEach((b) => { b.onclick = () => { S.detailPeriod = b.dataset.period; renderDetailChart(); }; });
}

function financialPanel(d) {
  const f = d.financials;
  if (!f) return '<div class="panel"><div class="panel-head"><h3>财务数据</h3></div><div class="empty">暂无财务数据</div></div>';
  const qs = f.quarters.slice(-6);
  const rows = [['营收', 'revenue', 'revenueYoY', 'revenueQoQ'], ['毛利润', 'grossProfit'], ['营业利润', 'operatingIncome'], ['净利润', 'netIncome', 'netIncomeYoY'], ['EPS', 'eps', 'epsYoY'], ['自由现金流', 'fcf', 'fcfYoY'], ['现金', 'cash'], ['负债', 'debt'], ['毛利率 %', 'grossMargin'], ['净利率 %', 'netMargin']];
  const e = d.earnings;
  return `<div class="panel"><div class="panel-head"><h3>财务数据</h3>${srcBadge(f.real, f.source)}<span class="spacer"></span><span class="small faint">单位：${esc(f.currency)} 百万 · ${esc(f.source)}</span></div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>指标</th>${qs.map((x) => `<th class="num">${x.period}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([label, k, yoy, qoq]) => `<tr><td>${label}</td>${qs.map((x) => `<td class="num mono">${num(x[k], k === 'eps' ? 2 : 1)}${yoy && x[yoy] != null ? `<div class="small ${cls(x[yoy])}">同比 ${pct(x[yoy])}</div>` : ''}${qoq && x[qoq] != null ? `<div class="small faint">环比 ${pct(x[qoq])}</div>` : ''}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    ${e ? `<div class="chart-box"><div class="panel-head"><h3>财报变化 · ${e.period}</h3><span class="spacer"></span><button class="btn sm" data-ask="分析一下最新财报的变化">AI 财报分析</button></div>
      <div class="kv">${e.items.map((i) => `<div><span>${i.metric}</span><b class="mono">${i.unit === 'pct' ? `${i.value}%` : num(i.value, 0)}</b><div class="small ${cls(i.yoy ?? i.delta)}">${i.unit === 'pct' ? `环比 ${i.delta > 0 ? '+' : ''}${i.delta}pct` : `同比 ${pct(i.yoy)}`}</div></div>`).join('')}</div>
      ${e.guidance ? `<div class="blk blk-fact" style="margin-top:8px"><span class="tag tag-fact">管理层指引</span>${esc(e.guidance)}</div>` : ''}</div>` : ''}
  </div>`;
}

function chatPanel(d) {
  const st = d.chat.daily;
  return `<div class="panel"><div class="panel-head"><h3>群聊讨论</h3><span class="tag tag-unverified">未经证实来源</span><span class="spacer"></span><span class="small faint">最近 24 小时 · ${st.groupCount} 个群 · ${st.userCount} 人 · ${st.messageCount} 条</span></div>
    ${d.chat.stats.effectiveGroupCount ? `<div class="small" style="margin-bottom:8px">最近 60 分钟：${d.chat.stats.effectiveGroupCount} 个群有效讨论，热度变化 ${d.chat.stats.heatChangePct == null ? '新出现' : `${d.chat.stats.heatChangePct}%`}${d.chat.stats.spreading.length ? '，<span style="color:var(--unverified)">存在转发传播</span>' : ''}</div>` : ''}
    ${st.topics.length ? `<div class="row wrap" style="margin-bottom:8px">${st.topics.map((t) => `<span class="chip">${esc(t.name)} · ${t.count}</span>`).join('')}</div>` : ''}
    ${d.chat.messages.slice(0, 12).map((m) => `<div class="msg"><div class="who">${esc(m.groupName)} · ${esc(m.user)} · ${timeAgo(m.time)} <span class="faint">(${esc(m.platform)})</span>${m.type === 'forward' ? ' · 转发' : ''}</div>${esc(m.content)}</div>`).join('') || '<div class="empty">暂无群聊讨论</div>'}
    <div class="disclaimer">群聊热度仅代表关注度，不代表投资建议或买卖信号。</div></div>`;
}

const PLAN_FIELDS = [['watchPrice', '关注价'], ['buyLow', '买入区间下沿'], ['buyHigh', '买入区间上沿'], ['positionPct', '计划仓位 %'], ['stopLoss', '止损价'], ['target', '目标价'], ['validUntil', '有效期']];
const PLAN_TEXT = [['addCondition', '加仓条件'], ['reduceCondition', '减仓条件']];
const STATUSES = ['待验证', '成立', '存疑', '证伪'];

function researchPanel(d) {
  const r = d.research;
  return `<div class="panel" id="research"><div class="panel-head"><h3>我的研究</h3><span class="user-badge">用户原始判断 · 仅你可修改</span></div>
    <label class="field">投资逻辑：为什么关注<textarea id="r-thesis" rows="3">${esc(r.thesis)}</textarea></label>
    <div class="panel-head" style="margin-top:12px"><h3 style="font-size:14px">核心假设</h3><span class="spacer"></span><button class="btn sm" id="add-as">+ 添加</button></div>
    <div class="list-edit" id="r-assumptions">${r.assumptions.map((a) => assumptionRow(a)).join('')}</div>
    <div class="panel-head" style="margin-top:12px"><h3 style="font-size:14px">待验证问题</h3><span class="spacer"></span><button class="btn sm" id="add-q">+ 添加</button></div>
    <div class="list-edit" id="r-questions">${r.questions.map((q) => questionRow(q)).join('')}</div>
    <div class="panel-head" style="margin-top:12px"><h3 style="font-size:14px">交易计划</h3></div>
    <div class="form-grid">${PLAN_FIELDS.map(([k, l]) => `<label class="field">${l}<input data-plan="${k}" value="${esc(r.plan?.[k] ?? '')}" ${k === 'validUntil' ? 'type="date"' : 'inputmode="decimal"'} /></label>`).join('')}</div>
    ${PLAN_TEXT.map(([k, l]) => `<label class="field" style="margin-top:8px">${l}<input data-plan="${k}" value="${esc(r.plan?.[k] ?? '')}" /></label>`).join('')}
    <label class="field" style="margin-top:12px">复盘结论：之前的判断是否正确<textarea id="r-review" rows="2">${esc(r.review)}</textarea></label>
    <div class="row" style="margin-top:10px"><input id="r-reason" placeholder="这次修改的原因（会记录在研究版本里）" style="flex:1" /><button class="btn primary" id="r-save">保存并生成版本</button></div>
    <div class="small faint" style="margin-top:6px">${r.updatedAt ? `上次保存 ${fmtTime(r.updatedAt)}` : '尚未保存'}</div></div>`;
}
const assumptionRow = (a) => `<div class="item" data-id="${esc(a.id || '')}"><input data-k="text" value="${esc(a.text)}" placeholder="例如：AI 数据中心资本开支未来两年继续增长" />
  <select data-k="status">${STATUSES.map((s) => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
  <label class="small muted"><input type="checkbox" data-k="checked" /> 已检查</label>
  ${a.lastCheckedAt ? `<div class="meta">记录于 ${a.createdAt.slice(0, 10)} · 最近检查 ${a.lastCheckedAt.slice(0, 10)}（${Math.floor((Date.now() - new Date(a.lastCheckedAt)) / 86400000)} 天前）</div>` : ''}</div>`;
const questionRow = (q) => `<div class="item q" data-id="${esc(q.id || '')}"><input type="checkbox" data-k="resolved" ${q.resolved ? 'checked' : ''} title="已解决" /><input data-k="text" value="${esc(q.text)}" placeholder="例如：毛利率是否能够维持？" /><button class="btn sm ghost" data-del>删除</button></div>`;

function suggestionsPanel(d) {
  const pending = d.suggestions.filter((s) => s.status === 'pending');
  const done = d.suggestions.filter((s) => s.status !== 'pending');
  return `<div class="panel"><div class="panel-head"><h3>AI 建议</h3><span class="ai-badge">AI 不会修改你的计划</span></div>
    ${pending.map((s) => `<div class="blk blk-analysis" style="margin-bottom:6px"><span class="tag tag-analysis">待你决定</span>${esc(s.text)}<div class="row" style="margin-top:6px"><button class="btn sm" data-sg="${s.id}" data-v="accepted">我会去检查</button><button class="btn sm ghost" data-sg="${s.id}" data-v="dismissed">忽略</button><span class="small faint">${timeAgo(s.createdAt)}</span></div></div>`).join('') || '<div class="empty">暂无待处理建议</div>'}
    ${done.length ? `<details class="evidence"><summary>已处理 ${done.length} 条</summary>${done.map((s) => `<div class="small muted">${s.status === 'accepted' ? '✓ 已采纳' : '× 已忽略'} · ${esc(s.text)}</div>`).join('')}</details>` : ''}
  </div>`;
}

function versionsPanel(d) {
  const vs = d.versions;
  return `<div class="panel"><div class="panel-head"><h3>研究版本</h3><span class="small faint">之前怎么看 → 现在发生了什么 → 判断为什么改变</span></div>
    ${vs.length >= 2 ? `<div class="row wrap"><select id="v-from">${vs.map((v, i) => `<option value="${v.id}" ${i === 1 ? 'selected' : ''}>${fmtTime(v.createdAt)} · ${esc(v.reason)}</option>`).join('')}</select><span>→</span>
      <select id="v-to">${vs.map((v, i) => `<option value="${v.id}" ${i === 0 ? 'selected' : ''}>${fmtTime(v.createdAt)} · ${esc(v.reason)}</option>`).join('')}</select><button class="btn sm" id="v-diff">对比</button></div><div id="v-out"></div>` : ''}
    ${vs.map((v) => `<div class="msg"><div class="who">${fmtTime(v.createdAt)}</div>${esc(v.reason)}</div>`).join('') || '<div class="empty">保存研究记录后会生成版本</div>'}</div>`;
}

function bindResearch(d) {
  const root = document.getElementById('research');
  root.querySelector('#add-as').onclick = () => root.querySelector('#r-assumptions').insertAdjacentHTML('beforeend', assumptionRow({ text: '', status: '待验证' }));
  root.querySelector('#add-q').onclick = () => { root.querySelector('#r-questions').insertAdjacentHTML('beforeend', questionRow({ text: '' })); bindDel(); };
  const bindDel = () => root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => b.closest('.item').remove(); });
  bindDel();
  root.querySelector('#r-save').onclick = async () => {
    const patch = {
      thesis: root.querySelector('#r-thesis').value,
      review: root.querySelector('#r-review').value,
      plan: Object.fromEntries([...root.querySelectorAll('[data-plan]')].map((i) => [i.dataset.plan, i.value])),
      assumptions: [...root.querySelectorAll('#r-assumptions .item')].map((it) => ({ id: it.dataset.id || undefined, text: it.querySelector('[data-k=text]').value, status: it.querySelector('[data-k=status]').value, checked: it.querySelector('[data-k=checked]').checked })).filter((a) => a.text.trim()),
      questions: [...root.querySelectorAll('#r-questions .item')].map((it) => ({ id: it.dataset.id || undefined, text: it.querySelector('[data-k=text]').value, resolved: it.querySelector('[data-k=resolved]').checked })).filter((q) => q.text.trim()),
    };
    await api(`/api/research/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { patch, reason: root.querySelector('#r-reason').value || '用户更新' } });
    toast('已保存', '研究记录已保存，并生成了一个新版本');
    stockPage(d.id);
  };
  app.querySelectorAll('[data-sg]').forEach((b) => { b.onclick = async () => { await api(`/api/suggestions/${b.dataset.sg}`, { method: 'POST', body: { status: b.dataset.v } }); stockPage(d.id); }; });
  const diffBtn = document.getElementById('v-diff');
  if (diffBtn) {
    diffBtn.onclick = async () => {
      const r = await api(`/api/research/${encodeURIComponent(d.id)}/diff?from=${document.getElementById('v-from').value}&to=${document.getElementById('v-to').value}`);
      document.getElementById('v-out').innerHTML = `<div class="diff">${r.changes.length ? r.changes.map((c) => `<div class="diff-row"><span class="small muted">${esc(c.field)}</span><span class="before">${esc(c.before || '（空）')}</span><span class="after">${esc(c.after || '（空）')}</span></div>`).join('') : '<div class="empty">两个版本没有差异</div>'}
        <div class="small faint">修改原因：${esc(r.to.reason)}</div></div>`;
    };
  }
}

// ================= 提醒中心 =================
async function alertsPage(status = S.alertStatus || 'open', type = S.alertType || '') {
  S.ctx = { page: 'alerts' };
  S.alertStatus = status; S.alertType = type;
  const r = await api(`/api/alerts?status=${status}${type ? `&type=${type}` : ''}`);
  bumpUnread(r.counts.unread, true);
  const TYPES = [['', '全部'], ['price', '涨跌幅'], ['volume', '成交量'], ['level', '关键价位'], ['company', '公司事件'], ['earnings', '财报'], ['news', '新闻'], ['chat', '群聊共振'], ['research', '研究提醒'], ['calendar', '经济数据']];
  const STS = [['open', `待处理 (${r.counts.unread + r.counts.read})`], ['unread', `未读 (${r.counts.unread})`], ['read', `已读 (${r.counts.read})`], ['handled', `已处理 (${r.counts.handled})`], ['ignored', `忽略 (${r.counts.ignored})`], ['all', '全部']];
  app.innerHTML = `<div class="panel"><div class="panel-head"><h3>统一提醒中心</h3><span class="spacer"></span>${legend()}</div>
    <div class="row wrap" style="margin-bottom:8px"><div class="tabs">${STS.map(([k, l]) => `<button class="tab ${k === status ? 'active' : ''}" data-s="${k}">${l}</button>`).join('')}</div></div>
    <div class="row wrap" style="margin-bottom:12px"><div class="tabs">${TYPES.map(([k, l]) => `<button class="tab ${k === type ? 'active' : ''}" data-t="${k}">${l}</button>`).join('')}</div></div>
    ${r.items.map((a) => alertCard(a)).join('') || '<div class="empty">没有符合条件的提醒</div>'}</div>`;
  app.querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => alertsPage(b.dataset.s, type); });
  app.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => alertsPage(status, b.dataset.t); });
  bindAlertActions(app);
}

// ================= 群聊洞察 =================
async function chatPage(minutes = S.chatMinutes || 60) {
  S.ctx = { page: 'chat' }; S.chatMinutes = minutes;
  const feed = S.chatFeed || '';
  const [hot, view, msgs] = await Promise.all([api(`/api/chat/hot?minutes=${minutes}`), api('/api/chat/view'), api(`/api/chat/messages?limit=60${feed ? `&group=${encodeURIComponent(feed)}` : ''}`)]);
  const W = [[60, '1 小时'], [720, '半日'], [1440, '每日'], [4320, '3 天']];
  const srcName = (id) => view.sources.find((x) => x.id === id)?.name;
  const loose = view.channels.filter((c) => !c.sourceId && !c.hidden);
  const feedOpts = [['', '全部来源'], ...view.sources.map((x) => [`src:${x.id}`, `【来源】${x.name}`]), ...loose.map((c) => [c.id, c.name])];
  // 频道按服务器（名称里第一个"/"之前）分组
  const servers = new Map();
  for (const c of view.channels) { const k = c.name.includes('/') ? c.name.split('/')[0] : '其他'; if (!servers.has(k)) servers.set(k, []); servers.get(k).push(c); }
  const short = (c) => (c.name.includes('/') ? c.name.slice(c.name.indexOf('/') + 1) : c.name);
  const chRow = (c) => `<tr class="${c.hidden ? 'faint' : ''}"><td>${esc(short(c))}</td><td class="num">${c.messages}</td><td class="small">${c.topUsers.map((u) => esc(u.user)).join('、')}</td>
    <td><select data-src="${esc(c.id)}"><option value="">—</option>${view.sources.map((x) => `<option value="${esc(x.id)}" ${x.id === c.sourceId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
    <td class="num"><label class="small"><input type="checkbox" data-hg="${esc(c.id)}" ${c.hidden ? 'checked' : ''} /> 屏蔽</label></td></tr>`;
  app.innerHTML = `<div class="two-col"><div>
    <div class="panel"><div class="panel-head"><h3>跨群热度</h3><span class="spacer"></span><div class="tabs">${W.map(([m, l]) => `<button class="tab ${m === minutes ? 'active' : ''}" data-m="${m}">${l}</button>`).join('')}</div></div>
      <div class="table-wrap"><table class="grid"><thead><tr><th>标的</th><th class="num">有效讨论群</th><th class="num">独立讨论群</th><th class="num">人数</th><th class="num">消息</th><th class="num">热度变化</th><th>话题</th></tr></thead><tbody>
      ${hot.map((s) => `<tr class="clickable" data-go="${esc(s.symbol)}"><td><b>${esc(code(s.symbol))}</b></td><td class="num">${s.effectiveGroupCount}/${s.groupCount}</td><td class="num">${s.independentGroupCount}</td><td class="num">${s.userCount}</td><td class="num">${s.messageCount}</td><td class="num ${cls(s.heatChangePct)}">${s.heatChangePct == null ? '新' : `${s.heatChangePct}%`}</td><td class="small">${s.topics.slice(0, 2).map((t) => esc(t.name)).join('、')}${s.spreading.length ? ' · <span style="color:var(--unverified)">转发传播</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">该时段没有标的讨论</td></tr>'}
      </tbody></table></div>
      <div class="small faint" style="margin-top:8px">有效讨论：单群 ≥3 条相关消息或 ≥2 名独立用户。独立讨论：剔除被复制到多个群的相同内容后仍满足有效讨论。同一来源下的多个频道算作一个群，屏蔽的频道和人不参与统计。规则阈值可在"规则与任务"中修改。</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-ask="总结一下最近${W.find((w) => w[0] === minutes)[1]}群里讨论最多的股票">让 OpenClaw 生成群摘要</button></div>
      <div class="disclaimer">群聊热度仅代表关注度，不代表投资建议或买卖信号。</div></div>
    <div class="panel"><div class="panel-head"><h3>来源与屏蔽</h3><span class="spacer"></span><input id="src-new" placeholder="新来源名，如 硅谷照见" style="width:150px" /><button class="btn sm" id="src-add">新建来源</button></div>
      <div class="small muted" style="margin-bottom:8px">把同一个博主的多个频道归到一个"来源"里合并查看；不想看的频道勾选屏蔽，不想看的人在右侧消息里点"屏蔽此人"。</div>
      <div class="row wrap" style="margin-bottom:8px">${view.sources.map((x) => `<span class="chip">${esc(x.name)} · ${x.groupIds.length} 个频道 <a href="#" data-rnsrc="${esc(x.id)}" title="改名">✎</a> <a href="#" data-delsrc="${esc(x.id)}" title="删除来源">×</a></span>`).join('') || '<span class="small faint">还没有来源</span>'}</div>
      ${[...servers].map(([k, list]) => `<details class="evidence" ${S.openServer === k ? 'open' : ''} data-server="${esc(k)}"><summary><b>${esc(k)}</b> · ${list.length} 个频道${list.some((c) => c.hidden) ? ` · 已屏蔽 ${list.filter((c) => c.hidden).length}` : ''}</summary>
        <div class="table-wrap"><table class="grid"><thead><tr><th>频道</th><th class="num">消息</th><th>主要发言人</th><th>来源</th><th></th></tr></thead><tbody>${list.sort((x, y) => y.messages - x.messages).map(chRow).join('')}</tbody></table></div></details>`).join('')}
      <div style="margin-top:10px"><b class="small">已屏蔽的人</b> ${view.hiddenUsers.map((u) => `<span class="chip">${esc(u)} <a href="#" data-unhu="${esc(u)}" title="取消屏蔽">×</a></span>`).join('') || '<span class="small faint">无</span>'}</div></div>
  </div><div>
    <div class="panel"><div class="panel-head"><h3>最新消息</h3><span class="tag tag-unverified">未经证实来源</span><span class="spacer"></span>
      <select id="chat-feed">${feedOpts.map(([v, l]) => `<option value="${esc(v)}" ${v === feed ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><input id="chat-q" placeholder="搜索内容或标的" /></div><div id="chat-msgs">${msgList(msgs)}</div></div>
  </div></div>`;

  const putView = async (patch) => { await api('/api/chat/view', { method: 'PUT', body: patch }); chatPage(minutes); };
  const sourcesWith = (fn) => view.sources.map((x) => ({ ...x, groupIds: [...x.groupIds] })).map(fn);
  app.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => chatPage(Number(b.dataset.m)); });
  app.querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => { location.hash = `#/stock/${encodeURIComponent(el.dataset.go)}`; }; });
  app.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => askAgent(b.dataset.ask); });
  app.querySelectorAll('details[data-server]').forEach((d) => { d.ontoggle = () => { if (d.open) S.openServer = d.dataset.server; }; });
  document.getElementById('chat-feed').onchange = (e) => { S.chatFeed = e.target.value; chatPage(minutes); };
  document.getElementById('src-add').onclick = () => {
    const name = document.getElementById('src-new').value.trim(); if (!name) return;
    putView({ sources: [...view.sources, { name, groupIds: [] }] });
  };
  app.querySelectorAll('[data-delsrc]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); if (!confirm('删除这个来源？其中的频道会恢复为单独显示。')) return; if (S.chatFeed === `src:${a.dataset.delsrc}`) S.chatFeed = ''; putView({ sources: view.sources.filter((x) => x.id !== a.dataset.delsrc) }); }; });
  app.querySelectorAll('[data-rnsrc]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); const cur = srcName(a.dataset.rnsrc); const name = prompt('来源名称', cur); if (!name || name.trim() === cur) return; putView({ sources: sourcesWith((x) => (x.id === a.dataset.rnsrc ? { ...x, name: name.trim() } : x)) }); }; });
  app.querySelectorAll('[data-src]').forEach((sel) => { sel.onchange = () => {
    const ch = sel.dataset.src;
    putView({ sources: sourcesWith((x) => ({ ...x, groupIds: x.id === sel.value ? [...x.groupIds.filter((g) => g !== ch), ch] : x.groupIds.filter((g) => g !== ch) })) });
  }; });
  app.querySelectorAll('[data-hg]').forEach((cb) => { cb.onchange = () => putView({ hiddenGroups: cb.checked ? [...view.hiddenGroups, cb.dataset.hg] : view.hiddenGroups.filter((g) => g !== cb.dataset.hg) }); });
  app.querySelectorAll('[data-unhu]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); putView({ hiddenUsers: view.hiddenUsers.filter((u) => u !== a.dataset.unhu) }); }; });
  const bindHide = () => document.querySelectorAll('#chat-msgs [data-hu]').forEach((b) => { b.onclick = () => { if (confirm(`屏蔽「${b.dataset.hu}」？之后不再显示此人的消息，也不计入热度。可在"来源与屏蔽"里取消。`)) putView({ hiddenUsers: [...view.hiddenUsers, b.dataset.hu] }); }; });
  bindHide();
  const q = document.getElementById('chat-q');
  q.onkeydown = async (e) => { if (e.key === 'Enter') { document.getElementById('chat-msgs').innerHTML = msgList(await api(`/api/chat/messages?q=${encodeURIComponent(q.value)}&limit=50${feed ? `&group=${encodeURIComponent(feed)}` : ''}`)); bindHide(); } };
}
const msgList = (msgs) => msgs.map((m) => `<div class="msg"><div class="who">${esc(m.groupName)}${m.channel ? ` <span class="faint">› ${esc(m.channel.includes('/') ? m.channel.slice(m.channel.indexOf('/') + 1) : m.channel)}</span>` : ''} · ${esc(m.user)} · ${fmtTime(m.time)} <span class="faint">(${esc(m.platform)})</span>${m.symbols?.length ? ` ${m.symbols.map((s) => `<a class="chip" href="#/stock/${encodeURIComponent(s)}">${esc(code(s))}</a>`).join('')}` : ''}${S.ctx?.page === 'chat' ? ` <button class="btn sm ghost" data-hu="${esc(m.user)}" title="不再显示此人的消息">屏蔽此人</button>` : ''}</div>${esc(m.content)}</div>`).join('') || '<div class="empty">没有消息</div>';

// ================= 自选与导入 =================
async function watchlistPage() {
  S.ctx = { page: 'watchlist' };
  const groups = await api('/api/watchlist');
  const cats = [...new Set(groups.map((g) => g.category || (g.kind === 'macro' ? '宏观' : '自选')))];
  app.innerHTML = `<div class="two-col"><div>
    <div class="panel"><div class="panel-head"><h3>导入关注列表</h3></div>
      <div class="small muted" style="margin-bottom:8px">支持三种文件：<b>Excel / CSV</b>（按"一级、二级、名称、完整代码、简介、原所在列表"列识别，一级分类成为大类，二级分类成为分组，"宏观指标与商品"进入宏观列表）；<b>TradingView 导出的 .txt</b>（###分区名成为分组）。重复导入会自动去重。</div>
      <div class="drop" id="tv-drop">拖入 .xlsx / .csv / .txt 文件，或 <label class="btn sm"><input type="file" id="tv-file" accept=".xlsx,.csv,.txt" hidden />选择文件</label></div>
      <div class="row" style="margin-top:8px"><label class="small"><input type="radio" name="imode" value="merge" checked /> 合并到现有分组</label><label class="small"><input type="radio" name="imode" value="replace" /> 用文件替换全部分组</label></div>
      <textarea id="tv-text" rows="3" style="margin-top:8px" placeholder="也可以直接粘贴 TradingView 格式：###科技股,NASDAQ:NVDA,NASDAQ:AAPL,###宏观,TVC:GOLD,TVC:DXY"></textarea>
      <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="btn" id="tv-go">导入粘贴内容</button></div>
      <div id="tv-report"></div></div>
    <div class="panel"><div class="panel-head"><h3>导入群聊记录</h3></div>
      <div class="small muted" style="margin-bottom:8px">支持 discord-local 生成的 <code>messages/…/日期.jsonl</code>，也可以在启动时设置 <code>DISCORD_MESSAGES_DIR</code> 自动增量同步。按原始消息 ID 去重。</div>
      <div class="row"><input type="file" id="chat-file" accept=".jsonl,.json" multiple /><select id="chat-tz"><option value="Asia/Shanghai">文件时区：北京时间</option><option value="America/New_York">美东时间</option><option value="UTC">UTC</option></select></div>
      <div id="chat-report" class="small" style="margin-top:6px"></div></div>
  </div><div>
    <div class="panel"><div class="panel-head"><h3>分组管理</h3><span class="small faint">${groups.length} 个分组</span><span class="spacer"></span><input id="ng-cat" placeholder="大类，如 美股" style="width:100px" /><input id="ng-name" placeholder="分组名" style="width:110px" /><select id="ng-kind"><option value="stock">标的</option><option value="macro">宏观</option></select><button class="btn sm" id="ng-go">新建</button></div>
      ${cats.map((c) => `<details class="evidence" ${S.openCat === c ? 'open' : ''} data-cat="${esc(c)}"><summary><b>${esc(c)}</b> · ${groups.filter((g) => (g.category || '') === c).length} 个分组 · ${groups.filter((g) => (g.category || '') === c).reduce((n, g) => n + g.items.length, 0)} 个标的</summary>
        ${groups.filter((g) => (g.category || '') === c).map((g) => `<div class="panel" style="background:var(--panel-2)"><div class="panel-head"><h3 style="font-size:14px">${esc(g.name)}</h3><span class="small faint">${g.kind === 'macro' ? '宏观' : '标的'} · ${g.items.length}</span><span class="spacer"></span>
          <input data-add="${g.id}" placeholder="添加：代码或名称，回车" style="width:170px" /><button class="btn sm ghost" data-delg="${g.id}">删除分组</button></div>
          <table class="grid"><tbody>${g.items.map((it, i) => `<tr><td>${it.pinned ? '<span class="pin">▲</span> ' : ''}<a href="#/stock/${encodeURIComponent(it.symbol)}">${esc(it.symbol)}</a></td><td class="num">
            <button class="btn sm ghost" data-pin="${g.id}|${esc(it.symbol)}|${!it.pinned}">${it.pinned ? '取消置顶' : '置顶'}</button>
            <button class="btn sm ghost" data-mv="${g.id}|${esc(it.symbol)}|${i - 1}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn sm ghost" data-mv="${g.id}|${esc(it.symbol)}|${i + 1}" ${i === g.items.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn sm ghost" data-rm="${g.id}|${esc(it.symbol)}">删除</button></td></tr>`).join('')}</tbody></table></div>`).join('')}</details>`).join('')}
      <div class="small faint">宏观分组中置顶的标的会显示在大屏顶部的宏观行情条。</div>
    </div></div></div>`;

  const showReport = (r) => {
    document.getElementById('tv-report').innerHTML = `<div class="blk blk-fact" style="margin-top:10px">${r.replaced ? '已用文件替换全部分组。' : ''}${r.usedSheet ? `读取工作表：${esc(r.usedSheet)}。` : ''}共 ${r.totalTokens} 个代码：新增 ${r.added.length}，重复跳过 ${r.duplicates.length}，无法识别 ${r.invalid.length}${r.groupsCreated.length ? `；新建分组 ${r.groupsCreated.length} 个` : ''}${r.newInstruments.length ? `；新标的 ${r.newInstruments.length} 个（暂用合成行情）` : ''}</div>
      ${r.groupsCreated.length ? `<div class="small faint">新分组：${r.groupsCreated.map(esc).join('、')}</div>` : ''}
      ${r.duplicates.length ? `<details class="evidence"><summary>重复 ${r.duplicates.length} 个</summary><div class="small faint">${r.duplicates.map((a) => `${esc(a.symbol)}（${esc(a.reason)}）`).join('，')}</div></details>` : ''}
      ${r.invalid.length ? `<div class="small" style="color:var(--unverified)">无法识别：${r.invalid.map(esc).join('，')}</div>` : ''}
      <button class="btn sm" style="margin-top:6px" id="tv-refresh">刷新分组</button>`;
    document.getElementById('tv-refresh').onclick = watchlistPage;
  };
  const mode = () => document.querySelector('input[name=imode]:checked').value;
  const importFile = async (f) => {
    if (mode() === 'replace' && !confirm(`用 ${f.name} 替换全部分组？现有分组会被清空（标的的研究记录不受影响）。`)) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try { showReport(await api('/api/import/watchlist-file', { method: 'POST', body: { filename: f.name, base64: btoa(bin), mode: mode() } })); } catch (e) { toast('导入失败', e.message); }
  };
  document.getElementById('tv-go').onclick = async () => showReport(await api('/api/import/tradingview', { method: 'POST', body: { text: document.getElementById('tv-text').value, mode: 'auto' } }));
  document.getElementById('tv-file').onchange = (e) => { const f = e.target.files[0]; if (f) importFile(f); };
  const drop = document.getElementById('tv-drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) importFile(f); };
  app.querySelectorAll('details[data-cat]').forEach((d) => { d.ontoggle = () => { if (d.open) S.openCat = d.dataset.cat; }; });
  document.getElementById('chat-file').onchange = async (e) => {
    let added = 0; let total = 0;
    for (const f of e.target.files) {
      const text = await f.text();
      const r = await api('/api/chat/import', { method: 'POST', body: { text, format: f.name.endsWith('.jsonl') ? 'discord-jsonl' : 'json', folder: f.name.replace(/\.jsonl?$/, ''), tz: document.getElementById('chat-tz').value } });
      added += r.added; total += r.total;
    }
    document.getElementById('chat-report').textContent = `读取 ${total} 条，新增 ${added} 条（其余为重复消息）。`;
  };
  document.getElementById('ng-go').onclick = async () => { const n = document.getElementById('ng-name').value.trim(); if (!n) return; await api('/api/watchlist/groups', { method: 'POST', body: { name: n, kind: document.getElementById('ng-kind').value, category: document.getElementById('ng-cat').value.trim() || undefined } }); watchlistPage(); };
  app.querySelectorAll('[data-add]').forEach((inp) => { inp.onkeydown = async (e) => { if (e.key !== 'Enter' || !inp.value.trim()) return; try { const r = await api(`/api/watchlist/groups/${inp.dataset.add}/items`, { method: 'POST', body: { symbol: await resolveInput(inp.value) } }); toast(r.added ? '已添加' : '已存在', r.symbol); watchlistPage(); } catch (err) { toast('添加失败', err.message); } }; });
  app.querySelectorAll('[data-delg]').forEach((b) => { b.onclick = async () => { if (!confirm('删除这个分组？其中的标的会从该分组移除。')) return; await api(`/api/watchlist/groups/${b.dataset.delg}`, { method: 'DELETE' }); watchlistPage(); }; });
  app.querySelectorAll('[data-pin]').forEach((b) => { b.onclick = async () => { const [g, s, p] = b.dataset.pin.split('|'); await api(`/api/watchlist/groups/${g}/items/${encodeURIComponent(s)}/pin`, { method: 'POST', body: { pinned: p === 'true' } }); watchlistPage(); }; });
  app.querySelectorAll('[data-mv]').forEach((b) => { b.onclick = async () => { const [g, s, i] = b.dataset.mv.split('|'); await api(`/api/watchlist/groups/${g}/items/${encodeURIComponent(s)}/move`, { method: 'POST', body: { toIndex: Number(i) } }); watchlistPage(); }; });
  app.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { const [g, s] = b.dataset.rm.split('|'); await api(`/api/watchlist/groups/${g}/items/${encodeURIComponent(s)}`, { method: 'DELETE' }); watchlistPage(); }; });
}
// 输入名称时先搜索，取第一个匹配的代码
async function resolveInput(v) {
  if (v.includes(':')) return v.trim();
  const hits = await api(`/api/instruments/search?q=${encodeURIComponent(v.trim())}`);
  return hits[0]?.id || v.trim();
}
// ================= 规则与任务 =================
async function settingsPage() {
  S.ctx = { page: 'settings' };
  const [st, jobs, tools, meta, oc] = await Promise.all([api('/api/settings'), api('/api/jobs'), api('/api/agent/tools'), api('/api/meta'), api('/api/openclaw/status')]);
  const pm = st.priceMove; const ch = st.chatHeat;
  let ud = 'red-up'; try { ud = localStorage.getItem('updown') || 'red-up'; } catch { /* ignore */ }
  app.innerHTML = `<div class="two-col"><div>
    <div class="panel"><div class="panel-head"><h3>股票异动规则</h3><span class="small faint">业务后端确定性判断，不等待 AI</span></div>
      <div class="small muted" style="margin-bottom:8px">涨跌幅 =（最新价 − 上一交易日收盘价）÷ 上一交易日收盘价 × 100%</div>
      <div class="form-grid"><label class="field">阈值（%）<input id="pm-th" value="${pm.threshold}" inputmode="decimal" /></label>
        <label class="field">盘前阈值<input id="pm-pre" value="${pm.sessionThresholds.pre}" /></label><label class="field">盘中阈值<input id="pm-reg" value="${pm.sessionThresholds.regular}" /></label><label class="field">盘后阈值<input id="pm-post" value="${pm.sessionThresholds.post}" /></label></div>
      <div class="row wrap" style="margin-top:8px">${['pre', 'regular', 'post'].map((s) => `<label class="small"><input type="checkbox" data-sess="${s}" ${pm.sessions[s] ? 'checked' : ''} /> ${{ pre: '盘前启用', regular: '正常交易启用', post: '盘后启用' }[s]}</label>`).join('')}</div></div>
    <div class="panel"><div class="panel-head"><h3>跨群热度规则</h3></div>
      <div class="form-grid"><label class="field">滚动窗口（分钟）<input id="ch-win" value="${ch.windowMinutes}" /></label><label class="field">最少群数<input id="ch-groups" value="${ch.minGroups}" /></label>
        <label class="field">单群最少消息数<input id="ch-msgs" value="${ch.minMessagesPerGroup}" /></label><label class="field">或单群最少独立用户<input id="ch-users" value="${ch.minUsersPerGroup}" /></label></div></div>
    <div class="panel"><div class="panel-head"><h3>研究提醒</h3></div><label class="field">假设多少天未检查时提醒<input id="rs-days" value="${st.research.staleDays}" style="width:120px" /></label></div>
    <div class="panel"><div class="panel-head"><h3>显示</h3></div><label class="field">涨跌颜色<select id="updown"><option value="red-up" ${ud === 'red-up' ? 'selected' : ''}>红涨绿跌</option><option value="green-up" ${ud === 'green-up' ? 'selected' : ''}>绿涨红跌</option></select></label></div>
    <button class="btn primary" id="save-settings">保存规则</button>
  </div><div>
    <div class="panel"><div class="panel-head"><h3>主动式 Agent 任务</h3></div>
      ${jobs.schedule.map((j) => `<div class="row" style="margin-bottom:6px"><span>${esc(j.label)}</span><span class="small faint">美东 ${String(Math.floor(j.at / 60)).padStart(2, '0')}:${String(j.at % 60).padStart(2, '0')}</span><span class="spacer"></span><button class="btn sm" data-run="${j.name}">立即运行</button></div>`).join('')}
      <div class="row" style="margin-bottom:6px"><span>美股盘中：自选股异动监控</span><span class="small faint">每 5 秒</span></div>
      <div class="row" style="margin-bottom:6px"><span>新闻流水线 + 重大新闻提醒</span><span class="small faint">每分钟</span><span class="spacer"></span><button class="btn sm" data-run="news">立即运行</button></div>
      <div class="row" style="margin-bottom:6px"><span>跨群热度检查</span><span class="small faint">每分钟</span><span class="spacer"></span><button class="btn sm" data-run="chat">立即运行</button></div>
      <div class="row" style="margin-bottom:6px"><span>财报 / 公告 → 财报变化分析</span><span class="small faint">事件触发</span></div>
      <div class="row" style="margin-bottom:10px"><span>经济数据公布 → 影响分析</span><span class="small faint">事件触发</span></div>
      <details class="evidence"><summary>最近运行记录</summary>${jobs.runs.map((r) => `<div class="small muted">${fmtTime(r.at)} · ${esc(r.name)} ${r.detail ? `<span class="faint">${esc(r.detail)}</span>` : ''}</div>`).join('')}</details></div>
    <div class="panel"><div class="panel-head"><h3>OpenClaw 工具层</h3><span class="small faint">${tools.length} 个工具</span></div>
      <div class="small muted" style="margin-bottom:8px">本机 OpenClaw 通过 <code>invest-workbench</code> skill 调用：<code>GET /api/agent/tools</code> 获取工具清单，<code>POST /api/agent/tools/:name</code> 执行，<code>POST /api/agent/results</code> 写回分析结果。安装方法见 <code>openclaw/README.md</code>。</div>
      ${tools.map((t) => `<details class="evidence"><summary><code>${esc(t.name)}</code> ${esc(t.description.slice(0, 40))}…</summary><div class="small muted">${esc(t.description)}</div><pre>${esc(JSON.stringify(t.input_schema, null, 2))}</pre></details>`).join('')}</div>
    <div class="panel"><div class="panel-head"><h3>数据源状态</h3></div>
      <div class="small">AI 对话：${meta.model === 'openclaw' ? `本机 OpenClaw（${esc(oc.url)}，agent ${esc(oc.agent)}）` : meta.llm ? `Claude（${esc(meta.model)}）` : '本地规则；设置 <code>OPENCLAW_TOKEN</code> 接入本机 OpenClaw'}</div>
      <div class="small">异动分析与日报：${oc.hooks ? `交给本机 OpenClaw${oc.pending.length ? `，进行中 ${oc.pending.length} 项` : ''}，超时回退本地规则` : '本地规则；设置 <code>OPENCLAW_HOOKS_TOKEN</code> 交给 OpenClaw'}</div>
      ${oc.lastResults.length ? `<div class="small faint">OpenClaw 最近回写：${oc.lastResults.map((r) => `${esc(r.title)}（${timeAgo(r.createdAt)}）`).join('；')}</div>` : ''}
      ${meta.gangtise ? `<div class="small">Gangtise：${meta.real.map(esc).join('、')} · 最近轮询 ${meta.gangtise.lastPoll ? fmtClock(meta.gangtise.lastPoll) : '—'}${meta.gangtise.lastError ? ` · <span class="down">最近错误：${esc(meta.gangtise.lastError)}</span>` : ''} · 今日积分 ${meta.gangtise.usage.points}/${meta.gangtise.usage.cap}</div>` : '<div class="small">Gangtise：未配置（在 <code>.env</code> 写入 <code>GANGTISE_ACCESS_KEY</code> / <code>GANGTISE_SECRET_KEY</code>）</div>'}
      <div class="small">演示数据（Mock）：${meta.mocked.map(esc).join('、')}</div>
      <div class="small">群聊：${meta.discord ? 'discord-local 已接入' : '演示数据；设置 <code>DISCORD_MESSAGES_DIR</code> 接入 discord-local'}</div>
      <div class="small">美股交易时段：${meta.mockSession === 'real' ? '按真实美东时间' : `演示模式固定为"${esc(SESSION[meta.mockSession] || meta.mockSession)}"（<code>MOCK_SESSION=real</code> 切换为真实时间）`}</div></div>
  </div></div>`;
  app.querySelectorAll('[data-run]').forEach((b) => { b.onclick = async () => { b.disabled = true; const r = await api(`/api/jobs/${b.dataset.run}/run`, { method: 'POST' }); toast(r?.dispatched ? '已交给 OpenClaw' : '任务已运行', b.closest('.row').firstElementChild.textContent); settingsPage(); }; });
  document.getElementById('save-settings').onclick = async () => {
    const n = (id) => Number(document.getElementById(id).value);
    await api('/api/settings', { method: 'PUT', body: {
      priceMove: { threshold: n('pm-th'), sessionThresholds: { pre: n('pm-pre'), regular: n('pm-reg'), post: n('pm-post') }, sessions: Object.fromEntries([...app.querySelectorAll('[data-sess]')].map((c) => [c.dataset.sess, c.checked])) },
      chatHeat: { windowMinutes: n('ch-win'), minGroups: n('ch-groups'), minMessagesPerGroup: n('ch-msgs'), minUsersPerGroup: n('ch-users') },
      research: { staleDays: n('rs-days') },
    } });
    const v = document.getElementById('updown').value;
    document.documentElement.dataset.updown = v;
    try { localStorage.setItem('updown', v); } catch { /* ignore */ }
    toast('已保存', '新规则会在下一次检查时生效');
  };
}

// ---------------- 启动 ----------------
loadMeta().catch(() => {});
connectStream();
router();
