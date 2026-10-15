// 真实新闻源调度：财联社电报（A 股 / 港股，每分钟）+ Finnhub（美股，配置密钥后每 ~5 分钟一轮）。
// 写入 db.articles（按 url 去重、只保留近 3 天且最多 MAX_ARTICLES 条），再跑新闻流水线。
// 任一真实源首次入库成功后清掉演示新闻；两个源都不可用时保留 Mock 新闻。
import { db, save } from './store.js';
import * as CLS from './providers/cls.js';
import * as FH from './providers/finnhub.js';

const KEEP_MS = 3 * 86400e3;
const MAX_ARTICLES = 4000;
const isMock = (a) => !a.feed && String(a.url || '').includes('example.com/mock');

export const realNewsEnabled = () => CLS.enabled() || FH.enabled();

/** 合并新文章。返回新增条数。 */
export function ingestArticles(list, now = new Date()) {
  if (!list.length) return 0;
  if (db.articles.some(isMock)) db.articles = db.articles.filter((a) => !isMock(a));
  const byUrl = new Map(db.articles.map((a) => [a.url || a.id, a]));
  let added = 0;
  for (const a of list) {
    if (!a.title || !a.url) continue;
    const old = byUrl.get(a.url);
    if (old) {
      // 同一篇在不同标的的 company-news 里重复出现：合并显式关联的标的
      if (a.symbols?.length) old.symbols = [...new Set([...(old.symbols || []), ...a.symbols])];
      continue;
    }
    byUrl.set(a.url, a); added++;
  }
  const cutoff = new Date(now.getTime() - KEEP_MS).toISOString();
  db.articles = [...byUrl.values()].filter((a) => a.publishedAt >= cutoff)
    .sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)).slice(0, MAX_ARTICLES);
  return added;
}

export const newsFeedState = () => ({ cls: CLS.clsState(), finnhub: FH.finnhubState(), articles: db.articles.length, mock: db.articles.some(isMock) });

/** 启动轮询。onIngest(now) 在每次有新文章入库后调用（跑流水线 + 提醒 + 保存）。 */
export function startNewsFeeds(onIngest) {
  const timers = [];
  const handle = (list) => {
    const n = ingestArticles(list);
    if (n) { onIngest(new Date()); save(); }
    return n;
  };
  if (CLS.enabled()) {
    console.log('[news] 财联社电报已启用：每 60 秒拉取');
    CLS.pollCls({ pages: 6 }).then((l) => console.log(`[news] 财联社电报回补 ${handle(l)} 条`));
    timers.push(setInterval(() => CLS.pollCls().then(handle), Number(process.env.CLS_POLL_MS || 60000)));
  }
  if (FH.enabled()) {
    console.log(`[news] Finnhub 已启用：${FH.usStockSymbols().length} 只美股个股 + 市场要闻，约每 5 分钟一轮`);
    const CYCLE = Number(process.env.FINNHUB_CYCLE_MS || 300000);
    let stopped = false; let wait = null;
    const loop = async () => {
      while (!stopped) {
        const t0 = Date.now();
        await FH.pollFinnhub(handle);
        await new Promise((r) => { wait = setTimeout(r, Math.max(10000, CYCLE - (Date.now() - t0))); });
      }
    };
    loop();
    timers.push({ stop: () => { stopped = true; clearTimeout(wait); } });
  } else console.log('[news] Finnhub 未启用（.env 中设置 FINNHUB_API_KEY 后启用美股新闻）');
  if (!realNewsEnabled()) console.log('[news] 无真实新闻源，使用演示新闻');
  return () => timers.forEach((t) => (t.stop ? t.stop() : clearInterval(t)));
}
