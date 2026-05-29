# agent-team 项目状态

## 项目定位

`packages/agent-team`（`@mariozechner/pi-agent-team`）是项目级多 Agent 编排器。它不实现底层单 Agent 循环，而是把用户需求交给 Lead/Planner 做全局理解，再把规划结果转成可执行任务图、共享契约、验证和返工流程。

当前定位是“队长制 + 动态派工 + 契约协作”。队长的全局判断是智能来源；契约只是把队长的规划结果固化成 worker agent 都能读取、引用、校验的共享事实，避免 agent 之间依赖截断摘要或隐式猜测。

旧的固定 6 Agent 工作流已经删除，不再保留 `pm | architect | db-engineer | backend | frontend | devops` 作为闭合流程，也不保留 `fixed` 兼容模式。

## 当前架构

入口：

- `runTeam(config)`：简单 Promise 入口，内部调用 `createTeamRun(config).start()`。
- `createTeamRun(config)`：返回可订阅、可暂停、可审批、可人工干预的 `TeamRun`。
- `agent-team --interactive`：启动基于 `pi-tui` 的首版运行视图。

核心流程：

1. `TeamRun.start()` 创建输出目录、解析模型、初始化控制状态。
2. `TeamLead` 调用 `llmPlannerRunner`，由 LLM 生成完整 `PlannerResult`。
3. `writeContracts()` 只写入 LLM 输出的契约：`team-plan.json`、`project-manifest.json`，以及可选的 `openapi.json`、`data-model.json`、`notes.json`。
4. `TaskGraph` / `TaskScheduler` 根据 `TeamPlan.tasks` 执行动态 DAG。
5. 每个 worker 的任务说明都引用契约路径、owned paths、expected outputs 和 acceptance criteria。
6. Validator 基于契约和产物做轻量静态验证。
7. 如果存在阻塞 issue，Lead 生成 repair tasks 并路由给 owner agent，默认最多 2 轮。
8. 全流程通过 `TeamEvent` 输出结构化事件，CLI/TUI/WebUI 复用同一事件层和控制 API。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 动态角色、`TeamPlan`、`PlannerResult`、`TeamEvent`、`TeamRun`、验证和 repair 类型 |
| `src/team/planner.ts` | LLM Planner、planner JSON 校验、契约写入、repair task 生成 |
| `src/team/team-lead.ts` | 队长调度、事件、规划失败处理、验证和返工主循环 |
| `src/team/team-runner.ts` | `createTeamRun()` / `runTeam()`、模型解析、暂停/审批/干预控制 |
| `src/team/validator.ts` | 契约、产物、OpenAPI、package scripts 的轻量验证 |
| `src/agent/team-agent.ts` | 单 agent 运行时、事件转发、契约感知任务上下文 |
| `src/agent/bash-safety.ts` | bash 安全策略和审批请求 |
| `src/tui/team-tui.ts` | 首版 TUI 运行视图 |

## 已解决的问题

- 固定 6 Agent 管道已删除，角色和任务完全来自 `TeamPlan`。
- PM 不再作为默认执行 agent，需求澄清和全局把握并入 Lead/Planner。
- Planner 不再使用关键词、领域模板或 fallback OpenAPI 生成业务契约。
- 规划失败策略改为显式失败：第一次 LLM JSON 无效会自动 repair 一次，第二次仍失败则终止 run，不生成伪造的通用业务 fallback。
- Agent 协作从“截断前序输出”改为“契约文件 + 实际文件”为事实来源。
- `runTeam()` 保持简单入口，同时新增 `TeamRun` 事件和控制 API。
- `bash` 安全策略已收窄到危险删除、依赖安装、Docker build/up、长驻服务启动等高风险命令，允许 `mkdir`、`touch`、`cp`、`mv` 等正常项目构建命令。
- DevOps 式任务不再要求 `npm install && npm start`。
- 模型解析保留 `ModelRegistry` 路径，并继续防御 custom `baseUrl + openai provider` 兼容端点。

## 仍需后续增强

- Validator 仍是轻量静态验证，后续需要增强 AST/OpenAPI/router/client 对齐。
- TUI 是首版运行视图，后续应增强 steering 输入、任务详情面板、issue 定位和审批体验。
- WebUI 尚未实现，但架构上可复用 `TeamRun` / `TeamEvent`。
- 会话持久化和断点续跑尚未接入 `SessionManager`。
- Planner 首版依赖普通 LLM JSON 输出，后续可以接入 provider-specific structured output，但不能引入业务领域模板 fallback。

## 测试覆盖

- `planner.test.ts`：LLM 输出解析、契约写入、JSON repair、规划失败、依赖和路径校验。
- `bash-safety.test.ts`：允许正常项目文件操作，阻断危险命令。
- `validator.test.ts`：缺失产物和 OpenAPI 不一致检测。
- `team-lead.test.ts`：注入 fake planner/agent 后的事件顺序、repair loop、规划失败不启动 worker。
- `task-graph.test.ts` / `task-scheduler.test.ts`：动态 DAG 和调度基础能力。
