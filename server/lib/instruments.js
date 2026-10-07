// 标的主数据与代码规范化。
// 标的统一 ID：`交易所:代码`，例如 NASDAQ:NVDA、SSE:600519、HKEX:700。
// 宏观资产严格区分现货 / 期货（当前合约、主力合约、连续合约）。

export const MARKET_BY_EXCHANGE = {
  NASDAQ: 'US', NYSE: 'US', AMEX: 'US', NYSEARCA: 'US', BATS: 'US', CBOE: 'US', OTC: 'US',
  SSE: 'CN', SZSE: 'CN', BSE: 'CN',
  HKEX: 'HK',
  TSE: 'JP', KRX: 'KR', TWSE: 'TW', TPEX: 'TW', XETR: 'DE', TSX: 'CA', MYX: 'MY',
  BINANCE: 'CRYPTO', OKX: 'CRYPTO', BITGET: 'CRYPTO', BITSTAMP: 'CRYPTO', COINBASE: 'CRYPTO', BYBIT: 'CRYPTO', CRYPTOCAP: 'CRYPTO',
};
export const CRYPTO_EXCHANGES = new Set(['BINANCE', 'OKX', 'BITGET', 'BITSTAMP', 'COINBASE', 'BYBIT', 'CRYPTOCAP']);
export const MARKET_LABEL = { US: '美股', CN: 'A股', HK: '港股', JP: '日本', KR: '韩国', TW: '台湾', DE: '德国', CA: '加拿大', MY: '马来西亚', CRYPTO: '加密', GLOBAL: '全球' };

// 宏观资产主数据。contract 字段只对期货存在。
export const MACRO_INSTRUMENTS = [
  { id: 'OANDA:XAUUSD', name: '现货黄金', type: 'commodity_spot', market: 'GLOBAL', currency: 'USD', unit: '美元/盎司',
    tvAliases: ['TVC:GOLD', 'FX_IDC:XAUUSD', 'FOREXCOM:XAUUSD', 'XAUUSD'], aliases: ['黄金', '金价', 'gold', '现货黄金'] },
  { id: 'COMEX:GC1!', name: 'COMEX 黄金期货（连续）', type: 'future', market: 'GLOBAL', currency: 'USD', unit: '美元/盎司',
    contract: { kind: 'continuous', current: 'GCZ2026', main: 'GCZ2026', rollRule: '主力合约切换至下一活跃月（按持仓量）时换月，连续合约不复权' },
    tvAliases: ['COMEX:GC1!', 'COMEX:GCZ2026'], aliases: ['comex黄金', '黄金期货'] },
  { id: 'OANDA:XAGUSD', name: '现货白银', type: 'commodity_spot', market: 'GLOBAL', currency: 'USD', unit: '美元/盎司',
    tvAliases: ['TVC:SILVER', 'XAGUSD'], aliases: ['白银', 'silver'] },
  { id: 'NYMEX:CL1!', name: 'WTI 原油期货（连续）', type: 'future', market: 'GLOBAL', currency: 'USD', unit: '美元/桶',
    contract: { kind: 'continuous', current: 'CLX2026', main: 'CLX2026', rollRule: '到期前 3 个交易日换至次月合约' },
    tvAliases: ['NYMEX:CL1!', 'TVC:USOIL'], aliases: ['原油', 'wti', '美油'] },
  { id: 'ICEEUR:BRN1!', name: 'Brent 原油期货（连续）', type: 'future', market: 'GLOBAL', currency: 'USD', unit: '美元/桶',
    contract: { kind: 'continuous', current: 'BRNZ2026', main: 'BRNZ2026', rollRule: '到期前 2 个交易日换至次月合约' },
    tvAliases: ['ICEEUR:BRN1!', 'TVC:UKOIL'], aliases: ['布伦特', 'brent'] },
  { id: 'TVC:DXY', name: '美元指数', type: 'index', market: 'GLOBAL', currency: '', unit: '点',
    tvAliases: ['TVC:DXY', 'DXY'], aliases: ['美元', '美元指数', 'dxy'] },
  { id: 'TVC:US10Y', name: '10 年期美债收益率', type: 'bond_yield', market: 'US', currency: '', unit: '%',
    tvAliases: ['TVC:US10Y'], aliases: ['美债', '美债收益率', '10年期美债', 'us10y'] },
  { id: 'SP:SPX', name: '标普 500', type: 'index', market: 'US', currency: 'USD', unit: '点',
    tvAliases: ['SP:SPX', 'TVC:SPX', 'SPX'], aliases: ['标普', '标普500', 's&p 500', 'spx'] },
  { id: 'NASDAQ:IXIC', name: '纳斯达克综合指数', type: 'index', market: 'US', currency: 'USD', unit: '点',
    tvAliases: ['NASDAQ:IXIC', 'TVC:IXIC'], aliases: ['纳指', '纳斯达克', 'nasdaq'] },
  { id: 'DJ:DJI', name: '道琼斯工业指数', type: 'index', market: 'US', currency: 'USD', unit: '点',
    tvAliases: ['DJ:DJI', 'TVC:DJI'], aliases: ['道指', '道琼斯', 'dow'] },
  { id: 'SSE:000001', name: '上证指数', type: 'index', market: 'CN', currency: 'CNY', unit: '点',
    tvAliases: ['SSE:000001'], aliases: ['上证', '上证指数', '大盘'] },
  { id: 'HSI:HSI', name: '恒生指数', type: 'index', market: 'HK', currency: 'HKD', unit: '点',
    tvAliases: ['HSI:HSI', 'TVC:HSI'], aliases: ['恒指', '恒生指数'] },
  { id: 'FX_IDC:USDCNH', name: '美元/离岸人民币', type: 'fx', market: 'GLOBAL', currency: '', unit: '',
    tvAliases: ['FX_IDC:USDCNH', 'FX:USDCNH', 'USDCNH'], aliases: ['人民币', '离岸人民币', '汇率', 'usdcnh'] },
];

export const STOCK_INSTRUMENTS = [
  { id: 'NASDAQ:NVDA', name: '英伟达', enName: 'NVIDIA', sector: '半导体', aliases: ['nvda', 'nvidia', '英伟达', '老黄', '伟达'] },
  { id: 'NASDAQ:AAPL', name: '苹果', enName: 'Apple', sector: '消费电子', aliases: ['aapl', 'apple', '苹果'] },
  { id: 'NASDAQ:TSLA', name: '特斯拉', enName: 'Tesla', sector: '汽车', aliases: ['tsla', 'tesla', '特斯拉', '特斯啦', '马斯克家'] },
  { id: 'NASDAQ:META', name: 'Meta', enName: 'Meta Platforms', sector: '互联网', aliases: ['meta', 'facebook', '脸书', 'fb'] },
  { id: 'NASDAQ:GOOGL', name: '谷歌', enName: 'Alphabet', sector: '互联网', aliases: ['googl', 'goog', 'google', '谷歌', 'alphabet'] },
  { id: 'NASDAQ:MSFT', name: '微软', enName: 'Microsoft', sector: '软件', aliases: ['msft', 'microsoft', '微软'] },
  { id: 'NYSE:TSM', name: '台积电', enName: 'TSMC', sector: '半导体', aliases: ['tsm', 'tsmc', '台积电'] },
  { id: 'NASDAQ:AMD', name: 'AMD', enName: 'Advanced Micro Devices', sector: '半导体', aliases: ['amd', '超威', '苏妈'] },
  { id: 'SSE:600519', name: '贵州茅台', enName: 'Kweichow Moutai', sector: '白酒', aliases: ['600519', '茅台', '贵州茅台'] },
  { id: 'HKEX:700', name: '腾讯控股', enName: 'Tencent', sector: '互联网', aliases: ['0700', '00700', '腾讯', 'tencent'] },
  { id: 'HKEX:9988', name: '阿里巴巴-W', enName: 'Alibaba', sector: '互联网', aliases: ['9988', '09988', '阿里', '阿里巴巴', 'alibaba'] },
].map((s) => ({ ...s, type: 'stock', market: MARKET_BY_EXCHANGE[s.id.split(':')[0]], currency: currencyFor(s.id) }));

export function currencyFor(id) {
  const m = MARKET_BY_EXCHANGE[id.split(':')[0]];
  return { CN: 'CNY', HK: 'HKD', JP: 'JPY', KR: 'KRW', TW: 'TWD', DE: 'EUR', CA: 'CAD', MY: 'MYR' }[m] || 'USD';
}

const MACRO_EXCHANGES = new Set(['TVC', 'OANDA', 'FX', 'FX_IDC', 'FOREXCOM', 'ICMARKETS', 'COMEX', 'NYMEX', 'ICEEUR', 'ICEUS', 'CBOT', 'SP', 'DJ', 'HSI', 'CAPITALCOM', 'ECONOMICS', 'FRED', 'CME', 'CME_MINI']);

// 比值 / 价差表达式，如 AMEX:GDX/TVC:GOLD、TVC:US10Y-FRED:T10YIE
const EXPR_RE = /^([A-Z0-9_]+:[^/]+?)([/-])([A-Z0-9_]+:.+)$/;
export function parseExpression(id) {
  const m = String(id).match(EXPR_RE);
  if (!m || m[1].endsWith('-')) return null;
  return { left: m[1], op: m[2], right: m[3] };
}

/** 规范化一个代码（TradingView 写法或用户输入）为平台 ID。返回 null 表示无法识别。 */
export function normalizeSymbol(raw, instruments) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^["']|["']$/g, '').toUpperCase();
  if (!s || s.startsWith('###')) return null;
  const expr = parseExpression(s);
  if (expr) {
    // 比值 / 价差保留用户原始写法（各腿不做别名映射），由行情层按各腿计算
    const l = normalizeSymbol(expr.left, []); const r = normalizeSymbol(expr.right, []);
    return l && r ? `${l}${expr.op}${r}` : null;
  }
  // 先查 TradingView 别名
  for (const inst of instruments) {
    if (inst.id.toUpperCase() === s) return inst.id;
    if ((inst.tvAliases || []).some((a) => a.toUpperCase() === s)) return inst.id;
  }
  if (!s.includes(':')) return null;
  let [ex, code] = s.split(':');
  if (!ex || !code) return null;
  if (ex === 'HKEX') code = String(Number(code)) === 'NaN' ? code : String(Number(code));
  if (ex === 'SSE' || ex === 'SZSE') code = code.padStart(6, '0');
  return `${ex}:${code}`;
}

/** 判断一个平台 ID 应归入宏观列表还是股票列表。 */
export function classify(id, instruments) {
  const inst = instruments.find((i) => i.id === id);
  if (inst) return ['stock', 'crypto', 'etf'].includes(inst.type) ? 'stock' : 'macro';
  if (parseExpression(id)) return 'macro';
  const [ex, code] = id.split(':');
  if (MACRO_EXCHANGES.has(ex)) return 'macro';
  if (code.endsWith('!')) return 'macro';
  if (ex === 'SSE' && /^000\d{3}$/.test(code)) return 'macro'; // 上证指数类
  if (ex === 'SZSE' && /^399\d{3}$/.test(code)) return 'macro';
  return 'stock';
}

/** 推断新标的的资产类型 */
export function inferType(id) {
  if (parseExpression(id)) return 'spread';
  const [ex, code] = id.split(':');
  if (CRYPTO_EXCHANGES.has(ex)) return ex === 'CRYPTOCAP' ? 'index' : 'crypto';
  if (code.endsWith('!')) return 'future';
  if (ex === 'FRED' || ex === 'ECONOMICS') return 'econ';
  if (/^(US|DE|JP|GB|CN)\d{2}Y$/.test(code)) return 'bond_yield';
  if (['OANDA', 'FX', 'FX_IDC', 'FOREXCOM', 'ICMARKETS'].includes(ex)) return /^X(AU|AG|PT|PD|TI|BR)/.test(code) ? 'commodity_spot' : /^[A-Z]{6}$/.test(code) ? 'fx' : 'cfd';
  if (['TVC', 'SP', 'DJ', 'HSI'].includes(ex)) return /SILVER|GOLD|OIL/.test(code) ? 'commodity_spot' : 'index';
  if ((ex === 'SSE' && /^000\d{3}$/.test(code)) || (ex === 'SZSE' && /^399\d{3}$/.test(code))) return 'index';
  return 'stock';
}

/** 在文本中识别投资标的（代码、中文简称、英文名、别名）。 */
export function findMentions(text, instruments) {
  const found = new Set();
  const lower = ` ${String(text).toLowerCase()} `;
  for (const inst of instruments) {
    const keys = [...(inst.aliases || []), inst.name?.toLowerCase(), inst.enName?.toLowerCase()].filter(Boolean);
    for (const k of keys) {
      const key = k.toLowerCase();
      if (/^[a-z0-9.&\s]+$/.test(key)) {
        // 拉丁字母别名需要词边界，避免 "fb" 命中 "fbi"
        const re = new RegExp(`(^|[^a-z0-9$])\\$?${escapeRe(key)}([^a-z0-9]|$)`);
        if (re.test(lower)) { found.add(inst.id); break; }
      } else if (lower.includes(key)) { found.add(inst.id); break; }
    }
  }
  return [...found];
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function allSeedInstruments() {
  return [...MACRO_INSTRUMENTS, ...STOCK_INSTRUMENTS];
}
