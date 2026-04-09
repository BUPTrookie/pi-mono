# Bot 上下文管理与压缩机制

本文档描述 `packages/bot` 的完整上下文管理体系，包括持久化记忆系统和六级压缩流水线。

---

## 一、整体架构

Bot 的上下文管理分为两个维度：

- **记忆系统**：持久化存储，跨会话保留信息，通过系统提示词和搜索工具访问
- **压缩系统**：运行时上下文管理，在对话过程中渐进式缩减 token 占用

```
┌──────────────────────────────────────────────────────────────┐
│                     持久化记忆（磁盘）                         │
│                                                              │
│  全局 MEMORY.md ← 跨对话共享                                  │
│  对话 MEMORY.md ← 单对话持久                                  │
│  日志 memory/YYYY-MM-DD.md ← 每天一个文件                     │
│                                                              │
│  注入 → 系统提示词尾部（近因效应）                              │
│  搜索 → memory_search 工具（BM25）                            │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                  运行时压缩（六级流水线）                       │
│                                                              │
│  Level 0: 聚合预算      ← 每次                               │
│  Level 1: Microcompact  ← 60% context window                 │
│  Level 2: Snip          ← 70%                                │
│  Level 3: Collapse      ← 80%                                │
│  Level 4: AutoCompact   ← ~90%（AgentSession）               │
│  Level 5: Emergency     ← 95%                                │
│                                                              │
│  越轻越先用，每步后重新估算，够了就停                           │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、记忆系统

### 2.1 存储层

三层存储，按作用域从大到小：

| 层 | 路径 | 写入方 | 内容 |
|---|---|---|---|
| 全局记忆 | `{dataDir}/{channelType}/MEMORY.md` | LLM 用 write/edit 工具 | 用户偏好、关键决策、联系人等跨对话信息 |
| 对话记忆 | `{dataDir}/{channelType}/{chatId}/MEMORY.md` | LLM 用 write/edit 工具 | 单对话的持久信息 |
| 每日日志 | `{dataDir}/{channelType}/{chatId}/memory/YYYY-MM-DD.md` | LLM 手动 + flushContext 自动 | 会话笔记、中间结果、自动备份 |

目录结构：

```
{dataDir}/{channelType}/{chatId}/
├── MEMORY.md          # 对话级持久记忆
├── memory/            # 每日日志目录
│   ├── 2026-04-08.md
│   └── 2026-04-09.md
├── attachments/       # 下载的文件
├── scratch/           # 工作区
└── context.jsonl      # SessionManager 持久化数据

{dataDir}/{channelType}/
└── MEMORY.md          # 全局记忆（跨对话共享）
```

### 2.2 注入系统提示词

每条消息进来时（`processMessage`），bot 重新读取记忆并注入系统提示词：

```
系统提示词
├── ... 身份、行为、工具说明等 ...
├── ### Current Memory
│   ├── ### Global Memory     ← 全局 MEMORY.md 全文
│   ├── ### Conversation Memory  ← 对话 MEMORY.md 全文
│   └── ### Today's Log       ← 当天日志尾部 2KB（DAILY_LOG_CAP）
└── ... Skills ...
```

将记忆放在提示词尾部是为了利用 transformer 的**近因效应**——模型对末尾内容的注意力更集中。

当天日志超过 2KB 时只取尾部，用 `...` 前缀标记截断，确保最新内容优先可见。

### 2.3 搜索

`memory_search` 工具实现了完整的 BM25 搜索：

**搜索范围**：全局 MEMORY.md + 对话 MEMORY.md + 所有日志文件（不只是今天的）

**分词策略**：
- 英文/拉丁文：小写化 + 按空格/标点分词
- 中日韩文（CJK）：字符 bigram + 单字符，提高中文搜索召回率

**流程**：
1. 收集所有记忆文件
2. 按 markdown heading / 空行分块（200-500 字符/块）
3. BM25 评分（k1=1.2, b=0.75）
4. 返回 top-N 结果，附带来源文件和得分

**系统提示词强制**：`MUST use memory_search before claiming you don't know about something the user may have told you previously.`

### 2.4 自动备份（flushContext）

位于 `memory-manager.ts`。在每条消息处理前检查：

```
if 估算 token 数 > context window × 70%:
    取最近 10 条 user/assistant 消息（每条截取 500 字符）
    追加到当天日志，标记 <!-- AUTO-FLUSH timestamp -->
```

这是压缩前的安全网——在 AgentSession 的全量压缩摧毁旧消息之前，把关键对话片段持久化到日志文件。这些内容后续可通过 `memory_search` 找回。

---

## 三、压缩系统（六级流水线）

### 3.1 设计原则

参考 Claude Code 的七级压缩流水线，适配 IM bot 场景：

1. **越轻的手段越先用**：聚合预算 → 清空内容 → 移除轮次 → 折叠摘要 → 全量摘要 → 紧急截断
2. **每步后重新估算**：如果前一步已经降到阈值以下，后续步骤不执行
3. **工具结果是压缩主战场**：六级中有三级（Level 0/1/5）专门针对工具结果，因为它们占据 token 的绝大部分
4. **不破坏消息结构**：所有压缩操作保证 user/assistant/toolResult 的配对完整性

### 3.2 插入点

压缩系统通过两个架构钩子接入：

| 钩子 | 位置 | 执行时机 | 负责的层级 |
|---|---|---|---|
| `transformContext` | `agent-loop.ts` | 每轮 LLM 调用前 | Level 0-3, 5 |
| `_checkCompaction` | `agent-session.ts` | agent 结束后 | Level 4 |

`transformContext` 是 `Agent` 构造时传入的函数，在 `streamAssistantResponse()` 中调用——恰好在 `convertToLlm`（消息类型转换）之前。这是唯一能在不修改 `packages/agent` 代码的情况下实现渐进式上下文管理的地方。

### 3.3 Level 0：工具结果聚合预算

**文件**：`context-manager/tool-result-budget.ts`

**问题**：模型在一轮中并行调 5 个 bash，每个结果 50KB，一条消息里就有 250KB 的工具结果。

**解法**：

**单结果上限**（各工具不同）：

| 工具 | 上限 |
|---|---|
| bash | 30,000 字符 |
| read | 无限（避免 read→file→read 循环） |
| web_search | 30,000 字符 |
| edit / write | 50,000 字符 |
| agent | 50,000 字符 |
| memory_search | 30,000 字符 |
| 其他 | 50,000 字符（默认） |

**单消息聚合预算**：一条消息内所有工具结果总量不超过 **150,000 字符**。超出时，从最大的结果开始截断，保留前 2000 字符作为预览。

**触发时机**：每次 transformContext 调用（即每轮 LLM 调用前），对所有消息检查。

### 3.4 Level 1：Microcompact

**文件**：`context-manager/microcompact.ts`

**触发阈值**：上下文 token 数 > context window × 60%

**做什么**：

```
从后向前扫描所有 toolResult 消息
├── 属于 COMPACTABLE_TOOLS（bash, read, write, edit, web_search, memory_search）？
│   ├── 是最近 5 条之一？→ 保留完整内容
│   └── 不是？→ 替换 content 为 "[Old tool result content cleared]"
└── 不属于（如 agent, codex）？→ 不动
```

**关键设计**：
- 保留消息结构——模型仍然知道"我读过 src/main.ts"、"我执行了 npm test"，只是看不到具体输出了
- 如果需要旧结果的内容，模型可以重新调用工具获取
- 返回新数组，不修改原消息（transformContext 的约定）

### 3.5 Level 2：Snip

**文件**：`context-manager/snip.ts`

**触发阈值**：上下文 token 数 > context window × 70%

**做什么**：

将消息解析为"轮次"（用户消息 + 助手回复 + 工具结果），然后：

```
for 每个轮次（除了最近 5 个）:
    if 该轮次的所有 toolResult 都已被 microcompact 清除:
        标记为可 snip

将所有连续的可 snip 轮次替换为一条占位消息:
"[Removed N old conversation turn(s), ~XK tokens]"
```

**为什么需要 snip**：microcompact 只清空了工具结果的内容，但 user message 和 assistant response 仍占空间。如果一个轮次的工具结果全被清了，说明这个轮次的价值很低，整个移除更有效。

### 3.6 Level 3：Context Collapse

**文件**：`context-manager/collapse.ts`

**触发阈值**：上下文 token 数 > context window × 80%

**做什么**：

```
将消息按用户消息分段
├── 最近 5 段 → 保留完整
└── 更老的段 → 用 LLM 生成摘要，替换为 <collapsed>摘要</collapsed>
```

**LLM 摘要调用**：
- 使用 `streamSimple` 直接调 LLM（非交互式）
- 系统提示要求保留：用户意图、执行的动作、关键结果、遇到的错误
- 匹配用户语言（中文对话生成中文摘要）
- 单段摘要限制 500 tokens

**缓存**：已生成的摘要存在内存 Map 中（以消息内容 hash 为 key），后续轮次复用不重新调 LLM。这避免了每轮调用 N 次 LLM 的开销。

**与 AutoCompact 的协作**：collapse 在 autocompact 之前运行。如果 collapse 成功将上下文降到 ~90% 以下，AgentSession 的 autocompact 不触发。这保留了比全量摘要更细粒度的上下文。

### 3.7 Level 4：AutoCompact（已有）

**文件**：`packages/coding-agent/src/core/compaction/compaction.ts`（继承自 AgentSession）

**触发条件**：
- **阈值触发**：`contextTokens > contextWindow - 16384`（约 92% for 200K window）
- **溢出触发**：LLM 返回上下文溢出错误

**做什么**：
1. 从最新消息往回保留约 20,000 tokens 的消息不动
2. 将更老的消息序列化并发给 LLM 做结构化摘要
3. 如果有上次的摘要，做增量更新（不从头总结）
4. 用摘要消息替换被压缩的旧消息
5. 跟踪文件操作记录（读/写了哪些文件）

**摘要格式**：结构化的多段摘要，包含目标/约束/进度/关键决策/下一步等。

**保护机制**：
- 连续失败后有熔断器
- 溢出恢复每次 prompt 只尝试一次

### 3.8 Level 5：Emergency Truncate

**文件**：`context-manager/reactive-compact.ts`

**触发阈值**：上下文 token 数 > context window × 95%

**做什么**：当所有前面的层级都不够用时，激进截断：

```
Step 1: 清空所有旧 toolResult 内容（只保留最近 2 条）
Step 2: 只保留最近 3 条用户消息及其回复
Step 3: 截断所有剩余的长文本到 2000 字符
```

这是最后防线，会丢失大量上下文但保证系统不崩溃。

---

## 四、完整流程示例

假设用户和 bot 聊了 30 轮，读了 20 个文件，跑了 15 次命令。模型 context window 为 128K tokens。

```
原始上下文：~100K tokens（78%）

→ Level 0 聚合预算：某条消息有 4 个 bash 结果共 160K 字符 → 截断最大的
  → ~95K tokens（74%）

→ Level 1 Microcompact：> 60% 触发
  → 清空 15 条旧的 read/bash/web_search 结果，保留最近 5 条
  → ~55K tokens（43%）

→ < 70% 阈值，Level 2-3 不触发

→ 送入 LLM API，正常回复
```

另一个更极端的场景：

```
原始上下文：~120K tokens（94%）

→ Level 0 聚合预算：~118K tokens
→ Level 1 Microcompact：~80K tokens（62%）
→ Level 2 Snip：> 70% 不触发
→ 送入 LLM API

--- 用户继续聊了几轮 ---

原始上下文：~115K tokens（90%）

→ Level 1 Microcompact：~85K tokens（66%）
→ 不够，> 70%？不是 → 停
→ 送入 LLM API

--- 继续 ---

原始上下文：~125K tokens（98%）

→ Level 1 Microcompact：~95K tokens（74%）
→ Level 2 Snip：移除 8 个已清空的旧轮次 → ~70K tokens（55%）
→ 停

--- 如果 snip 不够 ---

→ Level 3 Collapse：折叠 5 个旧段落为摘要 → ~50K tokens（39%）
→ 停

--- 极端情况 ---

→ Level 4 AutoCompact：AgentSession 全量摘要 → ~30K tokens
→ 继续对话
```

---

## 五、代码文件索引

### 记忆系统

| 文件 | 职责 |
|---|---|
| `packages/bot/src/memory-manager.ts` | MemoryManager：记忆读写、搜索（BM25）、flushContext |
| `packages/bot/src/tools/memory-search.ts` | memory_search 工具定义 |
| `packages/bot/src/session-store.ts` | SessionStore：目录管理、getMemory() |
| `packages/bot/src/system-prompt.ts` | 系统提示词构建（含记忆注入） |

### 压缩系统

| 文件 | 层级 | 职责 |
|---|---|---|
| `packages/bot/src/context-manager.ts` | 编排 | createTransformContext()：组合所有层级 |
| `packages/bot/src/context-manager/types.ts` | 共享 | 常量、阈值、token 估算 |
| `packages/bot/src/context-manager/tool-result-budget.ts` | Level 0 | 单结果限流 + 聚合预算 |
| `packages/bot/src/context-manager/microcompact.ts` | Level 1 | 清空旧工具结果 |
| `packages/bot/src/context-manager/snip.ts` | Level 2 | 移除已清空轮次 |
| `packages/bot/src/context-manager/collapse.ts` | Level 3 | LLM 摘要折叠 |
| `packages/bot/src/context-manager/reactive-compact.ts` | Level 5 | 紧急截断 |
| `packages/coding-agent/src/core/compaction/compaction.ts` | Level 4 | AgentSession 全量压缩（继承） |
| `packages/bot/src/agent-runner.ts` | 接入 | 创建并注入 transformContext |

### 关键接口

```typescript
// transformContext 签名（传给 Agent 构造函数）
transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>

// 在 agent-loop.ts 中的调用位置（每轮 LLM 调用前）
// streamAssistantResponse() → config.transformContext(messages) → config.convertToLlm(messages) → LLM API

// AgentSession 的压缩检查位置
// agent_end 事件 → _checkCompaction() → compact()
```

---

## 六、与 Claude Code 的对比

| Claude Code | Bot | 差异原因 |
|---|---|---|
| ContentReplacementState（命运不可变保 prompt cache） | 不实现 | bot 的模型不保证 prompt cache |
| cache_edits 服务端删除 | 不实现 | 非 Anthropic API |
| Session Memory（零 API 调用压缩） | 不实现 | bot 没有持续后台摘要服务 |
| Fork Agent 共享 prompt cache | 不实现 | 直接用 streamSimple 调用 |
| normalizeMessagesForAPI 12 步 | 不需要 | convertToLlm 已处理类型转换 |
| SnipTool（模型主动触发） | 自动触发 | IM bot 无需模型主动管理上下文 |
| 7 级 | 6 级 | 合并了 Claude Code 的 Level 1（单消息预算）到 Level 0 |

**核心思路一致**：越轻越先用，工具结果是主战场，渐进式降级而非一刀切。
