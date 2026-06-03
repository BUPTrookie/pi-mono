# agent-team 整体设计文档

> 版本: 0.65.2 | 更新: 2026-06-02
>
> 基于源码逐文件审查，精确到函数和行号。

## 目录

- [1. 项目定位](#1-项目定位)
- [2. 包依赖关系](#2-包依赖关系)
- [3. 架构总览](#3-架构总览)
- [4. 配置系统](#4-配置系统)
- [5. 启动流程](#5-启动流程)
- [6. 规划层：Planner](#6-规划层planner)
- [7. 调度层：TeamLead](#7-调度层teamlead)
- [8. 执行层：Worker Agent](#8-执行层worker-agent)
- [9. 验证层：Validator + Supervisor](#9-验证层validator--supervisor)
- [10. 修复循环：Repair](#10-修复循环repair)
- [11. 安全模型](#11-安全模型)
- [12. 事件系统](#12-事件系统)
- [13. 执行持久化](#13-执行持久化)
- [14. TUI 交互层](#14-tui-交互层)
- [15. 类型系统](#15-类型系统)
- [16. 已知设计缺陷](#16-已知设计缺陷)
- [17. 文件清单](#17-文件清单)

---

## 1. 项目定位

`@mariozechner/pi-agent-team` 是项目级多 Agent 编排器。它接收一条自然语言需求描述，通过 LLM 动态规划团队角色和任务，并行调度多个 Agent 执行开发工作，自动验证产出质量，并在发现问题时驱动修复循环。

**设计原则**：

- **队长制**：TeamLead 是确定性调度核心，不依赖 LLM 做调度决策
- **契约协作**：Agent 之间不直接通信，通过契约文件和实际文件共享上下文
- **闭集角色**：7 个内置 profile，Planner 不能自定义工具/turns/model
- **分层验证**：Worker 自检 → Handoff → Validator → E2E → Supervisor 五道质量门
- **依赖注入**：所有外部依赖（planner/agent/validator/supervisor/recorder）均可注入 mock

**不是什么**：
- 不是通用 Agent 框架——它是一个垂直应用，专注于"给定需求，自动生成一个可运行的项目"
- 不实现底层 Agent 循环——复用 `@mariozechner/pi-agent-core` 的 Agent 运行时
- 不实现 LLM API 调用——复用 `@mariozechner/pi-ai` 的 stream/complete 能力

---

## 2. 包依赖关系

```
pi-tui（终端 UI 库）
    ↑
pi-ai（统一 LLM API，20+ provider）→ streamSimple(), completeSimple()
    ↑
pi-agent-core（Agent 运行时，tool calling）→ Agent, AgentEvent, beforeToolCall
    ↑
pi-coding-agent（编码工具 + 模型注册）→ createReadTool/WriteTool/EditTool/BashTool/..., ModelRegistry, AuthStorage
    ↑
pi-agent-team（本包）→ TeamLead, TeamRun, Validator, Supervisor, TUI
```

本包从下游包复用的具体能力：

| 来源包 | 复用内容 | 用途 |
|--------|---------|------|
| `pi-agent-core` | `Agent` 类、`AgentEvent`、`beforeToolCall` | Worker Agent 运行时 |
| `pi-ai` | `streamSimple()`、`completeSimple()` | Worker 用 stream（多轮工具调用）、Planner/Supervisor 用 complete（一次性 JSON） |
| `pi-coding-agent` | 7 个工具工厂、`convertToLlm`、`ModelRegistry`、`AuthStorage` | 工具池构建、模型解析、API Key 管理 |
| `pi-tui` | `TerminalUi` 框架 | TUI 渲染 |

---

## 3. 架构总览

```
                          ┌──────────────────────────────────────────┐
                          │              用户需求描述                  │
                          └────────────┬─────────────────────────────┘
                                       │
                          ┌────────────▼─────────────────────────────┐
                          │            CLI / TUI 入口                  │
                          │  main.ts → parseArgs → findConfigFile     │
                          └────────────┬─────────────────────────────┘
                                       │ TeamConfig
                          ┌────────────▼─────────────────────────────┐
                          │          DynamicTeamRun                    │
                          │  team-runner.ts                            │
                          │  · 创建输出目录 + slug                     │
                          │  · 初始化 ExecutionRecorder                │
                          │  · 解析模型 (ModelRegistry + baseUrl)      │
                          │  · 管理 暂停/恢复/终止/审批/干预            │
                          │  · 注入 mock 支持                          │
                          └────────────┬─────────────────────────────┘
                                       │
                          ┌────────────▼─────────────────────────────┐
                          │            TeamLead                        │
                          │  team-lead.ts                              │
                          │  · 调用 Planner 获取 TeamPlan              │
                          │  · 写入契约文件                             │
                          │  · 创建角色注册表                           │
                          │  · 构建 DAG + 调度任务                     │
                          │  · 调用 Validator 验证                     │
                          │  · 生成 repair tasks                       │
                          │  · 调用 Supervisor 审查                    │
                          └──┬──────┬──────┬──────┬──────────────────┘
                             │      │      │      │
              ┌──────────────┘      │      │      └──────────────┐
              │                     │      │                     │
   ┌──────────▼──────┐  ┌──────────▼──┐  ┌▼──────────┐  ┌──────▼──────────┐
   │   Planner LLM   │  │  Worker x N  │  │ Validator  │  │  Supervisor LLM │
   │  planner.ts      │  │ team-agent   │  │ validator  │  │  supervisor.ts  │
   │  completeSimple  │  │ streamSimple │  │ 静态+运行时 │  │  completeSimple │
   └────────┬─────────┘  └──────┬───────┘  └─────┬─────┘  └───────┬────────┘
            │                   │                │                │
            ▼                   ▼                ▼                ▼
   docs/contracts/       项目源码文件       ValidationIssue    SupervisorDecision
   *.json 契约文件       + handoff JSON     + RuntimeChecks    + issues[]
```

---

## 4. 配置系统

### 4.1 配置发现

**代码**: `config.ts:38-55` (`findConfigFile`)

发现顺序（首个成功即停止，不叠加）：

1. `--config <path>` 显式路径
2. `./agent-team.json` 当前工作目录
3. `~/.pi/agent-team.json` 用户主目录

### 4.2 配置合并

**代码**: `config.ts:62-113` (`mergeConfig`)

优先级: `CLI 参数 > 配置文件 > 硬编码默认值`

通过 nullish coalescing (`??`) 逐字段合并。

### 4.3 TeamConfig 字段

| 字段 | 类型 | 默认值 | 来源 |
|------|------|--------|------|
| `requirement` | `string` | 必填 | CLI 位置参数 |
| `outputDir` | `string` | `"./output"` | CLI `--output` |
| `model.provider` | `string?` | - | 配置文件 / CLI |
| `model.model` | `string` | `"claude-sonnet-4-6"` | 合并默认值 |
| `model.apiKey` | `string?` | - | 配置文件 / CLI |
| `model.baseUrl` | `string?` | - | 配置文件 / CLI |
| `maxParallelAgents` | `number?` | `2` | 配置文件 |
| `thinkingLevel` | `ThinkingLevel?` | `"off"` | 配置文件 |
| `interventionMode` | `"none"|"approval"|"interactive"` | `"none"` | 配置文件 |
| `supervisionMode` | `"off"|"milestone"` | `"milestone"` | 合并默认值 |
| `permissionMode` | `"open"|"owned"` | `"open"` | 合并默认值 |
| `executionMode` | `"open"|"restricted"` | `"open"` | 合并默认值 |
| `approvalPolicy` | `"minimal"|"strict"` | `"minimal"` | 合并默认值 |
| `maxRepairRounds` | `number?` | `2` | 配置文件 |

**注意**: `supervisionMode` 的硬编码默认值是 `"milestone"`（`config.ts:105`），不是 `"off"`。这意味着不配置时会自动启用 Supervisor。

### 4.4 典型配置文件

```json
{
  "outputDir": "./output",
  "model": {
    "provider": "openrouter",
    "model": "deepseek-v4-pro",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-xxx"
  },
  "maxParallelAgents": 2,
  "thinkingLevel": "off",
  "maxRepairRounds": 2
}
```

---

## 5. 启动流程

### 5.1 CLI 解析

**代码**: `main.ts:40-138` (`parseArgs`)

默认 `interactive: true`——不加 `--no-interactive` 会启动 TUI。

支持的位置参数和标志见 `printHelp()` 输出。

**已知缺陷**: `parseInt` 对非数字输入返回 NaN，NaN 不是 nullish 值，`??` 不回退（`main.ts:81,87`）。

### 5.2 模型解析

**代码**: `team-runner.ts:55-104` (`resolveModel`)

解析管线：

1. 解析 `"provider/model"` 格式：从 modelId 中提取 provider
2. 精确匹配：`registry.find(provider, modelId)`
3. Provider 模板回退：取该 provider 的第一个模型为模板，强制 `api: "openai-completions"` 兼容
4. 无 provider 搜索：遍历所有 provider 的所有模型
5. baseUrl 覆盖：如果提供了 baseUrl，覆盖模板的 baseUrl

**API Key 传播**（`team-runner.ts:188-190`）：如果解析后的 `model.provider` 与配置的 `provider` 不同，也为解析后的 provider 注册同一个 key。

### 5.3 输出目录

**代码**: `team-runner.ts:259-264` (`prepareProjectConfig`)

从需求文本提取 slug（去停用词、取前4词、用 `-` 连接），在 `outputDir` 下创建唯一目录。如果已存在则加 `-2`、`-3` 后缀。

```
output/markdown-api-express-sqljs/
output/markdown-api-express-sqljs-2/
```

### 5.4 完整启动序列

```
main.ts: parseArgs → findConfigFile → mergeConfig
    ↓
team-runner.ts: createTeamRun → DynamicTeamRun.start()
    ↓
DynamicTeamRun.start():
  1. prepareProjectConfig() → 创建输出目录
  2. createExecutionRecorder() → 初始化记录器
  3. AuthStorage + ModelRegistry → 模型解析
  4. resolveModel() → 解析模型
  5. getApiKey 回调 → API Key 策略
  6. new TeamLead({config, model, getApiKey, emit, controls, ...})
  7. lead.orchestrate() → 进入主循环
```

---

## 6. 规划层：Planner

### 6.1 调用方式

**代码**: `planner.ts:445-473` (`llmPlannerRunner`)

通过 `completeSimple()` 一次性调用 LLM，要求只返回 JSON。

自动修复机制：
1. 第一次调用 → `parsePlannerOutput()`
2. 如果 JSON 无效 → 用错误信息 + 原始输出 re-prompt
3. 第二次仍失败 → 抛出错误，终止 run

### 6.2 输入：System Prompt

**代码**: `planner.ts:342-408` (`plannerSystemPrompt`)

关键约束注入：
- 只能从 7 个内置 profile 选择（通过 `formatRoleProfilesForPlanner()` 注入列表）
- 不能输出 `allowedTools/systemPrompt/maxTurns/modelOverride/thinkingLevelOverride`
- 必须创建恰好一个 `e2e-verifier` 任务
- e2e-verifier 必须依赖所有实现和测试任务
- 偏好纯 JS 包，避免 native addon
- `permissionMode` 影响 ownedDirectories 规则描述

### 6.3 输出：PlannerResult

**代码**: `types.ts:89-93`

```typescript
interface PlannerResult {
  plan: TeamPlan;          // 角色、任务、依赖、契约
  contracts: GeneratedContracts;  // projectManifest, openapi?, dataModel?, notes?
  diagnostics: PlannerDiagnostic[];
}
```

### 6.4 JSON 校验

**代码**: `planner.ts:271-331` (`validatePlannerJson`)

校验步骤：
1. `normalizeRole()` → 检查 profile 是否在闭集内、禁止自定义字段
2. `normalizeTask()` → 检查字段类型和完整性
3. 角色名唯一性、任务 ID 唯一性
4. 任务引用的角色必须存在
5. 依赖引用的任务必须存在
6. 任务不能依赖自身
7. `validateAcyclicTasks()` → DFS 环检测
8. `validateRoleOwnership()` → owned 模式下检查 expectedOutputs 在 ownedDirectories 内
9. `validateE2eVerifierTask()` → 恰好一个 e2e-verifier，依赖所有实现/测试任务
10. `validateSafePaths()` → 拒绝绝对路径和 `..`

### 6.5 契约写入

**代码**: `planner.ts:481-487` (`writeContracts`)

| 文件 | 条件 |
|------|------|
| `docs/contracts/team-plan.json` | 始终写入 |
| `docs/contracts/project-manifest.json` | 始终写入 |
| `docs/contracts/openapi.json` | 有 API 时写入 |
| `docs/contracts/data-model.json` | 有数据持久化时写入 |
| `docs/contracts/notes.json` | 可选 |

### 6.6 角色注册表

**代码**: `planner.ts:36-53` (`roleFromSpec`)

Planner 输出的 `RoleSpec`（只有 name/profile/description/ownedDirectories）被合成为运行时 `RoleDefinition`：

- `systemPrompt` ← `buildRoleSystemPrompt(spec, permissionMode, executionMode)`
- `allowedTools` ← profile 的 `allowedTools`
- `maxTurns` ← profile 的 `maxTurns`
- `thinkingLevelOverride` ← profile 的 `thinkingLevelOverride`

**`createRoleRegistry()`**（`planner.ts:55-65`）返回 `Map<string, RoleDefinition>`，key 是 role name。

---

## 7. 调度层：TeamLead

### 7.1 主循环

**代码**: `team-lead.ts:335-487` (`orchestrateRun`)

```
emit run_start
    ↓
plannerRunner() → writeContracts() → emit plan_created → supervise(plan_created)
    ↓
createRoleRegistry(plan)
    ↓
┌─→ runTasks(tasksToRun, plan, roleRegistry)       ← 执行任务
│       ↓
│   validatorRunner() → emit validation_start/end  ← 验证
│       ↓
│   supervise(validation_end)                       ← Supervisor 审查
│       ↓
│   hasBlockingIssues?
│       ├── 否 → supervise(final_review) → emit run_end(success)
│       └── 是 → round >= maxRepairRounds?
│               ├── 是 → emit run_end(failure)
│               └── 否 → createRepairTasks()
│                       → emit repair_requested / plan_updated
│                       → tasksToRun = repairTasks
│                       → 回到循环顶部 ─┘
```

### 7.2 任务执行

**代码**: `team-lead.ts:616-747` (`runTasks`)

调度流程：
1. `toGraph(tasks)` → 构建 TaskGraph
2. `new TaskScheduler(graph, maxParallel)`
3. 循环：`scheduler.nextBatch()` → 取 ready 任务
4. 每个任务：`scheduler.startTask()` → emit task_start → `missingDependencyOutput()` → 构建 `agentConfig` + `description` → `runAgentAttempt()`
5. `Promise.allSettled(batchPromises)` → 并行等待
6. 处理结果：`graph.markComplete()` 或 `graph.propagateFailure()`
7. emit task_end → supervise(task_end)

### 7.3 依赖缺失检查

**代码**: `team-lead.ts:225-238` (`missingDependencyOutput`)

在任务开始前，检查所有依赖任务的 `expectedOutputs`（跳过 glob 模式）是否存在。缺失则直接标记失败（`turnsUsed=0`），不启动 Agent。

### 7.4 任务描述构造

**代码**: `team-lead.ts:89-141` (`buildTaskDescription`)

每个 Worker 收到的任务描述包含：

```
Project requirement: <原始需求>
Team plan summary: <plan.summary>
Assigned role: <role.name> - <role.description>
Task: <task.subject>
Instructions: <task.description>
Contract files to read first: <所有 contract 路径>
Owned paths: <role.ownedDirectories>
Expected outputs: <task.expectedOutputs>
Acceptance criteria: <task.acceptanceCriteria>
Self-check before finishing: <自检要求>
Execution guidance: <基于 executionMode 的指令>
Do not rely on prior agent prose summaries...
--- HUMAN INTERVENTIONS --- (如果有的话)
```

### 7.5 Agent 会话复用

**代码**: `team-lead.ts:489-530` (`runAgentAttempt`)

TeamLead 维护 `taskSessions: Map<string, TeamAgentSession>`，key 是 `originalTaskId`。

- 首次执行（attemptMode=initial）→ `session.prompt()`
- 后续尝试（attemptMode=continue/rerun）→ `session.continueWith()`
- 同一个 originalTaskId 的所有尝试共享同一个 Agent 实例和消息历史

---

## 8. 执行层：Worker Agent

### 8.1 Agent 构建

**代码**: `team-agent.ts:246-408` (`createTeamAgentSession`)

```typescript
new Agent({
  initialState: {
    systemPrompt: role.systemPrompt,  // 来自 buildRoleSystemPrompt()
    model,                            // TeamRun 解析的模型
    thinkingLevel,                    // role override 或全局配置
    tools: buildToolPool(role, outputDir),
  },
  streamFn,                           // streamSimple()
  getApiKey,                          // 从 TeamRun 传入
  convertToLlm,                       // 从 pi-coding-agent
  beforeToolCall,                     // ownership + bash safety
  transformContext: createContractAwareTransformContext(120),
})
```

### 8.2 工具池

**代码**: `tool-pool.ts`

7 个工具，全部来自 `@mariozechner/pi-coding-agent`：

| 工具名 | 工厂函数 | 用途 |
|--------|---------|------|
| `read` | `createReadTool(cwd)` | 读文件 |
| `write` | `createWriteTool(cwd)` | 写文件 |
| `edit` | `createEditTool(cwd)` | 编辑文件 |
| `bash` | `createBashTool(cwd)` | 执行命令 |
| `grep` | `createGrepTool(cwd)` | 搜索内容 |
| `find` | `createFindTool(cwd)` | 查找文件 |
| `ls` | `createLsTool(cwd)` | 列出目录 |

`buildToolPool(role, outputDir)` 只实例化 `role.allowedTools` 中的工具。每个工具以 `outputDir` 为 `cwd`。

### 8.3 System Prompt 生成

**代码**: `system-prompts.ts:18-49` (`buildRoleSystemPrompt`)

```
You are {role.name}, the {profile.systemPromptTitle} in a dynamic AI engineering team.

Role: {role.description}
Profile: {profile.description}

Collaboration contract:
- 读 contracts
- 遵循 OpenAPI / dataModel
- 权限模式指令
- 执行模式指令
- e2e-verifier 特殊指令（启动本地服务器、localhost only、上游失败报告）

Profile-specific instructions: {profile.instructions}
Skill hints: {profile.skillHints}
```

### 8.4 beforeToolCall 钩子链

**代码**: `team-agent.ts:280-295`

执行顺序：Ownership Guard → Bash Safety Guard（链式短路）

| 钩子 | 条件 | 行为 |
|------|------|------|
| Ownership Guard | `permissionMode=owned` | 检查 write/edit/bash 的目标路径是否在 ownedDirectories 内 |
| Bash Safety Guard | 始终启用 | 分类 bash 命令风险，阻断或请求审批 |

### 8.5 上下文压缩

**代码**: `team-agent.ts:213-244` (`createContractAwareTransformContext`)

当消息超过 120 条时触发：
1. 保留 system message
2. 保留包含契约引用的消息（`docs/contracts/`、`Contract files to read first:` 等）
3. 保留最近的消息
4. 去重

### 8.6 结果判定

**代码**: `team-agent.ts:123-163` (`buildTaskResultFromAgentState`)

```typescript
if (!output && filesCreated.length === 0) {
  // 空输出且无文件 → success=false
} else {
  // 有输出或有文件 → success = (fallbackError === undefined)
}
```

**不检查** expectedOutputs 是否存在。`success` 仅基于：
1. Agent 是否有输出文本
2. Agent 是否写了/编辑了文件
3. 是否有 fallbackError（abort/maxTurns/error）

### 8.7 Handoff 写入

**代码**: `team-agent.ts:188-208` (`writeTaskHandoff`)

每个任务结束后写入 `docs/agent-team/tasks/<taskId>-handoff.json`：

```json
{
  "taskId": "setup",
  "changedFiles": ["package.json", "src/app.js"],
  "contractsSatisfied": ["Task acceptance criteria reviewed by agent."],
  "checksRun": [
    { "command": "node --check src/app.js", "exitCode": 0, "summary": "completed", "required": true }
  ],
  "knownRisks": []
}
```

### 8.8 自检提取

**代码**: `team-agent.ts:165-186` (`extractChecksRunFromAgentEvents`)

从 Agent 事件流中提取 bash 工具调用，只记录匹配 `isSelfCheckCommand()` 的命令：

- `node --check`、`npm/pnpm/yarn/bun test/build/check`
- `vitest`、`tsc`、`eslint`
- `npm/pnpm/yarn/bun install`
- `node -e "require(...)"` 形式

---

## 9. 验证层：Validator + Supervisor

### 9.1 Validator

**代码**: `validator.ts:775-820` (`validateTeamOutputWithChecks`)

执行顺序：

```
Phase 1: 静态检查 (validateTeamOutput)
  ├── 契约文件存在
  ├── expectedOutputs 存在 (exact → glob → fuzzy 三级匹配)
  ├── package.json 有效且有 scripts
  ├── OpenAPI 路径在源码中体现
  └── E2E 报告结构和状态

Phase 2: 运行时检查
  ├── node --check (JS 语法检查, 最多80个文件)
  ├── npm install (有依赖但无 node_modules 时)
  ├── npm run check (如果存在且安全)
  ├── npm test (如果有用的 test script 且安全)
  └── npm run build (如果存在且安全)
  注: 首个 runtime 失败即中断

Phase 3: Handoff 审查 (validateTaskHandoffs)
  ├── 非 docs task 必须有 handoff
  ├── 必须有 checksRun
  └── 至少一个 exitCode=0 的检查
```

**npm scripts 安全检查**（`validator.ts:341-343`）：

用 `explainUnsafeBash()` 检查脚本内容。如果判定为危险则不执行，只报 issue。但这层保护不够——LLM 可以构造绕过正则的恶意脚本。

**E2E 报告检查**（`validator.ts:678-716`）：

用正则检查关键词：`\bcommands?\b`、`\bexit\s+status\b`、`\bobserved\s+result\b`、`\bacceptance\s+status\b`、`\bevidence\b`。如果 acceptance status 是 FAIL，提取 `suspectedOwnerTaskId`/`suspectedFile` 生成路由 issue。

**原生 addon 失败**（`validator.ts:459-492`）：

如果 npm install 输出匹配 node-gyp 等模式，降级为 warning 并提示使用纯 JS 替代方案。

### 9.2 Supervisor

**代码**: `supervisor.ts`

**调用时机**（`team-lead.ts:547-614`）：

| 检查点 | 触发条件 |
|--------|---------|
| `plan_created` | 规划成功后 |
| `task_end` | 每个任务结束后 |
| `validation_end` | 每轮验证后 |
| `final_review` | 无阻塞 issue 时，最终审查 |

**上下文构建**（`supervisor.ts:196-266`）：

| 输入 | 内容 | 限制 |
|------|------|------|
| contracts | 所有契约文件全文 | 无截断 |
| e2eReports | E2E 报告全文 | 无截断 |
| handoffs | 所有 handoff JSON | 无截断 |
| changedFiles | 任务产出的文件内容 | 最多 12 个，每个 12K 字符 |
| validationIssues | 当前所有 issue | 无限制 |
| recentEvents | 最近 40 个事件摘要 | 每事件一行摘要 |
| allTaskResults | 所有任务结果摘要 | output 截断到 500 字符 |

**输出**（`supervisor.ts:108-139`）：

结构化 JSON：
```json
{
  "checkpoint": "task_end",
  "decision": "accept|warn|request_repair|request_human",
  "summary": "...",
  "issues": [{ "id": "...", "severity": "error", "message": "...", "ownerTaskId": "..." }],
  "recommendedActions": ["..."]
}
```

**校验规则**：
- `request_repair` 的每个 issue 必须有 `ownerTaskId` 或 `file`
- checkpoint 必须匹配当前调用点
- decision 必须是四种之一

**失败降级**（`team-lead.ts:594-613`）：

如果 Supervisor LLM 调用失败（parse error / model error / runtime error），降级为 `warn`，不中断 run。分类错误原因并给出修复建议。

**持久化**（`supervisor.ts:329-360`）：

- `docs/agent-team/supervision/001-plan_created.json`
- `docs/agent-team/supervision/002-task_end.json`
- `docs/agent-team/team-leader-review.md`（追加式 Markdown）

---

## 10. 修复循环：Repair

### 10.1 触发条件

验证后存在 `severity === "error"` 的 issue，且未超过 `maxRepairRounds`。

### 10.2 Issue 路由

**代码**: `planner.ts:534-604` (`createRepairTasks`)

路由优先级：
1. `issue.ownerTaskId` → 直接匹配
2. `issue.file` → `findTaskOwnerForFile()` 按 ownedDirectories 查最具体的 owner
3. `issue.ownerRole` → 按 role 名匹配
4. fallback → `plan.tasks[0]?.id`

过滤：
- 级联依赖 issue（`Dependency 'xxx' failed/did not produce`）→ 跳过
- 未路由的 E2E issue（`needsSemanticRouting=true`）→ 跳过，交给 Supervisor

### 10.3 DAG 保留

**代码**: `planner.ts:556-580`

```typescript
// 1. 找出 root repair tasks（直接有 issue 的）
const rootIds = [...directRootIds].filter(
  (taskId) => ![...directRootIds].some(
    (candidate) => candidate !== taskId && taskDependsOn(plan, taskId, candidate)
  )
);

// 2. 加上所有下游任务
const selectedIds = new Set([...rootIds, ...downstreamTaskIds(plan, rootIds)]);

// 3. repair task 的 dependencies 指向原依赖的 repair 版本
const repairIdByOriginalId = new Map(selectedTasks.map(t => [t.id, `repair-${round}-${t.id}`]));
```

这意味着 repair 保留了原始 DAG 拓扑：如果 backend 依赖 data，repair 后 repair-backend 仍然依赖 repair-data。

### 10.4 Repair Task 构建

```typescript
{
  ...originalTask,
  id: `repair-${round}-${originalTask.id}`,
  subject: "Repair/Rerun {originalTask.subject}",
  description: "${originalTask.description}\n\nFix these validation issues:\n${issueText}\n\n...",
  dependencies: [...repair versions of original dependencies],
  repairOf: [issue IDs],
  attemptMode: "continue" | "rerun",
  continuedFrom: originalTask.id,
}
```

### 10.5 会话复用

TeamLead 的 `taskSessions` Map 用 `originalTaskId` 做 key。Repair task 的 `continuedFrom` 指向原任务 ID，所以 repair 复用同一个 Agent 实例——agent 保留了之前的消息历史。

---

## 11. 安全模型

### 11.1 三层权限控制

| 配置 | 默认 | 作用 |
|------|------|------|
| `permissionMode` | `"open"` | `open`: ownedDirectories 只用于职责路由；`owned`: write/edit/bash 目标必须在 ownedDirectories 内 |
| `executionMode` | `"open"` | `open`: 允许完成任务所需命令；`restricted`: 提示 agent 少跑安装/长驻命令 |
| `approvalPolicy` | `"minimal"` | `minimal`: high 审批；`strict`: medium+high 审批 |

### 11.2 Bash 风险分类

**代码**: `bash-safety.ts:190-207` (`classifyBashCommand`)

```
输入命令
    │
    ├── 空命令 → high (empty)
    ├── isSafeDirectoryCreation → safe (file-operation)
    ├── SAFE_TEST_RUNNER → safe (self-check)
    ├── isSafeLocalHttpCheck → safe (local-http)
    ├── allowLocalServerLifecycle + isSafeLocalServerLifecycle → safe (local-server-lifecycle)
    ├── highRisk() → high
    │   ├── 命令替换 $(...) `
    │   ├── curl | bash
    │   ├── rm / del
    │   ├── chmod
    │   ├── docker build/up
    │   └── 非本地 curl/wget
    ├── mediumRisk() → medium
    │   ├── npm/pnpm/yarn/bun install/add/remove
    │   ├── npx
    │   └── npm run dev/start + 后台进程 &
    └── 默认 → safe (general)
```

### 11.3 审批策略

**代码**: `bash-safety.ts:214-251` (`createBashSafetyGuard`)

```
风险等级 → 需要审批?
  safe → 否（直接放行）
  medium → minimal: 否, strict: 是
  high → 是

需要审批时:
  interventionMode=none 或无 requestApproval → 阻断
  否则 → requestApproval() → approve 放行 / reject 阻断

同一次 run 内，approvedApprovalKeys Set 记住已批准的 key → 自动复用
```

### 11.4 文件归属守卫

**代码**: `file-ownership.ts`

仅在 `permissionMode=owned` 时激活。

检查范围：
- `write` / `edit`：检查 `args.path`
- `bash`：提取重定向目标（`>` `>>`）和简单命令目标（`touch` `mkdir` `cp` `mv` `tee`）

路径判断：`isWithin()` 用 `path.relative()` 做词法比较，不做 `realpath` 解析。

**已知缺口**：
- 不覆盖所有 bash 写路径（如 `dd`、`sed -i`、`install`）
- 符号链接不解析（Windows 上实际风险低）
- 不覆盖 `npm install` 的副作用（会写 node_modules）

---

## 12. 事件系统

### 12.1 TeamEvent 类型

**代码**: `types.ts:213-244`

17 种事件类型：

| 事件 | 携带数据 | 触发点 |
|------|---------|--------|
| `run_start` | requirement, outputDir | TeamLead.orchestrate() 入口 |
| `run_end` | TeamResult | 成功/失败/终止 |
| `plan_created` | TeamPlan | Planner 成功后 |
| `plan_updated` | TeamPlan, reason | Repair 添加新任务后 |
| `task_start` | Task | 任务开始执行 |
| `task_progress` | taskId, message | 工具阻断、进度消息 |
| `task_end` | Task, TaskResult | 任务完成 |
| `agent_event` | taskId, role, AgentEvent | 转发底层 Agent 事件 |
| `approval_requested` | requestId, taskId, reason, command | Bash 命令需要审批 |
| `approval_resolved` | requestId, decision | 审批决策 |
| `validation_start` | round | 验证开始 |
| `validation_end` | round, issues | 验证结束 |
| `repair_requested` | round, issues, tasks | 生成修复任务 |
| `supervision_start` | checkpoint, taskId?, round? | Supervisor 开始 |
| `supervision_end` | checkpoint, decision | Supervisor 结束 |
| `run_paused` | - | 用户暂停 |
| `run_resumed` | - | 用户恢复 |
| `intervention` | message | Supervisor 请求人工输入 / 用户干预 |

### 12.2 事件传播路径

```
TeamLead.emitEvent()
    ├── this.recentEvents（内部缓存，最多 200 条）
    ├── DynamicTeamRun.emit()
    │   ├── ExecutionRecorder.record() → JSONL + 任务分片
    │   ├── TUI listeners → 界面更新
    │   └── 外部 subscribers
    └──（如果 Supervisor 审查时）→ buildSupervisorContext() 使用 recentEvents
```

---

## 13. 执行持久化

### 13.1 ExecutionRecorder

**代码**: `execution-recorder.ts`

产出文件：

| 文件 | 内容 |
|------|------|
| `docs/agent-team/events.jsonl` | 全局事件流，每行一个 JSON 事件 |
| `docs/agent-team/tasks/<taskId>.jsonl` | 按任务分片，只含该任务相关事件 |
| `docs/agent-team/run-summary.md` | 最终摘要 |

**敏感字段脱敏**：对 `apiKey`、`token`、`secret` 等关键词的值替换为 `[redacted]`。

**注意**：`content` 字段被脱敏后，无法用于回放 Agent 写入内容。

---

## 14. TUI 交互层

### 14.1 入口

**代码**: `tui/team-tui.ts`

```typescript
export async function runTeamTui(config: TeamConfig): Promise<TeamResult>
```

流程：
1. `createTeamRun(config)` → 创建 TeamRun
2. `new TeamRunComponent(run, options)` → 创建 TUI 组件
3. `run.subscribe(event => component.push(event))` → 订阅事件
4. `tui.start()` → 启动终端渲染
5. `run.start()` → 启动执行

### 14.2 交互操作

| 按键 | 操作 |
|------|------|
| `p` | 暂停/恢复 |
| `a` | 批准当前审批请求 |
| `r` | 拒绝当前审批请求 |
| `Ctrl+C` | 终止运行 |

### 14.3 显示内容

- 运行状态（planning / executing / validating / repairing）
- 输出目录
- 模型和并发数
- 任务状态表（pending / in_progress / completed / failed）
- 验证轮次和 issue 计数
- 当前工具调用
- 审批队列
- 最近日志（滚动窗口）

---

## 15. 类型系统

### 15.1 核心类型关系

```
TeamConfig
    │
    ▼
PlannerResult ──┬── TeamPlan ──┬── RoleSpec[]
                 │              ├── TaskSpec[]
                 │              ├── ContractSpec[]
                 │              └── validationRules[]
                 ├── GeneratedContracts
                 └── PlannerDiagnostic[]
                        │
                        ▼
                 RoleDefinition (runtime, from RoleSpec + profile)
                        │
                        ▼
                 Task (runtime, from TaskSpec)
                        │
                        ▼
                 TaskResult ──┬── checksRun: TaskCheckResult[]
                              └── handoffPath
                        │
                        ▼
                 ValidationIssue ──┬── severity: error|warning|info
                                   ├── ownerTaskId?, ownerRole?, file?
                                   ├── source: validator|task|supervisor|e2e
                                   └── needsSemanticRouting?
                        │
                        ▼
                 SupervisorDecision ──┬── decision: accept|warn|request_repair|request_human
                                      ├── issues: ValidationIssue[]
                                      └── recommendedActions: string[]
```

### 15.2 关键枚举

```typescript
type RoleProfileId = "project-setup" | "backend-engineer" | "data-engineer"
                   | "frontend-engineer" | "test-engineer" | "e2e-verifier" | "docs-engineer";

type TaskStatus = "pending" | "in_progress" | "completed" | "failed";
type TaskAttemptMode = "initial" | "continue" | "rerun";

type PermissionMode = "open" | "owned";
type ExecutionMode = "open" | "restricted";
type ApprovalPolicy = "minimal" | "strict";
type InterventionMode = "none" | "approval" | "interactive";
type SupervisionMode = "off" | "milestone";
```

---

## 16. 已知设计缺陷

### CRITICAL

| ID | 问题 | 代码位置 | 影响 |
|----|------|---------|------|
| C-1 | 并行任务失败归因错误 | `team-lead.ts:691-731` | `Promise.allSettled` 后可能把失败归到错误的任务 |

### HIGH

| ID | 问题 | 代码位置 | 影响 |
|----|------|---------|------|
| H-1 | Agent 不验证 expectedOutputs | `team-agent.ts:123-163` | Agent 自报成功但可能缺失关键产物 |
| H-2 | Bash 阻断后 exitCode=0 | `team-agent.ts:98-104` | checksRun 误导系统认为被阻命令执行成功 |
| H-3 | npm scripts 任意代码执行 | `validator.ts:525-568` | LLM 可在 package.json 注入恶意脚本，validator 直接执行 |
| H-4 | Repair task ID 重复 | `planner.ts:572` | 多个 issue fallback 到同一 task 时 TaskGraph throw |
| H-5 | 核心模块无测试 | `team-agent.ts` | Agent 构造器、轮次强制、上下文压缩未测 |

### MEDIUM

| ID | 问题 | 代码位置 | 影响 |
|----|------|---------|------|
| M-1 | validationRules 从未消费 | `validator.ts` | Planner 浪费 token 生成无用规则 |
| M-2 | 静态检查提前返回 | `validator.ts:775-820` | 有静态 error 时跳过运行时检查，浪费修复轮次 |
| M-3 | Repair fallback 到 tasks[0] | `planner.ts:541` | 可能分配给无关 agent |
| M-4 | parseInt NaN 无限循环 | `main.ts:81,87` | `round >= NaN` 恒 false |
| M-5 | getApiKey 忽略 provider 参数 | `team-runner.ts:193-201` | 对所有 provider 返回同一个 key |
| M-6 | OpenAPI 段拼接误报 | `validator.ts:246-250` | 过于宽松的匹配 |
| M-7 | ownerForFile 非 most-specific | `validator.ts:361-377` | first-match 而非 longest-match |

---

## 17. 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/main.ts` | ~190 | CLI 入口、参数解析、帮助信息 |
| `src/config.ts` | ~113 | 配置文件发现与合并 |
| `src/types.ts` | ~257 | 所有公共类型定义 |
| `src/index.ts` | ~50 | 公共 API 导出 |
| `src/roles/role-profiles.ts` | ~145 | 7 个内置角色 profile 定义 |
| `src/roles/role-registry.ts` | ~1 | 桶文件，重新导出 createRoleRegistry |
| `src/roles/system-prompts.ts` | ~60 | Worker system prompt 模板生成 |
| `src/agent/team-agent.ts` | ~426 | Worker Agent 运行时、会话管理、结果判定、handoff 写入 |
| `src/agent/tool-pool.ts` | ~35 | 工具池构建（7 个工具） |
| `src/agent/bash-safety.ts` | ~252 | Bash 风险分类、审批策略、阻断逻辑 |
| `src/agent/file-ownership.ts` | ~130 | 文件归属守卫（owned 模式） |
| `src/task/task-graph.ts` | ~121 | DAG 存储、就绪任务、级联失败 |
| `src/task/task-scheduler.ts` | ~45 | 并发槽位控制 |
| `src/team/team-lead.ts` | ~749 | 主编排器：规划→调度→验证→修复→Supervisor |
| `src/team/planner.ts` | ~605 | LLM Planner、JSON 校验、契约写入、repair task 生成 |
| `src/team/validator.ts` | ~821 | 静态+运行时验证、E2E 路由、handoff 审查 |
| `src/team/supervisor.ts` | ~361 | Supervisor LLM 审查、上下文构建、决策解析 |
| `src/team/team-runner.ts` | ~285 | TeamRun 生命周期、模型解析、审批/暂停/终止控制 |
| `src/team/execution-recorder.ts` | ~? | 事件持久化：JSONL + 任务分片 + summary |
| `src/tui/team-tui.ts` | ~? | TUI 渲染：任务表、审批、日志 |
| `src/utils/logger.ts` | ~20 | 彩色日志（chalk） |
| `src/utils/shared.ts` | ~30 | 工具函数：sanitizeTaskId、extractJsonText 等 |
