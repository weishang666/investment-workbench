// 个股图表数据：周 / 月 K 合成、价位线、市场日期
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.WATCHLIST_FILE = '';
const { aggregate, planLevels, marketDate, chartData } = await import('../server/chart.js');
const { seed } = await import('../server/seed.js');

test('日 K 按周合成：周一为周起点，开取首日、收取末日、高低取极值、量相加', () => {
  const d = [
    { time: '2026-10-15', o: 10, h: 11, l: 9, c: 10.5, v: 100 }, // 周四
    { time: '2026-10-16', o: 10.5, h: 12, l: 10, c: 11, v: 200 }, // 周五
    { time: '2026-10-19', o: 11, h: 11.5, l: 8, c: 9, v: 50 }, // 下周一
  ];
  assert.deepEqual(aggregate(d, 'W'), [
    { time: '2026-10-12', o: 10, h: 12, l: 9, c: 11, v: 300 },
    { time: '2026-10-19', o: 11, h: 11.5, l: 8, c: 9, v: 50 },
  ]);
  assert.equal(aggregate(d, 'M').length, 1);
  assert.equal(aggregate(d, 'M')[0].time, '2026-10-01');
});

test('交易计划价位线只画有效数字', () => {
  const lv = planLevels({ stopLoss: '105', target: 160, buyLow: '', watchPrice: 'abc' });
  assert.deepEqual(lv.map((x) => [x.key, x.price]), [['target', 160], ['stopLoss', 105]]);
});

test('提醒时间按市场当地日期归到 K 线', () => {
  assert.equal(marketDate('2026-10-22T02:00:00Z', 'US'), '2026-10-21');
  assert.equal(marketDate('2026-10-22T02:00:00Z', 'HK'), '2026-10-22');
});

test('chartData 返回日 / 周 / 月 K 和分时', () => {
  seed(new Date());
  const d = chartData('NASDAQ:NVDA', 'D');
  assert.equal(d.kind, 'candle');
  assert.ok(d.candles.length > 200);
  assert.ok(d.candles.every((b, i) => i === 0 || b.time > d.candles[i - 1].time), '时间严格递增');
  assert.ok(chartData('NASDAQ:NVDA', 'W').candles.length < d.candles.length);
  const i = chartData('NASDAQ:NVDA', 'intraday');
  assert.equal(i.kind, 'line');
  assert.ok(i.line.length > 0);
});
