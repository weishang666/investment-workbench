# 用本机 OpenClaw 做投研工作台的 Agent

分工：工作台负责数据和确定性规则（涨超 5% 立即提醒、几个群在讨论、提醒去重），OpenClaw 负责理解、分析和生成。
两者都跑在你自己的电脑上：工作台 `http://127.0.0.1:3000`，OpenClaw Gateway 默认 `http://127.0.0.1:18789`。

```
工作台右下角对话框 ──/v1/chat/completions──▶ OpenClaw ──invest-workbench skill──▶ 工作台工具（13 个）
工作台异动提醒/定时日报 ──/hooks/agent──▶ OpenClaw ──取证、分析──▶ wb.mjs result 写回工作台
```

## 1. 安装 skill

```bash
cd invest-workbench
npm run openclaw:install          # 复制到 ~/.openclaw/workspace/skills/invest-workbench
# 工作区不在默认位置：npm run openclaw:install -- /你的/workspace
```

skill 只依赖 Node（OpenClaw 本身就需要）。工作台不在 3000 端口时，给 OpenClaw 设置环境变量 `WORKBENCH_URL`。
装好后在 OpenClaw 里 `/new` 开新会话，问一句"用投研工作台看看英伟达今天怎么样"即可验证。

## 2. 打开 Gateway 的两个 HTTP 入口

编辑 `~/.openclaw/openclaw.json`，在已有内容里合并：

```json5
{
  gateway: {
    auth: { mode: "token", token: "<Gateway token，自己生成一串长随机数>" },
    http: { endpoints: { chatCompletions: { enabled: true } } },   // 对话框用
  },
  hooks: {                                                          // 异动分析、日报用
    enabled: true,
    token: "<另一串长随机数，不要和 Gateway token 相同>",
    path: "/hooks",
    allowedAgentIds: ["main"],
  },
}
```

改完重启 OpenClaw Gateway 让配置生效。这两个入口拥有完整的 operator 权限，保持 Gateway 只监听本机（默认 `bind: loopback`），不要暴露到公网。

## 3. 启动工作台时告诉它 OpenClaw 在哪

```bash
OPENCLAW_TOKEN=<Gateway token> \
OPENCLAW_HOOKS_TOKEN=<hooks token> \
npm start
```

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPENCLAW_TOKEN` | 空 | 设置后右下角对话框交给 OpenClaw 回答 |
| `OPENCLAW_HOOKS_TOKEN` | 空 | 设置后 5% 异动原因分析、开盘前简报、收盘后复盘交给 OpenClaw |
| `OPENCLAW_URL` | `http://127.0.0.1:18789` | Gateway 地址 |
| `OPENCLAW_AGENT` | `main` | 使用哪个 OpenClaw agent |
| `OPENCLAW_DELIVER` | `0` | 设为 `1` 时 OpenClaw 把分析结果同时推送到你常用的聊天渠道（Telegram、微信等） |
| `OPENCLAW_CHAT_TIMEOUT` | `180` | 对话等待秒数 |
| `OPENCLAW_RESULT_TIMEOUT` | `600` | 派发的任务多少秒没写回就改用本地规则 |

启动日志会显示当前模式；"规则与任务"页的"数据源状态"会显示 OpenClaw 是否接通、进行中的任务和最近回写的结果。

## 失败时会怎样

- OpenClaw 没开或连不上：对话框自动改用本地规则回答，并在回答开头注明。
- 派发任务失败或超时未写回：改用本地规则生成异动分析 / 日报，提醒照常发出（第一阶段提醒从不依赖 OpenClaw）。
- OpenClaw 不能修改你的研究记录和交易计划，只能通过 `research_notes` 的 `suggest` 提交建议，在标的页"AI 建议"里由你决定。

## 也可以让 OpenClaw 自己定时

工作台默认在美东 08:30 / 16:30 派发开盘前、收盘后任务。如果更想用 OpenClaw 自己的定时任务（`openclaw cron` / `openclaw automations`），可以在那边创建任务，消息写"用 invest-workbench skill 生成今日市场重点，并用 result premarket 写回工作台"，然后不设置 `OPENCLAW_HOOKS_TOKEN` 以免重复。
