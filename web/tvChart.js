// 个股页 TradingView 风格图表（TradingView Lightweight Charts，Apache-2.0，需保留左下角 TV 标志）。
// 数据来自 /api/chart/:id：日 / 周 / 月 K、分时、交易计划价位线、提醒标记。
import { createChart, CandlestickSeries, HistogramSeries, AreaSeries, LineStyle, CrosshairMode, createSeriesMarkers } from './vendor/lightweight-charts.js';
import { esc, num, vol, pct } from './ui.js';

export const TIMEFRAMES = [['intraday', '分时'], ['D', '日K'], ['W', '周K'], ['M', '月K']];
const TF_LABEL = Object.fromEntries(TIMEFRAMES);
const VISIBLE_BARS = { D: 120, W: 104, M: 120 };

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const alpha = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
// 分时用秒级 UTC 时间戳；图表按 UTC 显示，这里平移到浏览器本地时间
const localTs = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;

function precisionFor(price) {
  const p = Math.abs(price || 0);
  return p && p < 1 ? 4 : p < 10 ? 3 : 2;
}

function colors() {
  return {
    up: css('--up'), down: css('--down'), text: css('--muted'), faint: css('--faint'), line: css('--line'),
    bg: css('--panel'), accent: css('--accent'),
    target: css('--note'), buy: css('--accent'), watch: css('--unverified'), stop: css('--danger'),
    volume: css('--analysis'), event: css('--fact'), level: css('--unverified'), info: css('--muted'),
  };
}

let current = null; // { chart, id, tf, data, main, volume, last, legendEl }

export function destroyChart() {
  if (current) { try { current.chart.remove(); } catch { /* 已经从页面移除 */ } current = null; }
}

/** 在 el 里画图。data 是 /api/chart 的返回值，name 用在左上角图例。 */
export function mountChart(el, data, { name } = {}) {
  destroyChart();
  el.innerHTML = '';
  const C = colors();
  const isLine = data.kind === 'line';
  const pts = isLine ? data.line : data.candles;
  if (!pts.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const lastPrice = isLine ? pts[pts.length - 1].value : pts[pts.length - 1].c;
  const precision = precisionFor(lastPrice);
  const priceFormat = { type: 'price', precision, minMove: 1 / 10 ** precision };

  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: C.bg }, textColor: C.text, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: alpha(C.line, 0.45) }, horzLines: { color: alpha(C.line, 0.45) } },
    rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: { borderColor: C.line, timeVisible: isLine, secondsVisible: false, rightOffset: 4, minBarSpacing: 1 },
    crosshair: { mode: CrosshairMode.Normal },
    localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd', priceFormatter: (p) => Number(p).toFixed(precision) },
  });

  let main;
  if (isLine) {
    const base = data.prevClose ?? pts[0].value;
    const col = lastPrice >= base ? C.up : C.down;
    main = chart.addSeries(AreaSeries, { lineColor: col, topColor: alpha(col, 0.28), bottomColor: alpha(col, 0.02), lineWidth: 2, priceFormat });
    main.setData(pts.map((p) => ({ time: localTs(p.time), value: p.value })));
    if (data.prevClose) main.createPriceLine({ price: data.prevClose, color: C.faint, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '昨收' });
  } else {
    main = chart.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down, priceFormat,
    });
    main.setData(pts.map((b) => ({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c })));
  }

  // 成交量：叠在底部 18%
  let volume = null;
  if (!isLine) {
    volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(pts.map((b) => ({ time: b.time, value: b.v || 0, color: alpha(b.c >= b.o ? C.up : C.down, 0.45) })));
  }

  // 交易计划价位线：纵轴范围也把它们包含进来，止损 / 目标价不会跑出画面
  const lvPrices = (data.levels || []).map((l) => l.price);
  if (lvPrices.length) {
    main.applyOptions({ autoscaleInfoProvider: (orig) => {
      const r = orig();
      if (!r?.priceRange) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...lvPrices), maxValue: Math.max(r.priceRange.maxValue, ...lvPrices) } };
    } });
  }
  const LINE_STYLE = { target: LineStyle.Solid, stop: LineStyle.Solid, buy: LineStyle.Dashed, watch: LineStyle.Dotted };
  for (const lv of data.levels || []) {
    main.createPriceLine({ price: lv.price, color: C[lv.role] || C.accent, lineWidth: 1, lineStyle: LINE_STYLE[lv.role] ?? LineStyle.Dashed, axisLabelVisible: true, title: lv.label });
  }

  // 提醒标记
  const TONE = { up: C.up, down: C.down, stop: C.stop, level: C.level, volume: C.volume, event: C.event, info: C.info };
  if (data.markers?.length) {
    createSeriesMarkers(main, data.markers.map((m) => ({
      time: isLine ? localTs(m.time) : m.time, position: m.position, shape: m.shape, color: TONE[m.tone] || C.info, text: m.text, size: 1,
    })));
  }

  // 默认显示最近一段，可拖动 / 滚轮缩放看更早的
  const n = pts.length;
  const show = VISIBLE_BARS[data.tf] && Math.round(VISIBLE_BARS[data.tf] * Math.min(1, el.clientWidth / 800));
  if (show && n > show) chart.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 3 });
  else chart.timeScale().fitContent();

  // 左上角图例：随十字光标显示 OHLC
  const legendEl = document.createElement('div');
  legendEl.className = 'tv-legend';
  el.appendChild(legendEl);
  const byTime = new Map(isLine ? pts.map((p) => [localTs(p.time), p]) : pts.map((b, i) => [b.time, { ...b, prev: pts[i - 1]?.c }]));
  const render = (bar) => {
    const head = `<b>${esc(name || data.id)}</b> <span class="faint">${TF_LABEL[data.tf]}</span>`;
    if (!bar) { legendEl.innerHTML = head; return; }
    if (isLine) {
      const ch = data.prevClose ? (bar.value / data.prevClose - 1) * 100 : null;
      legendEl.innerHTML = `${head} <span class="mono">${num(bar.value, precision)}</span>${ch != null ? ` <span class="${ch >= 0 ? 'up' : 'down'} mono">${pct(ch)}</span>` : ''}`;
      return;
    }
    const ref = bar.prev ?? bar.o;
    const ch = ref ? (bar.c / ref - 1) * 100 : 0;
    const k = bar.c >= bar.o ? 'up' : 'down';
    legendEl.innerHTML = `${head} <span class="faint">开</span><span class="${k} mono">${num(bar.o, precision)}</span> <span class="faint">高</span><span class="${k} mono">${num(bar.h, precision)}</span> <span class="faint">低</span><span class="${k} mono">${num(bar.l, precision)}</span> <span class="faint">收</span><span class="${k} mono">${num(bar.c, precision)}</span> <span class="${ch >= 0 ? 'up' : 'down'} mono">${pct(ch)}</span> <span class="faint">量</span><span class="mono">${vol(bar.v)}</span>`;
  };
  const lastBar = () => (isLine ? { value: current?.lastValue ?? lastPrice } : current?.lastBar);
  chart.subscribeCrosshairMove((p) => {
    if (!p.time) { render(lastBar()); return; }
    render(byTime.get(p.time) || lastBar());
  });

  current = { chart, id: data.id, tf: data.tf, data, main, volume, isLine, legendEl, render, byTime, C,
    lastBar: isLine ? null : { ...pts[n - 1], prev: pts[n - 2]?.c }, lastValue: isLine ? lastPrice : null };
  render(lastBar());
}

/** 实时报价推送：更新最后一根 K 线（或在分时上追加一个点）。 */
export function updateLive(q) {
  const c = current;
  if (!c || c.id !== q.id || q.last == null) return;
  if (!document.body.contains(c.chart.chartElement())) { destroyChart(); return; }
  if (c.isLine) {
    const t = localTs(Math.floor(new Date(q.updatedAt || Date.now()).getTime() / 1000));
    try { c.main.update({ time: t, value: q.last }); } catch { return; } // 时间早于最后一点时忽略
    c.lastValue = q.last; c.byTime.set(t, { value: q.last });
    c.render({ value: q.last });
    return;
  }
  const b = c.lastBar;
  if (!b) return;
  // 只在最后一根 K 线就是今天（或本周 / 本月）时更新，避免把新交易日的价格并进旧 K 线
  const today = q.tradeDate;
  if (!today) return;
  const key = c.tf === 'D' ? today : c.tf === 'W' ? weekStart(today) : `${today.slice(0, 7)}-01`;
  if (key !== b.time) return;
  if (c.tf === 'D') Object.assign(b, { o: q.open ?? b.o, h: q.high ?? Math.max(b.h, q.last), l: q.low ?? Math.min(b.l, q.last), c: q.last, v: q.volume ?? b.v });
  else Object.assign(b, { h: Math.max(b.h, q.last), l: Math.min(b.l, q.last), c: q.last });
  c.main.update({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c });
  if (c.volume && c.tf === 'D') c.volume.update({ time: b.time, value: b.v || 0, color: alpha(b.c >= b.o ? c.C.up : c.C.down, 0.45) });
  c.byTime.set(b.time, b);
  c.render(b);
}

function weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
