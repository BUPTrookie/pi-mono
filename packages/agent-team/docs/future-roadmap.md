# agent-team 后续路线图

> 版本: 0.65.2 | 更新: 2026-06-02




---

## P0：让系统可靠地工作

>
> 核心思路：解决最多的失败，用最少的改动。

### P0-1 交互式规划审查

**解决的问题**：36% 的失败（8/22）发生在规划阶段——LLM 生成的 JSON 不满足 e2e-verifier 依赖约束、ownedDirectories 校验等。

**现状**：Planner 输出 JSON → 代码校验 → 失败则自动 re-prompt → 再失败就终止 run。用户无法干预。

**方案**：在 `plan_created` 之后加一个可选的暂停 checkpoint，允许用户在 TUI 中审查和修改计划。

**具体改动**：

1. `TeamConfig` 新增 `autoApprovePlan: boolean`（默认 `true`，保持向后兼容）
2. `team-lead.ts` 的 `orchestrateRun()` 在 `plan_created` 后检查配置：
   - `autoApprovePlan=false` → emit `plan_review_requested` 事件 → 暂停等待用户确认
   - `autoApprovePlan=true`（默认）→ 直接继续
3. TUI 在 `plan_review_requested` 时展示计划摘要，提供操作：
   - `Enter` 确认执行
   - `e` 编辑（打开 team-plan.json 在编辑器中）
   - `r` 重新规划
   - `q` 放弃
4. 用户确认后 emit `plan_approved` 事件继续

**涉及文件**：
- `src/types.ts` — 新增 `TeamConfig.autoApprovePlan`，新增 `TeamEvent` 类型 `plan_review_requested` / `plan_approved`
- `src/team/team-lead.ts` — `orchestrateRun()` 中 `plan_created` 后加审查逻辑
- `src/tui/team-tui.ts` — 处理新事件的 TUI 渲染

**成功指标**：Planning 阶段失败从 8 次降到 2 次以下。

---

### P0-2 Agent 完成时验证 expectedOutputs

**解决的问题**：27% 的失败（6/22）源于 Agent 自报成功但关键产物不存在。例如 setup agent 报告完成但 package.json 没写入。

**现状**：`buildTaskResultFromAgentState()`（`team-agent.ts:123-163`）判定 success 只看"有输出文本或有文件改动"，不检查 expectedOutputs 文件是否存在。

**方案**：在 `buildTaskResultFromAgentState` 中增加 expectedOutputs 存在性检查。

**具体改动**：

1. `buildTaskResultFromAgentState` 新增参数 `expectedOutputs?: string[]` 和 `outputDir?: string`
2. 如果提供了这两个参数，遍历 `expectedOutputs`，对非 glob 模式的路径用 `existsSync` 检查
3. 如果有缺失的 expectedOutput：
   - `success = false`
   - `error = "Agent completed but missing expected outputs: package.json, README.md"`
4. `runPrompt` 调用处传入 `task.expectedOutputs` 和 `outputDir`

**涉及文件**：
- `src/agent/team-agent.ts` — `buildTaskResultFromAgentState` 加 expectedOutputs 检查

**成功指标**："setup did not produce expected output: package.json" 类错误在首次执行阶段就被捕获，不再浪费下游任务。

---

### P0-3 Bash 阻断后正确报告失败

**解决的问题**：bash 命令被 `beforeToolCall` 阻断后，`tool_execution_end` 的 `event.isError` 可能为 false，导致 `extractExitCode` 返回 0，`checksRun` 误判为通过。

**现状**：`beforeToolCall` 返回 `{block: true, reason: "..."}` 后，Agent 框架把这个结果作为 tool result 返回给 LLM，但不会触发 `tool_execution_end` 事件。如果被阻的命令被 `isSelfCheckCommand()` 识别（如 npm install），它会出现在 `commandsById` Map 中但不会有对应的 `tool_execution_end`——也就不会出现在 checksRun 里。

**方案**：区分两种情况处理。

**具体改动**：

1. 在 `team-agent.ts` 的 `beforeToolCall` 回调中，当 bash 被阻断时，主动向 `events` 数组注入一个模拟的失败记录：
   ```typescript
   if (bashResult?.block && context.toolCall.name === "bash") {
     const command = (context.args as { command?: string }).command ?? "";
     if (isSelfCheckCommand(command)) {
       // 注入失败记录，确保 extractChecksRunFromAgentEvents 能捕获
       events.push({
         type: "tool_execution_start",
         toolCallId: context.toolCallId,
         toolName: "bash",
         args: context.args,
       });
       events.push({
         type: "tool_execution_end",
         toolCallId: context.toolCallId,
         toolName: "bash",
         result: `Blocked: ${bashResult.reason}`,
         isError: true,
       });
     }
   }
   ```
2. 或者更简单的方案：让 `extractExitCode` 对 `isError` 为 false 但 result 文本包含 "Blocked" 的情况返回非零 exitCode。

**涉及文件**：
- `src/agent/team-agent.ts` — `beforeToolCall` 回调或 `extractExitCode`

**成功指标**：被阻断的 bash 命令不再出现在 checksRun 中标记为 exitCode=0。

---

## P1：系统性改进

> 预期：成功率 ~50% → ~65%

### P1-1 两阶段规划

**解决的问题**：Planner 一次调用要同时做架构决策（角色、任务、依赖）和详细设计（OpenAPI、data model、project manifest），输出量大且约束多，LLM 经常顾此失彼。

**现状**：一个 `completeSimple()` 调用输出完整 JSON，包含 roles、tasks、contracts 全部内容。

**方案**：拆成两个阶段。

**阶段 1 — 架构规划**：

输入：用户需求 + role profiles 列表
输出：`TeamPlan`（只有 roles + tasks + dependencies + validationRules），不含契约
校验：约束检查（循环依赖、e2e-verifier、路径安全等）
重试：阶段 1 失败则 re-prompt，最多 2 次

**阶段 2 — 契约生成**：

输入：已验证的 TeamPlan + 用户需求
输出：`GeneratedContracts`（projectManifest + openapi + dataModel + notes）
每个契约独立生成（openapi 一次调用、dataModel 一次调用），失败可以单独重试

**涉及文件**：
- `src/team/planner.ts` — 拆分 `plannerSystemPrompt` 为两个 prompt，拆分 `llmPlannerRunner`
- `src/types.ts` — 可能新增 `ArchitecturePlan` 中间类型

**成功指标**：Planning 阶段失败率进一步降低。架构约束（e2e-verifier 依赖、ownedDirectories）在阶段 1 就被捕获。

---

### P1-2 修复上下文管理

**解决的问题**：修复轮次复用同一个 Agent 会话，长上下文导致 LLM 行为退化——出现 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` 错误。

**现状**：`TeamLead.taskSessions` Map 用 `originalTaskId` 做 key，所有尝试（initial/continue/rerun）共享同一个 Agent 实例。

**方案**：根据上下文长度决定是否创建新实例。

**具体改动**：

1. 在 `runAgentAttempt` 中，检查当前 session 的消息数：
   - 如果 `session.messages.length < 80` → 复用会话，`continueWith()`
   - 如果 `session.messages.length >= 80` → 创建新 session，用 `prompt()` 注入摘要
2. 摘要内容：之前做了什么（handoff 的 changedFiles + checksRun）、这次需要修什么（repair task 的 description）
3. 旧 session 的 events 合并到新 session 的 events 数组中

**涉及文件**：
- `src/team/team-lead.ts` — `runAgentAttempt()` 加上下文长度判断
- `src/agent/team-agent.ts` — 新增 `session.getMessagesCount()` 或暴露 messages 长度

**成功指标**：修复轮次不再出现 tool message ordering 错误。

---

### P1-3 模型路由

**解决的问题**：所有 Agent 用同一个模型，成本高且不灵活。docs-engineer 不需要最强模型，Planner 需要。

**现状**：`RoleDefinition` 已声明 `modelOverride` 和 `thinkingLevelOverride`，但 `roleFromSpec()` 从不设置，`runTasks()` 从不读取。

**方案**：启用已有的 `modelOverride` 字段。

**具体改动**：

1. `TeamConfig` 新增 `roleModelOverrides`：
   ```typescript
   roleModelOverrides?: Record<string, { provider?: string; model: string }>;
   ```
2. `createRoleRegistry`（`planner.ts`）中，对每个 role 检查是否有 override，有则设置 `modelOverride`
3. `team-lead.ts` 的 `runTasks()` 中，构建 `agentConfig` 时，如果 `role.modelOverride` 存在，用它解析一个单独的模型：
   ```typescript
   const taskModel = role.modelOverride
     ? resolveModel(modelRegistry, role.modelOverride.provider, role.modelOverride.model, baseUrl)
     : this.model;
   ```
4. Planners 和 Supervisor 的模型不受影响（始终用全局模型）

**涉及文件**：
- `src/types.ts` — `TeamConfig` 加 `roleModelOverrides`
- `src/team/planner.ts` — `roleFromSpec()` 加 override 处理
- `src/team/team-lead.ts` — `runTasks()` 中用 taskModel 替代 this.model
- `src/team/team-runner.ts` — 把 `roleModelOverrides` 传给 TeamLead

**成功指标**：docs-engineer 和 test-engineer 用便宜模型时，token 成本降低 30%+。

---

### P1-4 parseInt NaN 防护 + 并行归因修复

**解决的问题**：两个已知的 CRITICAL/HIGH bug，直接影响可靠性。

**具体改动**：

1. `main.ts` 的 `parseArgs` 中，parseInt 后检查 `Number.isNaN()`，无效时报错退出：
   ```typescript
   const parsed = parseInt(args[++i], 10);
   if (Number.isNaN(parsed)) {
     console.error(`Error: ${arg} expects a number, got "${args[i]}"`);
     process.exit(1);
   }
   ```
2. `team-lead.ts` 的 `runTasks()` 中，维护 `taskId → array index` 映射，通过索引定位 `Promise.allSettled` 结果，而不是用 `find(in_progress)`

**涉及文件**：
- `src/main.ts` — parseInt 校验
- `src/team/team-lead.ts` — Promise.allSettled 结果归因

**成功指标**：消除 NaN 导致的无限循环和并行任务归因错误。

---

## P2：质量体系升级

> 预期：成功率 ~65% → ~80%

### P2-1 错误分类驱动修复

**解决的问题**：当前修复是"复制原任务 + 附加错误信息 + 重跑整个 Agent"。但很多错误不需要重跑——文件缺失、语法错误、测试失败各有不同的最优修复策略。

**现状**：`createRepairTasks()` 对所有 error 级 issue 统一生成 repair task，behavior 完全相同。

**方案**：按错误类型选择修复策略。

**分类**：

| 错误模式 | 修复策略 | 需要 Agent? |
|---------|---------|------------|
| expectedOutput 文件缺失 | 只把缺失文件列表告诉 Agent，不需要完整 rerun | 是，但缩小范围 |
| `node --check` 语法错误 | 只把出错文件发给 Agent 修复 | 是，但只给出错文件 |
| `npm test` 失败 | 把失败测试和被测代码发给 Agent | 是，但缩小范围 |
| E2E 报告缺关键词 | 局部修改 e2e-report.md | 可能不需要 Agent，直接修改 |
| 上下文损坏 | 新建 Agent 实例 | 是，必须新建 |
| 契约缺失 | 不需要 Agent，planner 重跑即可 | 否 |

**具体改动**：

1. `ValidationIssue` 新增 `repairStrategy?: "full-rerun" | "targeted-fix" | "no-agent"`
2. Validator 在生成 issue 时标注策略
3. `createRepairTasks` 根据策略生成不同的 repair task：
   - `full-rerun`：当前行为
   - `targeted-fix`：只把相关文件和错误信息作为 task description
   - `no-agent`：代码直接处理（如创建缺失的空文件）

**涉及文件**：
- `src/types.ts` — `ValidationIssue` 加 `repairStrategy`
- `src/team/validator.ts` — 生成 issue 时标注策略
- `src/team/planner.ts` — `createRepairTasks` 按策略分治

**成功指标**：修复轮次平均消耗的 token 减少 40%+。

---

### P2-2 行为验证框架

**解决的问题**：e2e-verifier 经常只做静态分析，不启动服务、不发请求。E2E 报告的关键词检查用正则，不验证实际行为。

**现状**：e2e-verifier 是纯 LLM agent，行为完全取决于 prompt 和 LLM 的遵守程度。

**方案**：从 OpenAPI contract 自动生成验证脚本，e2e-verifier 的角色从"自由验证"变成"执行脚本 + 补充探索"。

**具体改动**：

1. 新增 `src/team/test-generator.ts`：
   - 读取 `docs/contracts/openapi.json`
   - 为每个路径+方法生成一个 `curl` 命令序列
   - 写入 `tests/e2e-generated.sh`
2. e2e-verifier 的 task description 中加入：
   - "先执行 tests/e2e-generated.sh 中的所有命令"
   - "然后补充自由探索测试场景"
3. Validator 的 E2E 检查从正则关键词改为：
   - 检查 e2e-generated.sh 中的每个命令是否在报告中出现
   - 检查每个命令的 exitCode 是否为 0

**涉及文件**：
- 新增 `src/team/test-generator.ts`
- `src/team/planner.ts` — e2e-verifier task 的 description 注入验证脚本指令
- `src/team/validator.ts` — E2E 检查逻辑增强

**成功指标**：E2E 报告包含实际运行时证据的比例从 <50% 提升到 >90%。

---

### P2-3 契约-实现对齐（AST 级）

**解决的问题**：当前 OpenAPI 路径检查用文本匹配（`projectText.includes(collapsed)`），存在大量误报和漏报。

**现状**：`isOpenApiPathRepresented()`（`validator.ts:236-253`）用三种模式匹配，第三种"段拼接"（如 `polls/votes` 会在源码任意位置匹配）过于宽松。

**方案**：用 AST 解析 Express 路由定义，提取实际路由。

**具体改动**：

1. 新增 `src/team/route-extractor.ts`：
   - 扫描项目源码中的 `app.get/post/put/delete/patch`、`router.get/post/...` 调用
   - 用正则或简单 AST 提取路由路径字符串
   - 返回 `{ method, path }[]`
2. `validator.ts` 的 OpenAPI 路径检查改为：
   - 从实现中提取路由 → `extractRoutes(projectSource)`
   - 从 OpenAPI 中提取期望路由 → `getOpenApiPaths()`
   - 逐条比较：路径是否匹配（考虑 `:param` vs `{param}` 差异）、HTTP 方法是否一致
   - 报告具体缺失的路由

**涉及文件**：
- 新增 `src/team/route-extractor.ts`
- `src/team/validator.ts` — 替换 `isOpenApiPathRepresented`

**成功指标**：OpenAPI 路径匹配的误报率降到 0%。

---

### P2-4 静态+运行时检查合并

**解决的问题**：当前静态检查发现 error 后，运行时检查被跳过，浪费修复轮次。

**现状**：`validateTeamOutputWithChecks()` 先跑静态检查（`validateTeamOutput`），再跑运行时检查。静态检查的 error 会导致 handoff severity 升级为 error，但运行时检查的结果会被合并。

**方案**：始终运行运行时检查，合并所有问题一次性返回。

**具体改动**：

1. 调整 `validateTeamOutputWithChecks` 的执行逻辑：
   - 并行启动静态检查和运行时命令收集
   - 先执行运行时命令（不管静态结果如何）
   - 最后合并所有 issue

**涉及文件**：
- `src/team/validator.ts` — `validateTeamOutputWithChecks` 流程调整

**成功指标**：每轮修复发现的问题更完整，减少"修了 A 又发现 B"的多轮浪费。

---

## P3：能力扩展

> 预期：开启新使用场景，持续改善可靠性

### P3-1 增量开发

**场景**：用户在上次生成的项目基础上继续开发。

**方案**：

1. `TeamConfig` 新增 `baseOutputDir?: string`——指定上次运行的项目目录
2. Planner 收到增量需求时，加载上次的 `team-plan.json` 和项目文件
3. 生成 delta plan：只包含需要变更的任务，复用已有契约
4. 执行时跳过未变更的任务，只执行新增/修改的任务

**关键挑战**：
- 如何判断哪些已有任务需要重跑
- 如何处理跨任务的依赖变更
- 如何保证增量变更不破坏已有功能

---

### P3-2 失败模式库

**场景**：系统从历史运行中学习常见失败模式，Planner 规划时主动规避。

**方案**：

1. 每次运行结束后，`ExecutionRecorder.finish()` 提取结构化特征：
   - expectedOutputs 缺失率
   - 每个 role 的 success rate
   - validation issue 类别分布
   - repair 成功率
2. 写入 `~/.pi/agent-team-history.json`（跨运行持久化）
3. Planner 的 system prompt 注入历史模式：
   - "In past 10 runs, setup tasks failed when expectedOutputs included package-lock.json. Prefer only package.json."
   - "e2e-verifier tasks that don't start the server always fail. Always include explicit start instructions."

**关键挑战**：
- 数据量需要积累到一定程度才有统计意义
- 需要按项目类型分类（Express 项目的模式和 React 项目不同）

---

### P3-3 Plan 模板

**场景**：常见项目类型不需要从零规划，可以基于模板填充。

**方案**：

1. 新增 `src/team/plan-templates.ts`，预定义常见项目类型的模板：
   - `rest-api-express`：setup + backend + data + test + e2e + docs
   - `static-web-app`：setup + frontend + test + e2e + docs
   - `cli-tool`：setup + backend + test + e2e + docs
2. Planner 的 prompt 注入匹配的模板：
   - "检测到需求是 REST API 项目，参考以下模板角色和依赖关系：..."
3. Planner 只需要填充具体参数（API 端点、数据字段），不需要规划整体架构

---

### P3-4 可观测系统

**场景**：用户能看到 Agent 的推理过程和决策链，不只是最终结果。

**方案**：

1. Agent 思维链提取：从 agent events 中提取结构化的决策点（读了哪些契约、写了哪些文件、为什么）
2. 实时质量仪表盘：TUI 展示 expectedOutputs 完成率、checksRun 通过率、上下文窗口使用率
3. 运行比较工具：对比两次运行的 plan 和结果，给出结构化 diff

---

### P3-5 修复预算

**场景**：不同任务的修复价值不同，应该分配不同的修复预算。

**方案**：

1. 按任务重要性分级：
   - 关键任务（setup、backend）：最多 3 轮修复
   - 普通任务（frontend、data）：最多 2 轮
   - 辅助任务（docs）：最多 1 轮，或直接跳过修复
2. 按错误严重度分级：
   - 文件完全缺失：必须修复
   - 文件内容不完整：尝试修复
   - lint/style 问题：可以跳过
3. 修复成本估算：根据错误类型和任务复杂度，估算修复需要的 token，超过阈值则放弃

---

## 实施顺序总览

```
Phase P0（~1 周，成功率 → ~50%）
  ├── P0-1 交互式规划审查
  ├── P0-2 Agent 验证 expectedOutputs
  └── P0-3 Bash 阻断正确报告失败

Phase P1（~2 周，成功率 → ~65%）
  ├── P1-1 两阶段规划
  ├── P1-2 修复上下文管理
  ├── P1-3 模型路由
  └── P1-4 parseInt + 并行归因 bug 修复

Phase P2（~3 周，成功率 → ~80%）
  ├── P2-1 错误分类驱动修复
  ├── P2-2 行为验证框架
  ├── P2-3 契约-实现对齐（AST）
  └── P2-4 静态+运行时检查合并

Phase P3（持续）
  ├── P3-1 增量开发
  ├── P3-2 失败模式库
  ├── P3-3 Plan 模板
  ├── P3-4 可观测系统
  └── P3-5 修复预算
```
