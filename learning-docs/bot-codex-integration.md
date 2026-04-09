# Bot 与 Codex CLI 的集成机制

本文档描述 bot 如何与 OpenAI Codex CLI（编码 agent）集成，包括进程管理、通信协议、审批流程、以及 codex 端的处理机制。

---

## 一、整体架构

```
用户（飞书/Telegram）
    │ "帮我重构 auth 模块"
    ▼
Bot（LLM agent，模型 glm-5-turbo）
    │ 决定委托编码任务
    │ tool_call: codex(action="ask", prompt="重构auth模块", cwd="/project")
    ▼
codex tool（tools/codex.ts）
    │ 调用 CodexClient 方法
    ▼
CodexClient（codex-client.ts）
    │ JSON-RPC over stdin/stdout
    ▼
codex app-server（OpenAI Codex CLI 子进程）
    │ 内部运行 OpenAI 模型（如 o3）
    │ 读文件、改代码、跑命令
    │ 需要审批时发 requestApproval
    ▲
    │ 审批结果
CodexClient → codex tool → Bot LLM → 决策 → codex tool → CodexClient
```

关键点：**Bot 的 LLM 是决策者**，codex 是执行者。codex 做编码工作，但每次要执行命令或改文件前必须向 bot 请求批准。

---

## 二、进程生命周期

### 启动

**文件**：`main.ts:122-136` → `codex-client.ts:111-160`

```
1. main.ts 读取 config.json 的 codex 配置
   { enabled: true, model: "o3", sandbox: "workspace-write" }

2. new CodexClient({ cwd, model, sandbox })

3. codexClient.start():
   a. spawn("codex", ["app-server", "--listen", "stdio://"])
      - stdio: [pipe, pipe, pipe]（stdin/stdout/stderr 全管道）
      - env: 继承当前进程环境变量
      - cwd: 配置的工作目录

   b. 建立消息读取器
      - stdout → readline → handleLine()（逐行解析 JSON）
      - stderr → 打印到控制台（诊断日志）

   c. 初始化握手（类 MCP/LSP 协议）
      → 发送: { id: 1, method: "initialize", params: { clientInfo: { name: "pi-bot" }, capabilities: {...} } }
      ← 接收: { id: 1, result: { userAgent: "pi-bot/0.116.0 ..." } }
      → 发送: { method: "initialized" }（通知，无 id）

4. codexClient 传给 AgentRunner → createBotTools → 创建 codex tool
```

### 关闭

```
1. codexClient.stop():
   a. 拒绝所有待处理的 RPC 请求
   b. 解决正在等待的 turn（标记为 failed）
   c. 关闭 stdin
   d. 发 SIGTERM
   e. 5 秒超时后 SIGKILL
```

---

## 三、通信协议

### 传输层

**行分隔 JSON over stdio**。每条消息是一行 JSON，以 `\n` 结尾。不是标准 JSON-RPC 2.0（没有 `jsonrpc: "2.0"` 字段），但消息结构类似。

### 三种消息类型

| 类型 | 方向 | 特征 | 用途 |
|---|---|---|---|
| **Client Request** | bot → codex | 有 `id` + `method` + `params` | 发起操作（initialize、thread/start、turn/start 等） |
| **Server Request** | codex → bot | 有 `id` + `method` + `params` | 需要 bot 回复（审批请求、用户输入等） |
| **Notification** | codex → bot | 有 `method` + `params`，无 `id` | 状态更新（文本增量、命令输出、turn 完成等） |

### Client Request 的请求-响应配对

```
bot:   { id: 5, method: "turn/start", params: { threadId: "t1", input: [...] } }
codex: { id: 5, result: { turn: { id: "turn-abc" } } }
```

CodexClient 用递增的数字 ID 追踪 pending 请求，收到响应后通过 `pendingRpc` Map 匹配并 resolve Promise。

### Server Request 的请求-响应配对

```
codex: { id: "req-1", method: "item/commandExecution/requestApproval", params: { command: "npm test", ... } }
   ... bot LLM 决策 ...
bot:   { id: "req-1", result: { decision: "accept" } }
```

必须用相同的 `id` 回复。CodexClient 将 server request 转化为 `PendingServerRequest` 对象暴露给 tool，tool 返回给 LLM，LLM 决策后通过 `respondToServerRequest()` 回复。

---

## 四、线程和轮次模型

### Thread（线程）

每个 `{channelType}:{chatId}:{cwd}` 组合对应一个独立的 codex 线程：

```
codex tool 调用 ensureThread(cwd="/home/user/myapp")
  → conversationKey = "feishu:chat123:/home/user/myapp"
  → 查找缓存的 threadId
  → 没有？→ codexClient.startThread(conversationKey, cwd)
    → 发送 thread/start:
      {
        model: "o3",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        cwd: "/home/user/myapp",
        ephemeral: true
      }
    ← 接收 { thread: { id: "thread-xyz" } }
    → 缓存 threadId
```

**项目隔离**：不同 `cwd` 创建不同线程。用户说"看一下 projectA"和"看一下 projectB"会是两个独立的 codex 会话。

### Turn（轮次）

一个 turn 是 codex 处理一个用户请求的完整过程。每个 thread 同一时间只有一个活跃 turn。

```
Turn 生命周期：
  turn/start → [codex 工作中...] → turn/completed
                    │
                    ├─ 可能发多个 notification（文本增量、命令输出...）
                    └─ 可能发 server request（需要审批）
                         → turn 暂停
                         ← bot 回复审批
                         → turn 继续
                         └─ 可能再次需要审批...
```

---

## 五、消息流详解

### 5.1 发送编码任务（action=ask）

```
[Bot LLM] → tool_call: codex(action="ask", prompt="Add input validation", cwd="/myapp")

[codex tool]
  → ensureThread("/myapp") → threadId
  → codexClient.sendTurn(threadId, "Add input validation")

[CodexClient]
  → 重置 TurnState（清空 text、items、pendingRequests 等）
  → 发送 JSON:
    { id: 3, method: "turn/start", params: {
        threadId: "thread-xyz",
        input: [{ type: "text", text: "Add input validation" }],
        approvalsReviewer: "user"
    }}
  ← 响应: { id: 3, result: { turn: { id: "turn-abc" } } }
  → 进入 awaitTurnResolution()（等待 turn 完成或审批请求）
```

### 5.2 Codex 工作中（通知流）

Codex 开始处理任务后，通过 stdout 持续推送通知：

```
← { method: "turn/started", params: { turn: { id: "turn-abc" } } }
← { method: "item/started", params: { item: { type: "message", id: "msg-1" } } }
← { method: "item/agentMessage/delta", params: { delta: "I'll add input " } }
← { method: "item/agentMessage/delta", params: { delta: "validation to the form." } }
← { method: "item/completed", params: { item: { type: "message", id: "msg-1" } } }
← { method: "item/started", params: { item: { type: "command", id: "cmd-1" } } }
```

CodexClient 的 `handleNotification()` 处理每种通知：

| 通知方法 | 处理 |
|---|---|
| `item/agentMessage/delta` | 追加到 `turnState.text`（codex 的文本输出） |
| `item/commandExecution/outputDelta` | 追加到 `turnState.commandOutputs[itemId]` |
| `item/fileChange/outputDelta` | 追加到 `turnState.fileChanges` |
| `turn/plan/updated` | 更新 `turnState.planSteps` |
| `turn/diff/updated` | 追加到 `turnState.items` |
| `item/started/completed` | 追加到 `turnState.items`（活动记录） |
| `error` | 记录错误，检查 `willRetry` 标志 |
| `turn/completed` | 设置最终状态，resolve 等待中的 Promise |
| 其他 30+ 种 | 显式忽略（线程生命周期、音频、文件搜索等） |

### 5.3 审批请求

当 codex 需要执行命令或改文件时：

```
← { id: "req-1", method: "item/commandExecution/requestApproval", params: {
     command: "npm test",
     cwd: "/myapp",
     availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
   }}
```

CodexClient 处理（`handleServerRequest`）：

```
1. 识别为 server request（有 id + method）
2. buildPendingServerRequest() 构建人类可读的描述：
   {
     id: "req-1",
     type: "commandExecution",
     detail: "Command: npm test (in /myapp)",
     availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
     params: { ... }
   }
3. 加入 turnState.pendingServerRequests
4. 如果有正在等待的 resolve → 立即 resolve 为 "waiting_approval"
```

awaitTurnResolution() 返回 TurnResult：

```
{
  status: "waiting_approval",
  text: "I'll add input validation to the form.",
  pendingServerRequests: [{ id: "req-1", type: "commandExecution", detail: "Command: npm test", ... }],
  items: ["[started] message (msg-1)", "[completed] message (msg-1)", "[started] command (cmd-1)"]
}
```

### 5.4 Bot LLM 审批

codex tool 将 TurnResult 格式化为文本返回给 LLM：

```
[Codex] Status: waiting_approval

Output:
I'll add input validation to the form.

Pending requests:
  [commandExecution] (id: req-1): Command: npm test [decisions: accept, acceptForSession, decline, cancel]

Use action="respond" with requestId and response to approve/decline each.
```

Bot LLM 看到这个 tool_result，决定批准：

```
[Bot LLM] → tool_call: codex(action="respond", requestId="req-1", response={decision: "accept"})
```

### 5.5 发送审批回复

```
[codex tool]
  → codexClient.respondToServerRequest("req-1", { decision: "accept" })

[CodexClient]
  → 写 JSON: { id: "req-1", result: { decision: "accept" } }
  → 从 pendingServerRequests 中移除该请求

[codex tool]
  → codexClient.continueTurn()

[CodexClient]
  → 再次进入 awaitTurnResolution()
  → 等待下一个事件（更多审批、或 turn 完成）
```

### 5.6 Turn 完成

```
← { method: "turn/completed", params: { turn: { status: "completed" } } }

[CodexClient]
  → turnState.status = "completed"
  → 清除 activeThreadTurns
  → resolve 等待中的 Promise

[codex tool]
  → 收到最终 TurnResult { status: "completed", text: "...", items: [...] }
  → formatTurnResult() 格式化为文本
  → 返回给 Bot LLM
```

---

## 六、完整审批循环示例

```
                Bot LLM                    CodexClient                codex app-server
                   │                           │                           │
                   │ codex(ask, "add tests")   │                           │
                   ├──────────────────────────►│ turn/start                │
                   │                           ├──────────────────────────►│
                   │                           │         turn/started      │
                   │                           │◄─────────────── (notif)───│
                   │                           │    agentMessage/delta     │
                   │                           │◄─────────────── (notif)───│
                   │                           │    requestApproval(npm test)
                   │                           │◄──────────── (request)────│
                   │ waiting_approval          │                           │
                   │◄──────────────────────────│                           │
                   │                           │                           │
                   │ "看起来安全，批准"          │                           │
                   │ codex(respond, id=1,      │                           │
                   │   {decision:"accept"})    │                           │
                   ├──────────────────────────►│ { id:1, result:{...} }    │
                   │                           ├──────────────────────────►│
                   │                           │  commandExecution/output  │
                   │                           │◄─────────────── (notif)───│
                   │                           │  requestApproval(edit file)
                   │                           │◄──────────── (request)────│
                   │ waiting_approval          │                           │
                   │◄──────────────────────────│                           │
                   │                           │                           │
                   │ codex(respond, id=2,      │                           │
                   │   {decision:"accept"})    │                           │
                   ├──────────────────────────►│ { id:2, result:{...} }    │
                   │                           ├──────────────────────────►│
                   │                           │    agentMessage/delta     │
                   │                           │◄─────────────── (notif)───│
                   │                           │    turn/completed         │
                   │                           │◄─────────────── (notif)───│
                   │ completed                 │                           │
                   │◄──────────────────────────│                           │
                   │                           │                           │
                   │ "已完成，添加了3个测试"     │                           │
                   ▼                           │                           │
```

---

## 七、Server Request 类型详解

| 方法 | 类型 | 触发场景 | 响应格式 |
|---|---|---|---|
| `item/commandExecution/requestApproval` | commandExecution | codex 要跑命令 | `{ decision: "accept"\|"acceptForSession"\|"decline"\|"cancel" }` |
| `item/fileChange/requestApproval` | fileChange | codex 要改文件 | 同上 |
| `item/permissions/requestApproval` | permissions | codex 需要额外权限 | `{ permissions: {...}, scope: "turn"\|"session" }` |
| `item/tool/requestUserInput` | userInput | codex 向用户提问 | `{ answers: { questionId: "answer", ... } }` |
| `mcpServer/elicitation/request` | mcpElicitation | MCP 服务器需要输入 | `{ decision: "accept"\|"decline"\|"cancel" }` |
| `item/tool/call` | toolCall | codex 要求客户端执行工具 | **自动拒绝**（bot 不支持） |

### Decision 选项含义

| Decision | 含义 |
|---|---|
| `accept` | 批准这一次 |
| `acceptForSession` | 批准这一次，且本次 turn 中类似操作自动批准 |
| `decline` | 拒绝这一次，codex 会尝试其他方式 |
| `cancel` | 取消整个 turn |

---

## 八、Codex 端的处理机制

### Codex App-Server 是什么

`codex app-server` 是 OpenAI Codex CLI 的一种运行模式。通常 Codex CLI 直接在终端交互；`app-server` 模式将其封装为一个 JSON-RPC 服务，通过 stdio 管道接受外部程序控制。

### Codex 内部工作流

```
codex app-server 启动
    │
    ▼ 等待 initialize 握手
    │
    ▼ 收到 thread/start → 创建会话线程（独立的工作目录和沙箱）
    │
    ▼ 收到 turn/start → 将用户 prompt 发给 OpenAI 模型（如 o3）
    │
    ▼ 模型返回：
    │   ├─ 文本回复 → 推送 agentMessage/delta 通知
    │   ├─ 工具调用（读文件、写文件、执行命令）→
    │   │   ├─ sandbox 检查
    │   │   ├─ approvalPolicy == "on-request"？
    │   │   │   ├─ 是 → 发 requestApproval 给客户端，暂停等待回复
    │   │   │   └─ 否（"never"）→ 直接执行
    │   │   ├─ 执行命令 → 推送 commandExecution/outputDelta
    │   │   └─ 修改文件 → 推送 fileChange/outputDelta
    │   └─ 继续下一轮推理...
    │
    ▼ 模型认为任务完成 → 推送 turn/completed
```

### Sandbox 模式

| 模式 | 含义 |
|---|---|
| `read-only` | 只能读文件和看目录，不能写文件或执行命令 |
| `workspace-write` | 可以读写工作目录内的文件，执行命令受审批控制 |
| `danger-full-access` | 完全访问，无沙箱限制 |

Bot 默认使用 `workspace-write`，配合 `approvalPolicy: "on-request"` 确保每个命令和文件修改都经过 bot LLM 审核。

### Codex 使用的模型

Codex app-server 内部调用 OpenAI 的 API（如 o3 模型）。这和 bot 自身的模型（如 glm-5-turbo）完全独立。也就是说：

- Bot LLM（glm-5-turbo）负责理解用户意图、决定是否委托给 codex、审批 codex 的操作
- Codex LLM（o3）负责实际的编码推理和工具调用规划

两个模型各司其职，Bot LLM 是"项目经理"，Codex LLM 是"程序员"。

---

## 九、TurnState 状态聚合

CodexClient 在内存中维护一个 `TurnState` 对象，聚合一个 turn 生命周期内的所有通知：

```typescript
interface TurnState {
    threadId: string;
    turnId?: string;
    text: string;                           // agentMessage/delta 累积
    commandOutputs: Map<string, string>;    // 按 itemId 分组的命令输出
    fileChanges: string[];                  // 文件变更增量
    planSteps: string[];                    // 计划步骤状态
    items: string[];                        // 活动记录（started/completed）
    pendingServerRequests: PendingServerRequest[];  // 待审批请求
    status: "running" | "completed" | "interrupted" | "failed";
    error?: string;
    resolve?: (result: TurnResult) => void; // Promise 回调
}
```

当 turn 完成或需要审批时，`buildTurnResult()` 将 TurnState 转化为 `TurnResult` 返回给 codex tool。

---

## 十、代码文件索引

| 文件 | 职责 |
|---|---|
| `packages/bot/src/codex-client.ts` | 进程管理、JSON-RPC 协议、通知聚合、审批路由 |
| `packages/bot/src/tools/codex.ts` | AgentTool 定义：参数 schema、action 路由、结果格式化 |
| `packages/bot/src/tools/index.ts` | 条件性注册 codex tool（`if (codexClient) tools.push(...)`) |
| `packages/bot/src/system-prompt.ts` | 条件性描述（`if codexEnabled → "### Delegation"` 节） |
| `packages/bot/src/config.ts` | `CodexConfig` 接口定义 |
| `packages/bot/config.json` | 运行时配置（enabled、model、sandbox） |
| `packages/bot/src/main.ts` | 启动 CodexClient、传给 AgentRunner |
| `packages/bot/src/agent-runner.ts` | 将 codexClient 传入 createBotTools |
| `packages/bot/skills/codex/SKILL.md` | Codex 使用指南 skill（按需加载） |

---

## 十一、配置

`config.json` 中的 codex 配置：

```json
{
    "codex": {
        "enabled": true,
        "model": "o3",
        "sandbox": "workspace-write",
        "cwd": "/optional/default/project/dir"
    }
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | false | 是否启动 codex app-server |
| `model` | 无（codex 默认） | 传给 codex 的模型名 |
| `sandbox` | "workspace-write" | 沙箱模式 |
| `cwd` | process.cwd() | 默认工作目录 |

`approvalPolicy` 硬编码为 `"on-request"`（每次操作都需审批）。
