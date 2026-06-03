# Agent 协作与质量验证说明

> 最近更新: 2026-06-02
>
> 基于源码审查，精确到文件和行号。

## 1. 系统里有哪些 Agent？每个 Agent 的职责边界是什么？

系统有 **4 类 Agent 或 Agent-like 角色**。必须严格区分：TeamLead 是确定性调度器，不是 LLM agent。

### 1.1 Planner（LLM 规划 Agent）

**实现**: `src/team/planner.ts`，通过 `completeSimple()` 调用 LLM 一次性生成 JSON。

**职责**:
- 把自然语言需求拆成 `TeamPlan`（roles + tasks + contracts + validationRules）
- 从 7 个内置 profile 闭集中选择角色（`role-profiles.ts:19-27`）
- 生成契约文件内容（projectManifest、openapi、dataModel、notes）
- 强制安排恰好一个 `e2e-verifier` 最终任务（`planner.ts:239-260`）
- 第一次 JSON 无效时自动 re-prompt 修复，第二次仍失败则终止 run（`planner.ts:445-473`）

**边界约束**（`planner.ts:121-125`）:

禁止 LLM 输出的字段: `allowedTools`, `systemPrompt`, `maxTurns`, `modelOverride`, `thinkingLevelOverride`
只能从闭集选择 profile: `project-setup | backend-engineer | data-engineer | frontend-engineer | test-engineer | e2e-verifier | docs-engineer`

**已知问题**: Planner 输出的 `validationRules` 字段**从未被 Validator 消费**（`validator.ts` 全部硬编码），浪费 LLM token。

### 1.2 TeamLead（确定性调度器，不是 LLM Agent）

**实现**: `src/team/team-lead.ts`，纯 TypeScript 类，无 LLM 调用。

**职责**:
- 调用 Planner 获取 `TeamPlan`
- 写入契约文件（`writeContracts`）
- 创建角色注册表（`createRoleRegistry`），把 Planner 的 RoleSpec 合成为运行时 `RoleDefinition`
- 构建任务 DAG 并按 `maxParallelAgents` 调度
- 为每个 task 构造任务描述（`buildTaskDescription`，lines 89-141）
- 配置 agent 的 beforeToolCall 钩子：ownership guard + bash safety guard
- 调用 Validator 做项目级验证
- 根据 validation issues 生成 repair tasks 并路由给 owner
- 在 `supervisionMode=milestone` 时调用 Supervisor
- 处理暂停、恢复、终止、审批、人工干预

**边界**:
- 不写业务代码
- 不主观判断产出质量——依赖 Validator、TaskResult、handoff、Supervisor
- 即使 Supervisor 请求修复，仍由 TeamLead 生成并调度 repair task

### 1.3 7 个 Worker Agent（LLM 执行 Agent）

**实现**: `src/agent/team-agent.ts`，每个 task 创建一个 `Agent` 实例（来自 `@mariozechner/pi-agent-core`）。

| Profile | 职责边界 | 工具集 | maxTurns | 代码位置 |
|---------|---------|--------|----------|---------|
| `project-setup` | 项目骨架、package/config/scripts/README | 全部 7 个 | 200 | `role-profiles.ts:30-42` |
| `backend-engineer` | API、路由、server、后端业务逻辑 | 全部 7 个 | 200 | `role-profiles.ts:43-55` |
| `data-engineer` | schema、持久化、seed data | 全部 7 个 | 200 | `role-profiles.ts:56-68` |
| `frontend-engineer` | UI、client state、浏览器端交互 | 全部 7 个 | 200 | `role-profiles.ts:69-81` |
| `test-engineer` | 单元/集成测试（不做最终 E2E） | 全部 7 个 | 200 | `role-profiles.ts:82-94` |
| `e2e-verifier` | 端到端验证，写 `docs/e2e-report.md` | 全部 7 个 | 200 | `role-profiles.ts:95-113` |
| `docs-engineer` | 文档、handoff notes | 无 bash | 200 | `role-profiles.ts:114-127` |

Worker 的 system prompt 由 `buildRoleSystemPrompt()` 生成（`system-prompts.ts:18-49`），包含：
- 角色描述 + profile 描述
- 协作契约指令（读 contracts、遵循 OpenAPI/dataModel）
- 权限模式指令（open vs owned）
- 执行模式指令（open vs restricted）
- profile-specific instructions + skillHints
- e2e-verifier 的特殊指令（启动本地服务器、只访问 localhost、上游失败时报告 suspectedOwnerTaskId）

**Worker 完成后写 handoff**（`team-agent.ts:188-208`）:

```json
{
  "taskId": "...",
  "changedFiles": [...],
  "contractsSatisfied": [...],
  "checksRun": [...],
  "knownRisks": [...]
}
```

**已知问题**:
- `contractsSatisfied` 在 success 时直接写 `"Task acceptance criteria reviewed by agent."`（`team-agent.ts:197`），不是真正校验
- Agent 的 `success` 判断基于"有输出或有文件改动"（`team-agent.ts:137-149`），不验证 expectedOutputs 是否存在

### 1.4 Supervisor（LLM 审查 Agent）

**实现**: `src/team/supervisor.ts`，通过 `completeSimple()` 调用 LLM 生成结构化 JSON。

**职责**:
- 在 `plan_created`、`task_end`、`validation_end`、`final_review` 四个里程碑审查
- 读取事实源：contracts、handoff、changed files（最多12个，每个12K截断）、validation issues、最近40个事件摘要
- 输出决策: `accept | warn | request_repair | request_human`
- 给 repair loop 提供 owner/file hint

**边界**:
- 不在 Planner 可选角色池里
- 不写代码、不调度 worker
- 只通过结构化 decision 影响现有流程
- 如果 Supervisor 本身调用失败，降级为 `warn` 继续运行（`team-lead.ts:594-613`）

## 2. Agent 之间怎么通信？怎么共享上下文？怎么避免互相打架？

### 2.1 通信方式——"共享事实源"模式

Agent 之间**没有直接消息通道**。通信通过四类共享介质：

```
用户需求
    |
    v
Planner → docs/contracts/*.json（契约文件）
    |
    v
TeamLead 为每个 task 构造 task description → 包含契约路径、owned paths、expected outputs
    |
    v
Worker Agent 读 contracts + 实际文件 → 写 handoff JSON
    |
    v
Validator + Supervisor 读 contracts + handoff + 实际文件 → 生成 issues
    |
    v
Repair tasks 路由回 owner agent
```

**① Task Description 注入**（`team-lead.ts:89-141`）

每个 worker 收到的任务描述包含：
- 原始需求
- Team plan summary
- 角色描述
- 任务 subject + description
- 所有 contract 文件路径（含 kind 和 required 标记）
- owned paths
- expected outputs
- acceptance criteria
- 自检要求（node --check、npm test 等）
- 人工干预记录
- 明确指令: "Do not rely on prior agent prose summaries. Use the contract files and the actual files in the workspace as source of truth."

**② 契约文件**（`planner.ts:481-487`）

| 文件 | 必要性 | 内容 |
|------|--------|------|
| `docs/contracts/team-plan.json` | 必须 | 角色、任务、依赖、验证规则 |
| `docs/contracts/project-manifest.json` | 必须 | 目标、特性、非功能需求、实现说明 |
| `docs/contracts/openapi.json` | 有API时必须 | API 路径、请求/响应 schema |
| `docs/contracts/data-model.json` | 有数据持久化时必须 | 实体、字段、关系 |
| `docs/contracts/notes.json` | 可选 | 风险、handoff 说明 |

**③ Handoff 文件**（`team-agent.ts:188-208`）

```
docs/agent-team/tasks/<taskId>-handoff.json
```

记录 changedFiles、checksRun（从 bash tool events 中提取的自检命令结果）、knownRisks。

**④ 事件流**（`types.ts:213-244`）

`TeamEvent` 是 17 种事件的联合类型，由 `TeamLead.emitEvent()` 分发给 TUI、ExecutionRecorder 和所有订阅者。事件按全局顺序记录，每个 task 有独立 JSONL 分片。

### 2.2 上下文压缩——Contract-Aware Transform

当 agent 消息超过 120 条时，触发 `createContractAwareTransformContext`（`team-agent.ts:213-244`）：
- 保留 system message
- 保留包含 `docs/contracts/`、`Contract files to read first:`、`Acceptance criteria:`、`Expected outputs:` 的消息
- 保留最近的消息
- 去重

这确保契约引用始终在上下文窗口内，但边界情况可能丢弃中间的重要消息（`architecture-audit.md` [M-1]）。

### 2.3 如何避免互相打架

**第一层: DAG 依赖**（`task-graph.ts` + `task-scheduler.ts`）
- `getReadyTasks()` 只返回所有依赖已完成且无失败依赖的任务
- `propagateFailure()` 从失败任务 BFS 级联标记所有下游为 failed

**第二层: 角色边界**
- Planner 给每个 task 指定 `ownedDirectories`
- `expectedOutputs` 描述该任务应交付什么
- `acceptanceCriteria` 明确验收条件

**第三层: 工具权限**
- `permissionMode=open`（默认）: ownedDirectories 只用于职责路由，不限制写路径
- `permissionMode=owned`: `file-ownership.ts` 的 guard 阻止 write/edit 到 ownedDirectories 外

**第四层: Bash 安全**（`bash-safety.ts`）
- 三级风险分类: safe / medium / high
- `approvalPolicy=minimal`（默认）: 只审批/阻断 high 风险
- high 包括: 命令替换 `$(...)`、`curl | bash`、`rm`、`chmod`、docker、外网 curl
- medium 包括: npm install、npx、npm run start/dev
- safe 包括: mkdir、test runner、localhost HTTP、e2e-verifier 的本地服务器生命周期

**第五层: Repair 路由**（`planner.ts:534-604`）

路由优先级:
1. `issue.ownerTaskId` → 直接匹配
2. `issue.file` → 按 task ownedDirectories 查最具体的 owner
3. `issue.ownerRole` → 按 role 名匹配
4. fallback → `plan.tasks[0]?.id`（有风险，见下方 [M-7]）

Repair task 的 DAG 保留（`planner.ts:576-580`）:
- root repair tasks（直接有 issue 的）保留原 dependencies 的 repair 版本
- downstream rerun tasks（无直接 issue，但因上游修了需要重跑）保留原 DAG 关系
- 这解决了之前 "repair 无 DAG" 的问题

**当前冲突风险**:
- 默认 `permissionMode=open` 下，多个并行 agent 可以写同一文件
- 除了 `docs-engineer` 无 bash 外，其余 6 个 profile 工具完全相同——职责隔离仅靠 prompt
- Bash 工具的 write 路径不受 ownership guard 保护（`architecture-audit.md` [H-5]）

## 3. 怎么做好测试验证，保证每个 Agent 的产出质量？

### 3.1 当前验证体系（5 层）

```
Layer 1: Worker 自检 (checksRun)          ← team-agent.ts
    ↓
Layer 2: Handoff 质量门                     ← validator.ts:721-773
    ↓
Layer 3: Validator 静态 + 运行时检查         ← validator.ts:775-820
    ↓
Layer 4: E2E Verifier 最终验证              ← role-profiles.ts:95-113
    ↓
Layer 5: Supervisor 语义审查（可选）         ← supervisor.ts
```

#### Layer 1: Worker 自检

**机制**: `extractChecksRunFromAgentEvents()`（`team-agent.ts:165-186`）从 agent 事件流中提取 bash 工具调用，只记录匹配 `isSelfCheckCommand()` 的命令。

**识别为自检的命令**（`team-agent.ts:113-121`）:
- `node --check`、`npm test/build/check`、`pnpm/yarn/bun test/build/check`
- `vitest`、`tsc`、`eslint`
- `npm/pnpm/yarn/bun install`
- `node -e "require(...)"` 形式的检查

**问题**:
1. Agent 的 `success` 判断不验证 expectedOutputs 是否存在（`team-agent.ts:137-149`）
2. Bash 命令被 `beforeToolCall` 阻断后，`event.isError` 可能为 false，导致 `exitCode=0` + `summary="(no output)"`——系统误认为检查通过

#### Layer 2: Handoff 质量门

**机制**: `validateTaskHandoffs()`（`validator.ts:721-773`）检查:
- 非 docs task 是否有 handoff JSON 文件
- 是否有 checksRun 且至少一个 `exitCode === 0`

**问题**:
- `handoff.contractsSatisfied` 是 agent 自述通用文本，不是真正校验
- handoff 审查的 severity 根据运行时检查结果动态调整（`validator.ts:816-817`）: 如果有运行时检查成功，handoff 缺失降级为 warning——可能掩盖问题

#### Layer 3: Validator 静态 + 运行时检查

`validateTeamOutputWithChecks()`（`validator.ts:775-820`）执行的检查:

| 检查类型 | 具体内容 | 代码位置 |
|---------|---------|---------|
| 契约存在 | 必需 contract 文件是否存在 | 594-608 |
| 产物存在 | 每个task的expectedOutputs（exact/glob/fuzzy三级匹配） | 609-636 |
| package.json | 有效 JSON + 至少一个有用 script | 638-658 |
| OpenAPI 路径 | 路径是否在项目源码中体现（3种模式匹配） | 660-676 |
| E2E 报告结构 | 包含 commands/exit status/observed result/acceptance status/evidence | 678-716 |
| E2E 状态路由 | 如果 acceptance status=FAIL，提取 suspectedOwnerTaskId/suspectedFile 生成路由 issue | 425-453, 713-715 |
| JS 语法检查 | `node --check` 所有 .js/.cjs/.mjs 文件（最多80个） | 573-592 |
| npm install | 有依赖但无 node_modules 时执行 | 515-523 |
| npm scripts | check/test/build scripts（检查安全性后执行） | 525-568 |
| Handoff 审查 | 非 docs task 必须有 handoff + 成功的 checksRun | 721-773 |

**Runtime check 失败处理**:
- 原生 addon 编译失败（node-gyp 等）降级为 warning，并提示使用纯 JS 替代方案（`validator.ts:459-492`）
- 首个 runtime check 失败即中断（`validator.ts:806-813`），不继续跑后续检查

#### Layer 4: E2E Verifier 最终验证

e2e-verifier 的特殊能力（`role-profiles.ts:104-113` + `bash-safety.ts:66-73`）:
- 允许启动本地服务器（`node app.js &`、`npm run start &`）——bash safety 为 e2e-verifier 放开本地服务器生命周期
- 只对 localhost/127.0.0.1 发 HTTP 请求
- 如果发现上游问题，报告 `suspectedOwnerTaskId` 或 `suspectedFile`——这是唯一的**上游反馈**机制
- 不修复上游业务代码

Validator 对 E2E 报告的路由（`validator.ts:425-453`）:
- 从报告中提取 `suspectedOwnerTaskId` 和 `suspectedFile`
- 有路由信息 → 生成带 `ownerTaskId` 的 issue，路由到上游 owner
- 无路由信息 → 标记 `needsSemanticRouting: true`，交给 Supervisor 语义路由

#### Layer 5: Supervisor 语义审查

上下文收集（`supervisor.ts:196-266`）:
- contracts 全文
- e2e reports 全文
- handoffs JSON
- changed files（最多12个，每个截断到12K字符）
- validation issues
- 最近40个事件摘要
- 所有 task result 摘要（output 截断到500字符）

Supervisor prompt 要求（`supervisor.ts:268-289`）:
- 不信任 worker prose，优先 concrete changed files、handoff JSON、checksRun
- e2e 失败要区分"测试脚本本身有问题"还是"上游实现有问题"
- 对 e2e 失败路由到上游 owner，不路由到 e2e-verifier
- 有 truncationWarnings 时降低判断信心

### 3.2 当前验证体系的关键缺陷

| # | 缺陷 | 代码证据 | 严重度 |
|---|------|---------|--------|
| 1 | **Agent 不验证自身 expectedOutputs** | `buildTaskResultFromAgentState`（`team-agent.ts:123-163`）只检查"有输出或有文件"，不检查 expectedOutputs 文件是否存在 | HIGH |
| 2 | **Bash 阻断后 exitCode 仍为 0** | `extractExitCode`（`team-agent.ts:98-104`）基于 `event.isError` 判断，`beforeToolCall` 阻断不触发 tool_execution_end | HIGH |
| 3 | **静态检查提前返回浪费轮次** | `validateTeamOutputWithChecks` 有静态 error 则跳过运行时检查（`validator.ts:775-820`）| MEDIUM |
| 4 | **validationRules 从未消费** | `plan.validationRules` 存在于 team-plan.json 但 validator.ts 从未读取 | MEDIUM |
| 5 | **npm scripts 任意代码执行** | `validator.ts:525-568` 直接执行 LLM 生成的 scripts，只检查 key 名称不检查内容；Windows 上用 `shell: true` | HIGH |
| 6 | **并行任务失败归因错误** | `Promise.allSettled` 后 `find(in_progress)` 可能匹配错误任务（`team-lead.ts:691-731`）| CRITICAL |
| 7 | **Repair fallback 到 tasks[0]** | `planner.ts:541` fallback `plan.tasks[0]?.id` 可能分配给无关 agent | MEDIUM |
| 8 | **parseInt NaN 导致无限循环** | `main.ts` 中 `parseInt("abc")` 得 NaN，`round >= NaN` 恒 false（`architecture-audit.md` [M-13]） | MEDIUM |
| 9 | **OpenAPI 路径段拼接误报** | `validator.ts:246-250` 第三种模式匹配过于宽松 | LOW |
| 10 | **Repair task ID 无去重** | 多个 issue fallback 到同一 originalTask 时，`repair-{round}-{task.id}` 可能重复（TaskGraph 会 throw） | HIGH |

### 3.3 改进建议（按优先级）

**P0（立即修复）**:

1. **Agent 完成时验证 expectedOutputs**: 在 `buildTaskResultFromAgentState` 中用 `existsSync` 检查 expectedOutputs 文件是否存在，缺失则 `success=false`
2. **Bash 阻断命令报告失败**: 在 `beforeToolCall` 返回 block 时，向 agent event 流注入一个 exitCode=1 的 tool_execution_end，确保 checksRun 正确反映阻断
3. **修复并行任务归因**: 维护 `taskId -> array index` 映射，通过索引定位 `Promise.allSettled` 结果（对应 `[C-1]`）

**P1（短期）**:

4. **让 validationRules 生效**: 定义 `ValidationRule` 接口，让 Validator 消费 `plan.validationRules` 中的自定义规则
5. **npm scripts 安全过滤**: 执行前检查脚本内容只含已知安全命令模式（vitest、tsc、eslint、biome、node），或在沙盒环境中执行
6. **静态+运行时检查合并**: 不因静态 error 跳过运行时检查，合并所有问题一次性返回，避免浪费修复轮次
7. **parseInt NaN 防护**: `main.ts` 解析后检查 `Number.isNaN()`，无效时报错退出
8. **Repair task ID 去重**: 在 `createRepairTasks` 中检查 `repairIdByOriginalId` 的值是否重复，重复时加后缀

**P2（中期）**:

9. **Agent profile 定义最低自测要求**: 如 backend 必须至少跑 `node --check`，在 role-profiles 的 instructions 中强化
10. **E2E 报告结构化**: JSON + Markdown 双产物，减少正则解析风险
11. **handoff.contractsSatisfied 真正校验**: 对应具体 contract path 和条目，而非通用文本
12. **Repair 历史跟踪**: 对同一 issue 的修复尝试记录历史，避免反复返工但无质量提升

### 3.4 测试覆盖现状

**已覆盖**（11 个测试文件）:

| 测试文件 | 被测模块 | 覆盖范围 |
|----------|---------|---------|
| `task-graph.test.ts` | `task-graph.ts` | 添加/检索、重复 ID、就绪任务、依赖阻塞、propagateFailure |
| `task-scheduler.test.ts` | `task-scheduler.ts` | maxParallel 槽位、依赖遵守、完成/失败检测 |
| `bash-safety.test.ts` | `bash-safety.ts` | 允许/阻止命令、风险分类 |
| `file-ownership.test.ts` | `file-ownership.ts` | 归属目录内外路径、精确匹配、嵌套路径 |
| `planner.test.ts` | `planner.ts` | 合约写入、依赖图、JSON repair、循环依赖检测、role profile 校验 |
| `team-lead.test.ts` | `team-lead.ts` | 完整编排事件序列、规划失败处理、repair loop |
| `team-runner.test.ts` | `team-runner.ts` | 事件持久化、任务分片、summary、mock runner 注入 |
| `execution-recorder.test.ts` | `execution-recorder.ts` | 事件写入、任务分片、敏感字段脱敏、summary 生成 |
| `team-tui.test.ts` | `team-tui.ts` | TUI 组件事件处理、任务表渲染、状态更新、宽度截断 |
| `validator.test.ts` | `validator.ts` | 缺失输出、OpenAPI 路径、运行时检查 |
| `role-profiles.test.ts` | `role-profiles.ts` | 预设角色 profile 注册表 |

**未覆盖的高风险模块**:

| 模块 | 风险 | 缺失测试 |
|------|------|---------|
| `team-agent.ts` | **高** | Agent 构造器、轮次强制、上下文压缩、expectedOutputs 验证、exitCode 提取 |
| `tool-pool.ts` | **中** | 工具池是每个 Agent 的单点故障 |
| `config.ts` | **中** | 配置加载和合并逻辑 |
| `system-prompts.ts` | **中** | 系统提示模板生成 |
