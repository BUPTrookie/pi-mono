# agent-team 项目状态

> 最近更新: 2026-06-01

## 项目定位

`packages/agent-team`（`@mariozechner/pi-agent-team`）是项目级多 Agent 编排器。它不实现底层单 Agent 循环，而是把用户需求交给 Lead/Planner 做全局理解，再把规划结果转成可执行任务图、共享契约、验证和返工流程。

当前定位是"队长制 + 动态派工 + 契约协作"。队长的全局判断是智能来源；契约只是把队长的规划结果固化成 worker agent 都能读取、引用、校验的共享事实，避免 agent 之间依赖截断摘要或隐式猜测。

旧的固定 6 Agent 工作流已经删除，不再保留 `pm | architect | db-engineer | backend | frontend | devops` 作为闭合流程，也不保留 `fixed` 兼容模式。

## 当前架构

入口：

- **CLI（推荐）**：`node dist/main.js "你的需求描述"` — 需求作为位置参数，其余配置在 `agent-team.json` 中管理。
- **TUI 模式**：加 `--interactive` 启动终端交互视图，支持暂停(p)、审批(a/r)、终止(ctrl+c)。
- `runTeam(config)`：简单 Promise 入口，内部调用 `createTeamRun(config).start()`。
- `createTeamRun(config, overrides?)`：返回可订阅、可暂停、可审批、可人工干预的 `TeamRun`。`overrides` 支持注入 mock runner 用于测试。

配置文件发现顺序：`--config <path>` > `./agent-team.json` > `~/.pi/agent-team.json`。典型配置文件：

```json
{
  "outputDir": "./output",
  "model": { "provider": "openai", "model": "gpt-4o", "apiKey": "sk-xxx" },
  "maxParallelAgents": 2,
  "thinkingLevel": "off",
  "maxRepairRounds": 2
}
```

CLI 参数仅用于一次性覆盖，不建议在命令行传递 `--api-key`、`--model` 等。改配置去改配置文件。

核心流程：

1. `TeamRun.start()` 创建输出目录、初始化执行记录器（`ExecutionRecorder`）、解析模型、初始化控制状态。
2. `TeamLead` 调用 `llmPlannerRunner`，由 LLM 生成完整 `PlannerResult`。
3. `writeContracts()` 只写入 LLM 输出的契约：`team-plan.json`、`project-manifest.json`，以及可选的 `openapi.json`、`data-model.json`、`notes.json`。
4. `TaskGraph` / `TaskScheduler` 根据 `TeamPlan.tasks` 执行动态 DAG。
5. 每个 worker 的任务说明都引用契约路径、owned paths、expected outputs 和 acceptance criteria。
6. Validator 基于契约和产物做轻量静态验证 + 运行时验证。
7. 如果存在阻塞 issue，Lead 生成 repair tasks 并路由给 owner agent，默认最多 2 轮。
8. 全流程通过 `TeamEvent` 输出结构化事件，CLI/TUI/WebUI 复用同一事件层和控制 API。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 动态角色、`TeamPlan`、`PlannerResult`、`TeamEvent`、`TeamRun`、验证和 repair 类型 |
| `src/team/planner.ts` | LLM Planner、planner JSON 校验（含循环依赖检测）、契约写入、repair task 生成 |
| `src/team/team-lead.ts` | 队长调度、事件、规划失败处理、验证和返工主循环 |
| `src/team/team-runner.ts` | `createTeamRun()` / `runTeam()`、模型解析、暂停/审批/干预控制、依赖注入（`TeamRunOverrides`） |
| `src/team/execution-recorder.ts` | 事件持久化：JSONL 事件流 + 按任务分片 + run-summary.md |
| `src/team/validator.ts` | 契约、产物、OpenAPI、package scripts 的轻量验证 |
| `src/agent/team-agent.ts` | 单 agent 运行时、事件转发、契约感知任务上下文 |
| `src/agent/bash-safety.ts` | bash 安全策略和审批请求 |
| `src/tui/team-tui.ts` | TUI 运行视图：任务状态表、验证轮次、审批交互、日志滚动 |

## 已解决的问题

- 固定 6 Agent 管道已删除，角色和任务完全来自 `TeamPlan`。
- PM 不再作为默认执行 agent，需求澄清和全局把握并入 Lead/Planner。
- Planner 不再使用关键词、领域模板或 fallback OpenAPI 生成业务契约。
- 规划失败策略改为显式失败：第一次 LLM JSON 无效会自动 repair 一次，第二次仍失败则终止 run，不生成伪造的通用业务 fallback。
- Agent 协作从"截断前序输出"改为"契约文件 + 实际文件"为事实来源。
- `runTeam()` 保持简单入口，同时新增 `TeamRun` 事件和控制 API。
- `bash` 安全策略已收窄到危险删除、依赖安装、Docker build/up、长驻服务启动等高风险命令，允许 `mkdir`、`touch`、`cp`、`mv` 等正常项目构建命令。
- DevOps 式任务不再要求 `npm install && npm start`。
- 模型解析保留 `ModelRegistry` 路径，并继续防御 custom `baseUrl + openai provider` 兼容端点。
- **循环依赖检测已实现** — `validateAcyclicTasks()` 使用标准 DFS 环检测，planner.test.ts 有对应测试。
- **执行事件持久化已实现** — `ExecutionRecorder` 将所有 `TeamEvent` 写入 `docs/agent-team/events.jsonl`（全局流）和 `docs/agent-team/tasks/<taskId>.jsonl`（按任务分片），完成后生成 `run-summary.md`。敏感字段（apiKey/token/secret）自动脱敏。
- **TUI 运行视图已增强** — 任务状态表、验证轮次/issue 计数、model 信息、审批交互、最近日志。
- **TeamRun 依赖注入** — `TeamRunOverrides` 支持注入 mock planner/agent/validator/recorder，测试覆盖 team-runner 和 team-lead。
- **CLI 已简化** — 需求作为位置参数，配置通过 `agent-team.json` 管理，不再需要在命令行传一堆参数。

## 当前已知问题摘要

> 完整缺陷列表见 `docs/architecture-audit.md` 第 5 节。

| 严重度 | 关键问题 |
|--------|---------|
| CRITICAL | 并行任务失败归因错误（Promise.allSettled 后 find(in_progress) 匹配错误任务） |
| HIGH | npm scripts 任意代码执行（validator 执行 LLM 生成的 package.json scripts 无清洗） |
| HIGH | 中止原因误归因、provider/model API Key 注册跳过、硬编码角色名 |
| HIGH | Bash 安全缺口、文件归属守卫不覆盖 bash、核心模块无测试 |
| MEDIUM | parseInt NaN 导致无限修复循环、静态检查提前返回浪费修复轮次 |
| MEDIUM | systemPrompt 注入、ownedDirectories "." 破坏隔离、repair task 路由到 plan.tasks[0] |
| MEDIUM | getApiKey 忽略 provider 参数、validationRules 从未消费 |

## 仍需后续增强

- **安全加固**：npm scripts 清洗/沙盒、bash 安全模式补全、文件归属覆盖 bash 写路径。
- **Validator 增强**：后续需要增强 AST/OpenAPI/router/client 对齐、可配置运行时验证选项。
- **TUI 体验**：已实现任务状态表和审批交互，后续应增强 spinner（planning 等待反馈）、任务状态着色（绿/红/黄）、日志分页滚动、审批详情卡片（显示完整命令）、agent 工具调用实时展示。
- **WebUI**：尚未实现，但架构上可复用 `TeamRun` / `TeamEvent`。
- **执行持久化**：事件流已实现（`ExecutionRecorder`），但 `content` 字段被脱敏为 `[redacted]`，无法用于回放 agent 写入内容。需确认设计意图：日志用于审计还是调试回放？
- **断点续跑**：尚未接入 `SessionManager`。
- **Planner 增强**：可接入 provider-specific structured output，但不引入业务领域模板 fallback。
- **公共 API 清理**：移除遗留导出、补齐类型导出、去重双重导出。

## 测试覆盖

- `planner.test.ts`：LLM 输出解析、契约写入、JSON repair、规划失败、依赖和路径校验、循环依赖检测。
- `bash-safety.test.ts`：允许正常项目文件操作，阻断危险命令。
- `validator.test.ts`：缺失产物和 OpenAPI 不一致检测。
- `team-lead.test.ts`：注入 fake planner/agent 后的事件顺序、repair loop、规划失败不启动 worker。
- `team-runner.test.ts`：注入 mock planner/agent/validator/recorder，验证事件持久化、任务分片、成功/失败 summary 生成。
- `execution-recorder.test.ts`：事件写入、按任务分片、敏感字段脱敏、run-summary.md 生成。
- `team-tui.test.ts`：TUI 组件事件处理、任务表渲染、状态更新、宽度截断。
- `task-graph.test.ts` / `task-scheduler.test.ts`：动态 DAG 和调度基础能力。
- `file-ownership.test.ts`：归属目录内外路径、精确匹配、嵌套路径。
- `role-profiles.test.ts`：预设角色 profile 注册表。

### 缺口

- `team-agent.ts`：Agent 构造器、轮次强制、上下文压缩未测。
- `tool-pool.ts`：工具池构建逻辑未测。
- `config.ts`：配置加载和合并逻辑未测。
