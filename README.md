# ShareOpen × Codex CLI 连接器（P2，本地 sidecar）

> 状态：P2（2026-09-29）。本地 CLI agent。协议见 `sdk/PROTOCOL.md`。

Codex CLI（OpenAI）跑在**用户机器上**，ShareOpen 云端触不到——P2 是
**本地 WS sidecar**：

```
ShareOpen  ←—WS—→  sidecar（用户机器）  ←—headless—→  codex exec
```

- **入站（用户 → codex）**：用户消息经 WS 到 sidecar，sidecar spawn
  `codex exec <prompt>`（可选 `--json` 结构化输出），把结果推回
  ShareOpen 会话。
- **出站（codex → 用户）**：Codex 的 `notify`（agent-turn-complete，
  JSON 走 argv）+ 新 lifecycle hooks（UserPromptSubmit/Stop/
  PermissionRequest）把事件喂给 sidecar，sidecar 推进 ShareOpen。

## 用法

### 1) 纯 headless（默认，无需配 hook）
```bash
node connectors/codex/index.js serve \
  --agent-id <id> --token <so_live_...> --shareopen https://shareopen.com
```

### 2) notify hook（turn 完成通知）
`~/.codex/config.toml`（**顶层 key**，必须在任何 `[table]` 头之前）：
```toml
notify = ["/usr/bin/env", "node", "<path>/index.js", "hook",
  "--agent-id", "<id>", "--token", "<so_token>",
  "--event", "agent-turn-complete"]
```
注意：Codex notify 是 argv 数组直 exec（无 shell）——**没有变量展开、
没有 `~`、没有路径前缀**，必须绝对路径 + 可执行。

### 3) lifecycle hooks（更丰富事件，v0.114+ `codex_hooks=true`）
`~/.codex/hooks.json`：
```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
  "command": "node <path>/index.js hook --agent-id <id> --token <so> --event agent-turn-complete",
  "timeout": 30 }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command",
  "command": "node <path>/index.js hook --agent-id <id> --token <so> --event permission-request",
  "timeout": 10 }] }] } }
```
hooks JSON 走 **stdin**（与 notify 的 argv 方式不同）。

## 边界 / 已知限制
- **approval-requested 无外部 hook**（v0.120，open issue #11808）：
  审批阻塞只能在终端确认，sidecar 只能以文本提示（`permission-request`
  hook 降级为"终端内确认"通知），不做 ShareOpen 内审批闭环。
- `codex exec --json` 输出 JSONL：sidecar 取最后一条 `turn_complete`
  事件作为答案；普通模式直接取 stdout。
- 超时 5min 强杀；断连期间用户消息由后端 agentMessageQueue 补发。
- 内部 agent 链路零改动：纯本地代码 + 复用现有 `/ws/agent`。
