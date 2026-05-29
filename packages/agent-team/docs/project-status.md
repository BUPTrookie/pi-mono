# agent-team 项目状态

## 项目定位

`packages/agent-team`（`@mariozechner/pi-agent-team`）是基于 `pi-agent-core`、`pi-ai`、`pi-coding-agent` 的项目级多 Agent 交付编排器。它的职责不是实现底层 Agent 循环，而是把用户需求转成可执行的团队计划、结构化契约、动态任务图、验证和返工流程。

当前版本已经删除旧的固定 6 Agent 管道，不再内置 `PM -> Architect -> DB -> Backend/Frontend -> DevOps` 工作流。系统改为“队长制 + 契约驱动 + 动态派工”：Lead 先生成 `TeamPlan` 和契约文件，再根据计划调度实际需要的角色。

## 当前架构

入口：

- `runTeam(config)`：简单 Promise 入口，内部调用 `createTeamRun(config).start()`。
- `createTeamRun(config)`：返回可订阅、可暂停、可审批、可干预的 `TeamRun`。
- `agent-team --interactive`：启动基于 `pi-tui` 的首版运行视图。

核心流程：

1. `TeamRun.start()` 创建输出项目目录、解析模型、初始化 auth。
2. `TeamLead` 调用 Planner 生成动态 `TeamPlan`。
3. Planner 写入 `docs/contracts/team-plan.json` 和 `project-manifest.json`，按需求生成 `openapi.json`、`data-model.json`。
4. `TaskGraph` / `TaskScheduler` 执行计划中的任务 DAG。
5. 每个 agent 的任务说明引用契约文件、owned paths、expected outputs、acceptance criteria。
6. Validator 做轻量静态验证。
7. 如存在阻塞 issue，Lead 生成 repair tasks 并路由给 owner agent，默认最多 2 轮。
8. 全流程通过 `TeamEvent` 输出结构化事件，供 CLI/TUI/WebUI 复用。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 动态角色、TeamPlan、TeamEvent、TeamRun、验证和 repair 类型 |
| `src/team/planner.ts` | 需求到动态 TeamPlan、契约文件、repair task 的生成 |
| `src/team/team-lead.ts` | 队长调度、事件、验证、返工主循环 |
| `src/team/team-runner.ts` | `createTeamRun()` / `runTeam()`、模型解析、暂停/审批/干预控制 |
| `src/team/validator.ts` | 契约、产物、OpenAPI、package scripts 的轻量验证 |
| `src/agent/team-agent.ts` | 单 agent 运行时、事件转发、契约感知上下文裁剪 |
| `src/agent/bash-safety.ts` | bash 安全策略和审批请求 |
| `src/tui/team-tui.ts` | 首版 TUI 运行视图 |

## 已解决的问题

- 固定 6 Agent 管道已删除；角色名不再是闭合 union。
- PM 不再作为默认 agent；需求整理并入 Planner/Lead。
- Agent 协作从“截断前驱输出”改为“契约文件 + 实际文件”为事实来源。
- `runTeam()` 不再是唯一全量等待入口；新增 `TeamRun` 事件和控制 API。
- `bash` 默认阻断明显写入、删除、安装、启动服务等高风险命令，审批模式下可由外部决定。
- DevOps 式任务不再要求 `npm install && npm start`。
- 模型解析改为基于 `ModelRegistry`，不再用 `/v1`、`/v4` URL 启发式判断 API 类型。

## 仍需后续增强

- Planner 当前是确定性启发式实现；后续可替换为 LLM Planner，但必须保留 schema 校验和 fallback。
- Validator 是轻量静态验证，还没有完整 AST/OpenAPI/router/client 对齐。
- TUI 是首版运行视图，支持暂停/继续、审批和 abort；后续应增加人工 steering 输入、任务详情面板和 issue 定位。
- WebUI 尚未实现，但可以复用 `TeamRun` / `TeamEvent`。
- 会话持久化和断点续跑尚未接入 `SessionManager`。

## 测试覆盖

- `task-graph.test.ts` / `task-scheduler.test.ts`：动态任务 DAG 和调度基础能力。
- `planner.test.ts`：动态计划生成、不保留固定 6 角色流程。
- `bash-safety.test.ts`：bash 安全策略。
- `validator.test.ts`：缺失产物和 OpenAPI 不一致检测。
- `team-lead.test.ts`：事件顺序、验证、repair loop。
