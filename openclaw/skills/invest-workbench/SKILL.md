---
name: invest-workbench
description: 个人投研工作台：查询行情、宏观、经济日历、新闻事件、公告、财务、自选、研究记录、交易计划、群聊与提醒，并把分析结果写回工作台。
metadata: {"openclaw":{"emoji":"📈","requires":{"bins":["node"]}}}
---

# 投研工作台

用户在本机运行着"个人投资研究与监控工作台"（默认 `http://127.0.0.1:3000`，可用环境变量 `WORKBENCH_URL` 修改）。
凡是涉及股票、宏观、新闻、财报、群聊讨论、用户自己的研究或交易计划的问题，都先用这个 skill 取证再回答。

## 怎么调用

所有命令都通过 exec 运行：

```bash
node {baseDir}/scripts/wb.mjs ping                                   # 确认工作台在运行
node {baseDir}/scripts/wb.mjs tools                                  # 工具清单
node {baseDir}/scripts/wb.mjs schema news_search                     # 某个工具的参数
node {baseDir}/scripts/wb.mjs call market_data '{"symbol":"NVDA","period":"1D"}'
node {baseDir}/scripts/wb.mjs call news_search '{"symbol":"英伟达","hours":24}'
```

`call` 返回 `{ data, evidence }`。`evidence` 里每一项有 `id`（如 `q:NASDAQ:NVDA`、`n:evt_x`、`f:...`、`c:...`）、来源、时间、链接，回答里用 `[证据: id1, id2]` 引用。

| 工具 | 用途 |
| --- | --- |
| `market_data` | 行情与 K 线（symbol，可选 period：intraday/1D/1W/1M/3M/1Y），含数据来源与延迟 |
| `macro_data` | 宏观观察列表：黄金、原油、美元、美债、指数、汇率；期货标明当前/主力/连续合约 |
| `economic_calendar` | CPI、非农、PMI、利率决议等（status：released/upcoming/all，hours） |
| `news_search` | 已去重、聚合、关联标的的新闻事件（query / symbol / hours） |
| `filing_search` | 公告与监管文件，官方来源优先 |
| `company_financials` | 财务指标与最新财报变化 |
| `watchlist` | 用户自选列表与涨跌幅（kind：stock/macro/all） |
| `research_notes` | 用户研究记录：投资逻辑、核心假设、待验证问题、复盘；`action=suggest` 提交建议 |
| `trading_plan` | 用户交易计划（只读） |
| `chat_search` | 群聊消息（未经证实信息） |
| `chat_stats` | 单标的跨群热度，或窗口内热门标的 |
| `alerts` | 统一提醒中心 |
| `report_generator` | 生成并保存结构化研究报告 |

标的可以写代码（`NASDAQ:NVDA`、`SSE:600519`、`HKEX:700`）、简称（`NVDA`）或中文名（`英伟达`）。

## 输出格式（必须遵守）

逐行输出，每行以一个标签开头，工作台按标签区分可信度：

- `【事实】` 工具返回的数据，或官方 / 多家媒体确认的内容，行末附 `[证据: id]`
- `【AI分析】` 你的推理与判断
- `【待验证】` 群聊、单一信源、知情人士、传闻
- `【用户研究】` 引用用户自己的研究记录或交易计划原文
- `## 标题` 用于分节

## 规则

1. 先取证再下结论。价格、财务数字、新闻必须来自工具，不要凭记忆。
2. 事实和推断分开写，不要把推断写成确定结论。
3. 价格异动按 `## 已确认事件` / `## 可能影响因素` / `## 暂无明确原因` 组织。只有带来源的事件能写进"已确认事件"。找不到证据就写"暂无明确原因"，**严禁编造原因**。
4. **不能修改用户的研究记录和交易计划。** 认为某个假设需要重新检查时，用
   `call research_notes '{"symbol":"NVDA","action":"suggest","suggestion":"……","assumption_id":"…"}'`
   提交建议，并告诉用户由他自己决定。
5. 群聊热度只代表关注度，不是买卖信号。不给确定性的买卖建议。
6. 行情注明来源和延迟；期货注明是哪个合约；当前工作台的行情、新闻、公告、财务、日历可能是演示数据（`ping` 会列出），回答时如实说明。

## 工作台派发的任务

收到以 `[投研工作台任务] taskId=...` 开头的消息时，这是工作台在后端提醒之后交给你的分析任务（异动原因、开盘前简报、收盘后复盘）。按消息里的要求取证分析，**完成后必须写回工作台**，否则工作台会在超时后改用本地规则：

```bash
node {baseDir}/scripts/wb.mjs result move_analysis --task t_xxx --alert al_xxx --symbol NASDAQ:NVDA <<'EOF'
## 已确认事件
【事实】英伟达与微软签署扩大供货协议（公司公告） [证据: f:f_xxx]
## 可能影响因素
【AI分析】……
## 暂无明确原因
【AI分析】……
EOF
```

`kind` 取 `move_analysis`、`premarket`、`postclose`、`chat_summary`、`research`、`report`、`other`。写回后再用一两句话告诉用户结论即可。

## 来自工作台对话框的问题

消息以 `[来自投研工作台｜页面：…，当前标的：…]` 开头时，用户正在工作台里提问。"这只股票""今天为什么跌"指的就是当前标的。直接按上面的格式回答，不需要调用 `result`。
