# 个人投资研究与监控工作台（MVP）

围绕"发现变化 → 获取信息 → AI 分析 → 查看证据 → 形成判断 → 记录观点 → 持续跟踪 → 复盘判断"的研究闭环，把宏观行情、新闻事件、个股研究、财报公告、群聊、个人研究记录和交易计划统一关联到"投资标的"上。

## 快速开始

需要 Node.js 20 及以上，后端没有任何必需依赖。

```bash
cd invest-workbench
npm start                 # 打开 http://localhost:3000
npm test                  # 运行核心规则测试
node server/index.js --reset   # 清空数据并重新生成演示数据
```

可选配置（环境变量）：

| 变量 | 作用 |
| --- | --- |
| `OPENCLAW_TOKEN` / `OPENCLAW_HOOKS_TOKEN` | 接入本机 OpenClaw，见 [openclaw/README.md](openclaw/README.md) |
| `ANTHROPIC_API_KEY` | 不用 OpenClaw 时的备选：对话框直接调用 Claude 进行工具调用推理（需先 `npm install` 安装可选依赖 `@anthropic-ai/sdk`）；不设置则使用本地规则引擎 |
| `CLAUDE_MODEL` | 默认 `claude-opus-5-5` |
| `DISCORD_MESSAGES_DIR` | discord-local 的 `messages` 目录，设置后每 15 秒增量同步群聊 |
| `DISCORD_TZ` | discord-local 运行机器的时区，默认 `Asia/Shanghai` |
| `MOCK_SESSION` | 演示行情的美股交易时段，默认 `regular`（随时可看到 5% 异动规则），设为 `real` 则按真实美东时间 |
| `WATCHLIST_FILE` | 首次生成数据时读取的关注列表，默认 `data/my-watchlist.xlsx`（不提交到 git）；设为空字符串则使用演示自选 |
| `GANGTISE_ACCESS_KEY` / `GANGTISE_SECRET_KEY` | 接入 Gangtise 真实行情、财报、公告、业绩日历，见下方"Gangtise 接入" |
| `GANGTISE_DAILY_POINTS` | 按行计费接口（公告、业绩日历）每日积分上限，默认 200 |
| `GANGTISE_POLL_MS` | 实时行情轮询间隔，默认 60000 |
| `PORT` | 默认 3000 |

## Gangtise 接入

在工作台根目录建一个 `.env`（已在 `.gitignore` 中，不会进 git），写入你在 Gangtise 开放平台拿到的密钥：

```bash
GANGTISE_ACCESS_KEY=你的AccessKey
GANGTISE_SECRET_KEY=你的SecretKey
```

```bash
chmod 600 .env && npm start
```

也可以直接用环境变量传入（环境变量优先于 `.env`）。启用后：

| 数据 | 来源 | 频率 / 费用 |
| --- | --- | --- |
| 美股个股、港股、A 股、主要指数（标普 500、纳指、道指、恒指、上证、深成指）行情 | 实时快照 `quote/realtime`，有自选的市场按整市场拉取 | 交易时段每 60 秒，休市每 30 分钟；免费 |
| 日 K（图表、20 日均量） | `kline/daily` | 启动后后台预取，每天一次；免费 |
| 财报（营收、毛利、营业利润、净利润、EPS、FCF、现金、负债） | 美股 / 港股 / A 股三张表，累计口径拆成单季度 | 打开标的详情时拉取，每天一次；免费 |
| 公司公告 | 美股 / 港股 / A 股公告列表 | 打开详情时拉 10 条；置顶股票每天 5 条；0.1 积分 / 行 |
| 自选股财报日 | 业绩日历 | 每天一次，未来 30 天；0.1 积分 / 行 |

- 按行计费的接口每天受 `GANGTISE_DAILY_POINTS`（默认 200）约束，用量记在 `data/gangtise-usage.json`；不调用任何 AI 类接口。
- Gangtise 不覆盖的标的（美股 ETF、纳指 100、VIX、恒生科技、宏观商品、外汇、加密）继续使用 Mock 行情；新闻和宏观经济日历暂为 Mock。界面上每处数据都标注 `Gangtise` 或 `演示`。
- 任何一路取数失败只影响这一路：行情保留上一次报价，财报 / K 线回退到原有数据。状态见"规则任务"页的"数据源状态"或 `GET /api/gangtise/status`。
- 美股代码后缀（`.O` / `.N` / `.A`）以整市场快照为准，缓存在 `data/gangtise-symbols.json`。

## 哪些是演示数据

未配置 Gangtise 时，**行情、新闻、公告、财务数据、经济日历**都是 Mock 数据（界面右上角和每处数据源都会标注），新闻链接指向 `example.com`。群聊默认也是演示数据，接入 discord-local 后为真实数据。替换真实数据源时只需实现同样的接口：

- 行情：`server/providers/market.js`（`seedInstrument / tick / bars`）
- 新闻：向 `db.articles` 写入原始文章后调用 `processNews()`，去重、聚合、实体识别、排序都会自动完成
- 公告、财务、日历：`db.filings / db.financials / db.calendar`，结构见 `server/seed.js`

## 架构

```
web/                     投资大屏 · 标的详情 · 提醒中心 · 群聊洞察 · 自选导入 · 规则任务 · 右下角 OpenClaw
server/
  index.js               REST API + SSE 实时推送 + 静态文件
  store.js               持久化（data/db.json，可替换为数据库）
  providers/market.js    行情数据源（Mock；Gangtise 覆盖的标的由真实行情接管）
  providers/gangtise.js  Gangtise Open API 客户端（登录、token 缓存、积分台账）
  providers/gangtiseMarket.js  Gangtise 行情 / 日 K / 财报 / 公告 / 业绩日历接入
  news.js                新闻流水线：采集→去重→事件聚合→实体识别→标的关联→摘要→重要性排序
  watchlist.js           自选分组、搜索、排序、置顶、TradingView 导入去重
  rules/priceMove.js     5% 异动（分盘前/盘中/盘后）、成交量异常、关键价位
  rules/chatHeat.js      群聊统计、跨群热度、重复内容识别
  research.js            研究记录、交易计划、研究版本对比、AI 建议、财务指标
  alerts.js              统一提醒中心（未读/已读/已处理/忽略，dedupeKey 防重复）
  connectors/discordLocal.js   群聊 Connector：读取 discord-local 的 jsonl
  agent/tools.js         OpenClaw 工具层（13 个工具）
  agent/agent.js         Agent 编排：意图理解、页面上下文、Claude 工具调用、会话历史
  agent/analysis.js      本地分析能力（异动原因、财报、投资逻辑检查、报告…）
  agent/jobs.js          主动式任务：定时任务 + 事件触发
  agent/openclaw.js      本机 OpenClaw 桥接：对话转发、任务派发、结果回写
openclaw/                OpenClaw skill（invest-workbench）与配置说明
```

业务后端负责确定性计算（是否涨超 5%、几个群在讨论、提醒是否已发），OpenClaw 负责理解、分析和生成。

## 关键规则

**股票异动**：涨跌幅 =（最新价 − 上一交易日收盘价）÷ 上一交易日收盘价 × 100%，|涨跌幅| ≥ 5% 触发。美股盘前、盘中、盘后分别配置，默认只在正常交易时段启用。同一交易日同方向只提醒一次，扩大到 10%、15% 时再提醒。第一阶段由后端即时提醒，第二阶段异步调用 OpenClaw，按"已确认事件 / 可能影响因素 / 暂无明确原因"输出，没有证据时明确写"暂无明确原因"。

**跨群热度**：60 分钟滚动窗口内，同一标的被 ≥4 个不同群有效讨论时触发。有效讨论为单群 ≥3 条相关消息或 ≥2 名独立用户。同一段内容被复制到多个群时标记"信息正在传播"，并单独统计剔除转发后的"独立讨论群"。

**研究记录**：投资逻辑、核心假设、待验证问题、交易计划、复盘结论只能由用户修改，每次保存生成版本并可对比。AI 只能写入"AI 建议"，由用户决定采纳或忽略。假设超过 30 天未检查会产生研究提醒。

**可信度**：所有 AI 输出按"已确认事实 / AI 分析 / 待验证 / 你的研究"四类标注并附证据链。

## OpenClaw 接入（本机）

Agent 用你自己电脑上的 OpenClaw：右下角对话框、5% 异动原因分析、开盘前简报和收盘后复盘都可以交给它，工作台只负责数据与第一阶段提醒。OpenClaw 通过 `openclaw/skills/invest-workbench` 这个 skill 调用工作台的 13 个工具，并把分析结果写回。安装与配置见 [openclaw/README.md](openclaw/README.md)，简要步骤：

```bash
npm run openclaw:install                                   # 安装 skill 到 OpenClaw 工作区
OPENCLAW_TOKEN=... OPENCLAW_HOOKS_TOKEN=... npm start      # 对话框和分析任务交给 OpenClaw
```

没配置或 OpenClaw 没开时自动回退到本地规则。接口：

```
GET  /api/agent/tools            工具清单（name / description / input_schema）
POST /api/agent/tools/:name      执行工具，返回 { data, evidence }
POST /api/agent/results          OpenClaw 写回分析结果 { kind, text, task?, alert?, symbol?, title? }
POST /api/agent/ask              { question, context: { page, symbol }, sessionId? }
GET  /api/openclaw/status        接入状态、进行中的任务、最近回写
```

## 关注列表导入（Excel / CSV / TradingView）

在"自选与导入"页上传 `.xlsx` / `.csv`，按表头识别"一级、二级、名称、完整代码、简介、原所在列表"等列：一级分类成为大类（A股、美股、港股、加密、宏观指标与商品…），二级分类成为分组；一级分类含"宏观 / 指标 / 商品"的进入宏观列表（"宏观指标"页按分组展示，置顶项显示在大屏顶部）。xlsx 优先读取名为"明细"的工作表。可选择"合并"或"替换全部分组"。支持 `AMEX:GDX/TVC:GOLD`、`TVC:US10Y-FRED:T10YIE` 这类比值/价差表达式，报价由两条腿计算。

### TradingView

在 TradingView 自选列表菜单选择"导出列表"得到 `.txt`，在"自选与导入"页上传。`###分区名` 会成为同名分组，宏观资产（TVC、OANDA、COMEX、NYMEX 等）自动进入宏观观察列表，`TVC:GOLD` 之类的写法会映射到平台标的（现货黄金）。可重复导入，已存在的标的自动跳过。示例：`samples/tradingview_watchlist.txt`。

## 群聊接入（discord-local）

discord-local 把消息存成 `messages/<服务器>/<频道>/<日期>.jsonl`。两种接法：

1. 启动时设置 `DISCORD_MESSAGES_DIR=/path/to/discord-local/messages`，增量同步；
2. 在"自选与导入"页手动上传 jsonl 文件。

消息按原始消息 ID 去重，转发的卡片（embed）标题与描述会并入正文。示例：`samples/discord-messages/`（时间为生成当天，导入后在"群聊洞察"选择"3 天"可看到）。

## 后续可以做的

- 接入真实行情（富途 / IBKR / Polygon / Tushare 等）、新闻源、SEC EDGAR、经济日历
- 数据层换成 SQLite / Postgres
- 一致预期数据（判断财报超预期 / 低于预期）
- 微信、Telegram 的 Connector
