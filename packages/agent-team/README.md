# @mariozechner/pi-agent-team

多 Agent 团队编排系统，用于全栈开发自动化。输入一条自然语言需求，系统自动规划团队、编写代码、验证产出、修复问题。

## 工作流程

```
"创建一个 Markdown 笔记 API 服务：Express + SQL.js 持久化。支持创建/编辑/删除笔记。"
        |
        v
  Planner (LLM) -- 生成 --> 团队计划 + 契约文件
        |
        v
  TeamLead (调度器) -- 并行分发 --> Worker Agents
        |
        v
  Validator + Supervisor -- 检查 --> 质量门
        |
        v
  Repair Loop (最多 2 轮) -- 修复 --> 问题
        |
        v
  可运行的完整项目（含测试和 E2E 验证报告）
```

## 快速开始

### 1. 构建

从 monorepo 根目录：

```bash
npm install
npm run build
```

或从本包目录：

```bash
cd packages/agent-team
npx tsgo -p tsconfig.build.json
```

### 2. 配置

复制示例配置并编辑：

```bash
cp agent-team.example.json agent-team.json
```

最简配置（使用智谱 GLM-5.1）：

```json
{
  "outputDir": "./output",
  "model": {
    "provider": "zai",
    "model": "glm-5.1",
    "apiKey": "your-api-key"
  },
  "maxParallelAgents": 2
}
```

配置文件发现顺序：`--config <path>` > `./agent-team.json` > `~/.pi/agent-team.json`。`agent-team.json` 已 gitignore。

完整配置参考见 [docs/configuration.md](docs/configuration.md)。

### 3. 运行

**带 TUI 交互界面（默认）：**

```bash
node dist/main.js "Build a todo app with Express and SQLite"
```

**无 TUI 后台运行：**

```bash
node dist/main.js --no-interactive "Build a REST API for notes"
```

**CLI 参数覆盖模型：**

```bash
node dist/main.js "Build a todo app" --provider anthropic --model claude-sonnet-4-6
node dist/main.js "Build a todo app" --model openrouter/deepseek-chat --max-parallel 4
```

## 系统架构

4 层架构：

| 层级 | 组件 | 类型 | 职责 |
|------|------|------|------|
| **规划** | Planner | LLM Agent | 将需求拆解为角色、任务、DAG、契约 |
| **调度** | TeamLead | 确定性调度 | 编排执行、验证、修复流程 |
| **执行** | Worker Agents | LLM Agents | 编写代码、运行测试、创建文件 |
| **验证** | Validator + Supervisor | 代码 + LLM | 静态/运行时检查 + 语义审查 |

### 7 种内置角色

| 角色 | 职责 |
|------|------|
| `project-setup` | 项目骨架、package.json、配置、脚本 |
| `backend-engineer` | API 路由、服务端逻辑、业务规则 |
| `data-engineer` | 数据库 schema、持久化、种子数据 |
| `frontend-engineer` | UI、客户端状态、浏览器交互 |
| `test-engineer` | 单元测试、集成测试 |
| `e2e-verifier` | 端到端验证，产出 `docs/e2e-report.md` |
| `docs-engineer` | 使用文档、交接说明 |

Planner 只能从这 7 种角色中选择，不能自定义工具、提示词或模型。

### Agent 间通信机制

Agent 之间不直接发消息，通过文件系统共享上下文：

1. **契约文件** (`docs/contracts/*.json`) — 团队计划、OpenAPI 规范、数据模型
2. **项目文件** — Agent 编写的实际源代码
3. **交接文件** (`docs/agent-team/tasks/<taskId>-handoff.json`) — 各 Agent 的产出说明
4. **事件流** (`docs/agent-team/events.jsonl`) — 结构化运行日志

### 5 层质量门

```
L1: Worker 自检（bash 事件中的 checksRun）
L2: 交接质量（必须有 handoff + 成功的 checks）
L3: Validator（静态 + 运行时：文件存在性、node --check、npm test、npm run check/build）
L4: E2E Verifier（启动服务器、发送真实 HTTP 请求、写报告）
L5: Supervisor（可选的 LLM 语义审查，在里程碑节点触发）
```

## CLI 参数

```
用法:
  agent-team "Build a todo app"
  agent-team --requirement "Build a todo app" --output ./output
  agent-team "Build a todo app" --max-parallel 4

参数:
  [requirement]              需求描述（位置参数）
  --requirement <text>       需求描述
  --output <path>            输出目录（默认: 配置文件或 "./output"）
  --config <path>            配置文件路径
  --model <id>               模型 ID（支持 "provider/model" 格式）
  --provider <name>          提供商名称
  --api-key <key>            API Key
  --base-url <url>           自定义模型端点
  --max-parallel <n>         最大并行 Agent 数（默认: 2）
  --max-repair-rounds <n>    最大修复轮次（默认: 2）
  --thinking-level <lvl>     推理深度：off / minimal / low / medium / high / xhigh
  --intervention-mode <mode> 人工干预：none / approval / interactive
  --supervision-mode <mode>  Supervisor 审查：off / milestone
  --permission-mode <mode>   文件权限：open / owned
  --execution-mode <mode>    执行权限：open / restricted
  --approval-policy <policy> 审批策略：minimal / strict
  --interactive              启用 TUI + 审批
  --no-interactive           禁用 TUI
  -h, --help                 显示帮助
```

## TUI 控制

| 按键 | 动作 |
|------|------|
| `p` | 暂停 / 恢复 |
| `a` | 批准当前请求 |
| `r` | 拒绝当前请求 |
| `Ctrl+C` | 终止运行 |

## 产出目录结构

```
output/<project-slug>/
  package.json
  src/
    ...
  tests/
    ...
  docs/
    contracts/
      team-plan.json          # 团队计划（角色、任务、DAG）
      project-manifest.json   # 项目目标和功能
      openapi.json            # API 规范（如适用）
      data-model.json         # 数据模型（如适用）
    agent-team/
      events.jsonl            # 完整事件流
      run-summary.md          # 运行结果摘要
      tasks/
        setup-handoff.json    # 每个任务的交接文件
        setup.jsonl           # 每个任务的事件日志
      supervision/
        001-plan_created.json # Supervisor 决策记录
        002-task_end.json
    e2e-report.md             # 端到端验证报告
```

## 配置

完整配置参考见 [docs/configuration.md](docs/configuration.md)。

### 支持的模型 Provider

**内置 Provider（只需 provider + model）：**

| Provider | 环境变量 | 示例模型 |
|----------|---------|---------|
| `zai` (智谱) | `ZAI_API_KEY` | `glm-5.1`、`glm-4.7` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| `openrouter` | `OPENROUTER_API_KEY` | `deepseek-chat` |
| `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |

**自定义 OpenAI 兼容端点（需 baseUrl + apiKey）：**

```json
{
  "provider": "openrouter",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-xxx"
}
```

### 安全模式

| 模式 | 默认值 | 说明 |
|------|--------|------|
| `permissionMode` | `open` | `open`: Agent 可写任意位置；`owned`: 限制在分配的目录内 |
| `executionMode` | `open` | `open`: 允许所需命令；`restricted`: 限制安装和长驻服务命令 |
| `approvalPolicy` | `minimal` | `minimal`: 仅高风险需审批；`strict`: 中+高风险需审批 |
| `supervisionMode` | `milestone` | `milestone`: 关键节点 LLM 审查；`off`: 跳过 |

### Bash 风险分级

| 级别 | 默认策略 | 示例 |
|------|---------|------|
| **safe** | 自动通过 | `mkdir`、`node --check`、`npm test`、`curl localhost` |
| **medium** | minimal 自动通过；strict 需审批 | `npm install`、`npx`、`npm run start` |
| **high** | 始终需审批或阻止 | `rm`、`chmod`、`docker build`、`curl 外部地址`、`Stop-Process -Name "node"` |

## 测试

```bash
# 跑全部测试
cd packages/agent-team
npx tsx ../../node_modules/vitest/dist/cli.js --run

# 跑单个测试文件
npx tsx ../../node_modules/vitest/dist/cli.js --run test/bash-safety.test.ts

# 按名称过滤
npx tsx ../../node_modules/vitest/dist/cli.js --run -t "blocks commands"
```

### 测试覆盖

| 模块 | 测试文件 | 状态 |
|------|---------|------|
| Task DAG | `task-graph.test.ts` | 已覆盖 |
| Task Scheduler | `task-scheduler.test.ts` | 已覆盖 |
| Bash Safety | `bash-safety.test.ts` | 已覆盖 |
| File Ownership | `file-ownership.test.ts` | 已覆盖 |
| Planner | `planner.test.ts` | 已覆盖 |
| Team Lead | `team-lead.test.ts` | 已覆盖 |
| Team Runner | `team-runner.test.ts` | 已覆盖 |
| Execution Recorder | `execution-recorder.test.ts` | 已覆盖 |
| TUI | `team-tui.test.ts` | 已覆盖 |
| Validator | `validator.test.ts` | 已覆盖 |
| Role Profiles | `role-profiles.test.ts` | 已覆盖 |
| Supervisor | `supervisor.test.ts` | 已覆盖 |
| Team Agent | — | 未覆盖 |
| Tool Pool | — | 未覆盖 |
| Config | — | 未覆盖 |

## 包依赖链

```
@mariozechner/pi-tui          终端 UI 组件
         |
@mariozechner/pi-ai           统一 LLM API（20+ 供应商）
         |
@mariozechner/pi-agent-core   Agent 运行时、工具调用
         |
@mariozechner/pi-coding-agent 编码工具（read/write/edit/bash/grep/find/ls）
         |
** 本包 **                    团队编排
```

## 文档

| 文档 | 说明 |
|------|------|
| [configuration.md](docs/configuration.md) | 配置字段完整参考（含 Provider 示例） |
| [design-document.md](docs/design-document.md) | 技术设计文档（模块级细节） |
| [agent-collaboration-and-quality.md](docs/agent-collaboration-and-quality.md) | Agent 角色、通信机制、质量门 |
| [architecture-and-run-flow.md](docs/architecture-and-run-flow.md) | 架构与运行流程 |
| [future-roadmap.md](docs/future-roadmap.md) | 后续改进路线图 |

## License

MIT
