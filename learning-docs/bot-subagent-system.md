# Bot Sub-Agent 系统设计

本文档描述 `packages/bot` 的子代理（sub-agent）系统，包括类型注册、同步/异步执行、通知回传和反思自迭代机制。

---

## 一、整体架构

Sub-agent 系统允许主 agent 将任务委托给独立的子代理执行。子代理有自己的系统提示词、工具集和上下文，执行完后将结果返回给主 agent。

```
主 Agent (processMessage)
    │
    ├─ 同步调用 ─→ runSubAgent() ─→ 结果直接返回给 LLM
    │
    ├─ 异步调用 ─→ NotificationQueue.startAsync()
    │                  ├─ runSubAgent() (后台执行)
    │                  └─ 完成后 → onComplete → MessageBus → processMessage
    │
    └─ 反思调用 ─→ after_prompt hook → NotificationQueue.startAsync()
                       ├─ runSubAgent() (后台执行)
                       └─ 完成后 → message_received hook 拦截 (不送达 LLM)
```

**核心文件：**

| 文件 | 职责 |
|------|------|
| `sub-agent.ts` | 子代理执行引擎 |
| `agent-types.ts` | 类型注册表（定义可用的子代理种类） |
| `tools/agent.ts` | LLM 可调用的 `agent` 工具 |
| `notification-queue.ts` | 异步任务管理和完成通知 |
| `reflection-manager.ts` | 反思子代理（通过 hooks 注册） |
| `runner-factory.ts` | 组装和连接以上所有组件 |
| `hooks.ts` | 钩子系统，反思通过此系统集成 |

---

## 二、Agent 类型注册表

### AgentTypeDefinition

每种子代理由一个类型定义描述：

```typescript
interface AgentTypeDefinition {
    name: string;              // 唯一标识（如 "researcher"）
    description: string;       // 描述，展示给 LLM
    systemPrompt: string;      // 子代理的系统提示词
    allowedTools?: string[];   // 工具白名单（undefined = 全部，但总是排除 "agent"）
    modelOverride?: {          // 可选：使用不同的模型
        provider: string;
        model: string;
    };
    thinkingLevelOverride?: ThinkingLevel;  // 可选：思考级别
    maxTurns?: number;         // 最大轮次，默认 20
}
```

### 内置类型

`createDefaultAgentTypes()` 注册三种内置类型：

| 类型 | 工具 | 最大轮次 | 用途 |
|------|------|---------|------|
| `researcher` | web_search, memory_search, read, bash | 10 | 信息检索和研究 |
| `writer` | read, write, edit, bash | 15 | 文件创建和编辑 |
| `general` | 全部（除 agent） | 20 | 通用任务 |

### 用户自定义

通过 `config.json` 的 `agentTypes` 字段可覆盖或新增类型：

```json
{
    "agentTypes": {
        "researcher": {
            "maxTurns": 15
        },
        "translator": {
            "description": "翻译任务专家",
            "systemPrompt": "你是一个翻译专家...",
            "allowedTools": ["read", "write"],
            "maxTurns": 5
        }
    }
}
```

`mergeAgentTypeConfig()` 对已有类型做浅合并，对新类型要求至少提供 `description` 和 `systemPrompt`。

---

## 三、执行引擎（sub-agent.ts）

### runSubAgent()

核心执行函数，创建一个隔离的 Agent 实例完成任务：

```
runSubAgent(task, config)
    1. filterTools(toolPool, allowedTools)   ← 过滤工具，总是移除 "agent"
    2. new Agent({systemPrompt, model, tools})  ← 创建隔离 agent
    3. 注册 turn_end 监听器                    ← 追踪轮次，超过 maxTurns 则 abort
    4. 绑定 parentSignal                       ← 父级 abort 传播
    5. agent.prompt(task)                      ← 运行 agentic 循环
    6. extractFinalText(messages)              ← 提取最后一条 assistant 消息的文本
    7. 返回 SubAgentResult
```

### SubAgentResult

```typescript
interface SubAgentResult {
    success: boolean;
    text: string;              // 最终文本输出
    messages: AgentMessage[];  // 完整消息历史（调试用）
    error?: string;
    turnsUsed: number;
}
```

### 递归防护

`filterTools()` **总是**移除名为 `"agent"` 的工具，防止子代理无限递归地生成子子代理。

### Abort 传播

同步子代理接收 `parentSignal`，父级取消时子代理也立即终止。异步子代理不接收 `parentSignal`，独立运行直到完成。

---

## 四、LLM 工具接口（tools/agent.ts）

### 工具 Schema

```typescript
{
    label: string;              // 状态指示（如 "Researching API docs"）
    agent_type: string;         // 子代理类型名
    task: string;               // 详细任务描述
    run_in_background?: boolean; // true = 异步，false = 同步（默认）
}
```

### 执行流程

```typescript
createAgentTool(deps) → AgentTool {
    execute(toolCallId, params, signal) {
        // 1. 验证 agent_type 是否在注册表中
        if (!deps.agentTypeNames.includes(params.agent_type)) throw Error;

        // 2. 分发
        if (params.run_in_background) {
            const taskId = deps.runAsync(agentType, task, description);
            return { text: `Async agent started (task ${taskId})` };
        } else {
            const result = await deps.runSync(agentType, task, signal);
            if (result.success) return { text: result.text };
            else throw Error(result.error);
        }
    }
}
```

`runSync` 和 `runAsync` 的具体实现在 `runner-factory.ts` 的 `createRunnerEntry()` 中注入。

---

## 五、异步通知系统（notification-queue.ts）

### 核心机制

`NotificationQueue` 管理后台子代理任务，通过回调将完成通知注入消息处理管线。

```
NotificationQueue
    ├─ startAsync(agentType, description, runFn) → taskId
    │     ├─ 创建 AsyncTaskRecord {id, status: "running"}
    │     ├─ fire-and-forget: void runFn().then(...)
    │     └─ 立即返回 taskId
    │
    └─ [runFn 完成后]
          ├─ 更新 record.status = "completed" | "failed"
          └─ onComplete(channelType, chatId, formattedNotification)
                ↓
          MessageBus.enqueueMessage(...)  ← 作为合成消息重新进入 processMessage
```

### 通知格式

```
成功: [ASYNC-AGENT:async-1:researcher:completed] task description\n\nResult:\n<text>
失败: [ASYNC-AGENT:async-1:researcher:failed] task description\n\nError: <error>
```

这个格式被 `message_received` 钩子用正则匹配来拦截反思通知。

### 生命周期

```
                     startAsync()         runFn 完成
                         │                    │
AsyncTaskRecord:  [running] ──────────→ [completed/failed]
                         │                    │
消息流:            返回 taskId           onComplete → MessageBus
                  给 LLM 确认                     → processMessage
```

---

## 六、组装过程（runner-factory.ts）

`createRunnerEntry()` 是整个子代理系统的组装入口，解决了组件之间的循环依赖：

```
Step 1: createBotTools() + mcpTools            ← 基础工具（不含 agent 工具）
Step 2: new Agent({tools: 基础工具})            ← 创建主 agent
Step 3: new NotificationQueue(onComplete)       ← 创建通知队列
Step 4: createAgentTool({                       ← 创建 agent 工具
            runSync: (type, task, signal) => {
                agentType = registry.get(type)
                model = agentType.modelOverride ? resolveModel(...) : parentModel
                return runSubAgent(task, {agentType, toolPool, model,
                    streamFn: agent.streamFn,      ← 引用 Step 2 的 agent
                    getApiKey: agent.getApiKey,     ← 引用 Step 2 的 agent
                    parentSignal: signal})
            },
            runAsync: (type, task, desc) => {
                return notificationQueue.startAsync(type, desc,
                    () => runSubAgent(...))         ← 引用 Step 3 的队列
            }
        })
Step 5: tools.push(agentTool)                  ← 注入回 agent 的工具列表
        agent.state.tools = tools
Step 6: new ReflectionManager(...)              ← 可选：创建反思管理器
Step 7: return RunnerEntry                      ← 包含所有组件
```

**鸡生蛋问题**：agent 工具需要 `agent.streamFn` 和 `agent.getApiKey`，所以必须先创建 agent（Step 2），再创建 agent 工具（Step 4），最后注入回去（Step 5）。

---

## 七、反思子代理（自迭代系统）

反思是一种特殊的异步子代理，通过 Hook 系统集成，对用户完全不可见。

### 触发条件

```
                        ┌─ 每 10 次用户消息 → memory reflection
checkThresholds() ──────┤
                        └─ 每 10 次工具调用 → skill reflection
```

两个计数器独立运行，各有 running 标志防止同类型并发。

### 集成方式（registerReflectionHooks）

注册三个钩子，替代了原来硬编码在 agent-runner.ts 中的三处代码：

```typescript
// 钩子 1: 拦截反思完成通知
hooks.on("message_received", (event) => {
    // 匹配 [ASYNC-AGENT:...:reflector:(completed|failed)] 格式
    // 清除 running 标志，写入日志，设 event.handled = true
});

// 钩子 2: 计数工具调用
hooks.on("tool_execution_end", (event) => {
    event.runner.reflectionManager?.recordToolCall();
});

// 钩子 3: 检查阈值，触发反思
hooks.on("after_prompt", (event) => {
    rm.recordUserTurn();
    for (const type of rm.checkThresholds()) {
        const snapshot = buildMessageSnapshot(messages, snapshotSize);
        const prompt = type === "memory"
            ? rm.buildMemoryReflectionPrompt(snapshot)
            : rm.buildSkillReflectionPrompt(snapshot, []);
        // 创建临时 reflector 类型，通过 NotificationQueue 异步执行
        nq.startAsync("reflector", `${type} reflection`, () =>
            runSubAgent("Review and update...", config));
    }
});
```

### 反思 vs 普通异步子代理

| 特征 | 普通异步子代理 | 反思子代理 |
|------|-------------|-----------|
| 触发方式 | LLM 调用 agent 工具 | after_prompt hook 自动触发 |
| 类型注册 | 在 AgentTypeRegistry 中 | 临时构造，不在注册表中 |
| 通知处理 | 送达 LLM 作为新消息 | message_received hook 拦截，不送达 LLM |
| 用户可见性 | 用户可见（LLM 回复通知） | 完全不可见 |
| 并发控制 | 无限制 | running 标志防止同类型并发 |
| 工具权限 | 由类型定义的 allowedTools | 固定为 read, write, edit, bash, memory_search |

### 两种反思类型

**Memory Reflection（记忆反思）**
- 触发：每 10 次用户消息
- 任务：审查对话，更新 MEMORY.md（<=2200 字符）、USER.md（<=1375 字符）、daily log
- 提示词：`buildMemoryReflectionPrompt(snapshot)` 构造

**Skill Reflection（技能反思）**
- 触发：每 10 次工具调用
- 任务：识别可复用的多步骤工作流，创建/更新 `skills/<name>/SKILL.md`
- 提示词：`buildSkillReflectionPrompt(snapshot, existingSkills)` 构造

---

## 八、数据流总览

### 同步路径

```
用户消息 → processMessage → LLM 回复包含 agent 工具调用
    → createAgentTool.execute()
        → runSync(agentType, task, signal)
            → resolveModel (可能用不同模型)
            → runSubAgent(task, config)
                → 创建隔离 Agent
                → agent.prompt(task) — 完整 agentic 循环
                → 返回 SubAgentResult
        → 结果作为工具返回值送回 LLM
    → LLM 基于结果继续回复
```

### 异步路径

```
用户消息 → processMessage → LLM 回复包含 agent 工具调用 (run_in_background=true)
    → createAgentTool.execute()
        → runAsync(agentType, task, description)
            → NotificationQueue.startAsync()
                → 立即返回 taskId
        → "Async agent started" 作为工具返回值送回 LLM
    → LLM 回复用户 "已启动后台任务"

    [后台执行中...]

    → runSubAgent 完成
    → NotificationQueue.onComplete
        → MessageBus.enqueueMessage (合成消息)
            → processMessage (新的消息处理循环)
                → message_received hook (无拦截)
                → LLM 接收通知，回复用户结果
```

### 反思路径

```
用户消息 → processMessage → LLM 回复 → after_prompt hook 触发
    → reflectionManager.recordUserTurn()
    → checkThresholds() → ["memory"]
    → buildMessageSnapshot() → 构造反思提示词
    → NotificationQueue.startAsync("reflector", ...)
        → runSubAgent("Review conversation and update memory...")

    [后台执行：更新 MEMORY.md, USER.md, daily log]

    → runSubAgent 完成
    → NotificationQueue.onComplete
        → MessageBus.enqueueMessage
            → processMessage
                → message_received hook
                    → 正则匹配 [ASYNC-AGENT:...:reflector:completed]
                    → clearReflectionFlag("memory")
                    → appendDailyLog(<!-- REFLECTION memory completed ... -->)
                    → event.handled = true  ← 消息被吞掉，LLM 和用户都不知道
```

---

## 九、关键设计决策

1. **递归防护**：`filterTools()` 总是移除 `"agent"` 工具，子代理无法生成子子代理。

2. **鸡生蛋解决**：先创建 Agent，再创建 agent 工具（因为需要 `agent.streamFn`），最后注入回 agent 的工具列表。

3. **通知通过 MessageBus**：异步完成通知作为合成消息注入消息管线，复用已有的消息序列化处理（每个对话串行执行，避免并发问题）。

4. **反思对用户不可见**：反思通知被 `message_received` hook 的 `handled = true` 机制拦截，永远不会到达 LLM 或用户。

5. **Hook 可插拔**：反思从硬编码改为 `registerReflectionHooks()` 钩子注册，可以被替换、禁用或扩展，无需修改核心代码。

6. **Model Override**：每种子代理类型可以指定不同的模型，在执行时通过 `resolveModel()` 解析，允许低成本模型处理简单任务。
