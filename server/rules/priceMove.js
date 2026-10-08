// 股票异动规则（业务后端的确定性计算，不依赖 AI）。
// 涨跌幅 =（最新价 − 上一交易日收盘价）÷ 上一交易日收盘价 × 100%
// 默认：|涨跌幅| ≥ 5% 触发；美股仅正常交易时段启用，盘前 / 盘后可独立配置。
import { db, instrument } from '../store.js';
import { createAlert } from '../alerts.js';
import { watchedSymbols } from '../watchlist.js';
import { sessionProgress } from '../lib/sessions.js';

export function changePct(last, prevClose) {
  if (!prevClose) return 0;
  return ((last - prevClose) / prevClose) * 100;
}

/**
 * 纯函数：判断一条报价是否应触发异动提醒。
 * 返回 null 或 { pct, direction, tier, threshold, session, dedupeKey }
 */
export function evaluatePriceMove(quote, cfg, symbolMarket = 'US') {
  const session = quote.session;
  if (session === 'closed') return null;
  if (symbolMarket === 'US') {
    if (!cfg.sessions[session]) return null;
  } else if (session !== 'regular') return null;
  const threshold = cfg.perSymbol?.[quote.id] ?? cfg.sessionThresholds?.[session] ?? cfg.threshold;
  const pct = changePct(quote.last, quote.prevClose);
  if (Math.abs(pct) < threshold) return null;
  const step = cfg.escalateEvery || threshold;
  const tier = 1 + Math.floor((Math.abs(pct) - threshold) / step); // 5%→1, 10%→2 ...
  const direction = pct > 0 ? 'up' : 'down';
  return {
    pct: +pct.toFixed(2), direction, tier, threshold, session,
    dedupeKey: `price:${quote.id}:${quote.tradeDate}:${session}:${direction}:${tier}`,
  };
}

const SESSION_CN = { pre: '盘前', regular: '盘中', post: '盘后' };

/** 扫描所有自选股，触发第一阶段即时提醒。返回新建的提醒。 */
export function runPriceMoveRule(now = new Date()) {
  const cfg = db.settings.priceMove;
  const created = [];
  for (const id of watchedSymbols('stock')) {
    const q = db.quotes[id];
    const inst = instrument(id);
    if (!q || !inst) continue;
    const hit = evaluatePriceMove(q, cfg, inst.market);
    if (!hit) continue;
    const verb = hit.direction === 'up' ? '上涨' : '下跌';
    const a = createAlert({
      type: 'price', symbol: id, severity: hit.tier > 1 ? 'high' : 'medium', dedupeKey: hit.dedupeKey, now,
      title: `${shortCode(id)} ${SESSION_CN[hit.session]}${verb} ${Math.abs(hit.pct).toFixed(1)}%`,
      body: `${inst.name}（${id}）最新价 ${q.last}，相对上一交易日收盘价 ${q.prevClose} ${verb} ${Math.abs(hit.pct).toFixed(2)}%，超过 ${hit.threshold}% 阈值。`,
      data: { ...hit, last: q.last, prevClose: q.prevClose, quoteTime: q.updatedAt, source: q.source, delayMinutes: q.delayMinutes },
    });
    if (a) created.push(a);
  }
  return created;
}

/** 成交量异常：当前累计成交量 ≥ 20 日均量 × 交易进度 × ratio。 */
export function runVolumeRule(now = new Date()) {
  const created = [];
  for (const id of watchedSymbols('stock')) {
    const q = db.quotes[id];
    if (!q?.avgVolume20 || q.session !== 'regular') continue;
    // 真实行情按交易所时间算进度；Mock 行情按分时点数
    const real = q.provider === 'gangtise' ? sessionProgress(instrument(id)?.market, now) : null;
    const progress = Math.max(0.15, Math.min(1, real ?? (db.intraday[id]?.length || 0) / 390));
    const ratio = q.volume / (q.avgVolume20 * progress);
    if (ratio < db.settings.volume.ratio) continue;
    const a = createAlert({
      type: 'volume', symbol: id, severity: 'medium', now, dedupeKey: `volume:${id}:${q.tradeDate}`,
      title: `${shortCode(id)} 成交量放大 ${ratio.toFixed(1)} 倍`,
      body: `当前累计成交量 ${fmtVol(q.volume)}，按交易进度折算为 20 日均量的 ${ratio.toFixed(1)} 倍。`,
      data: { ratio: +ratio.toFixed(2), volume: q.volume, avgVolume20: q.avgVolume20 },
    });
    if (a) created.push(a);
  }
  return created;
}

/** 关键价位：价格触及用户交易计划中的关注价 / 止损 / 目标价。 */
export function runLevelRule(now = new Date()) {
  const created = [];
  for (const [id, r] of Object.entries(db.research)) {
    const q = db.quotes[id];
    const p = r.plan || {};
    if (!q) continue;
    const checks = [
      ['stopLoss', '止损价', q.last <= p.stopLoss],
      ['target', '目标价', q.last >= p.target],
      ['buyZone', '买入区间', p.buyLow && p.buyHigh && q.last >= p.buyLow && q.last <= p.buyHigh],
    ];
    for (const [key, label, hit] of checks) {
      if (!hit || p[key] === '' ) continue;
      const a = createAlert({
        type: 'level', symbol: id, severity: key === 'stopLoss' ? 'high' : 'medium', now, dedupeKey: `level:${id}:${key}:${q.tradeDate}`,
        title: `${shortCode(id)} 触及你设置的${label}`,
        body: `最新价 ${q.last}。这是你在交易计划中设置的条件，是否执行由你决定。`,
        data: { key, last: q.last, plan: p },
      });
      if (a) created.push(a);
    }
  }
  return created;
}

export function shortCode(id) { return id.split(':')[1]; }
function fmtVol(v) { return v >= 1e8 ? (v / 1e8).toFixed(2) + ' 亿' : v >= 1e4 ? (v / 1e4).toFixed(0) + ' 万' : String(v); }
