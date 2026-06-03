# Agent-Team Guide

多 Agent 团队编排系统 —— 给一条自然语言需求，自动规划团队、写代码、验证产出、修复问题。

## 一句话概览

```
"创建一个 Markdown 笔记 API 服务：Express + SQL.js 持久化。"
        |
        v
  Planner → TeamLead → Worker Agents (并行) → Validator → Repair Loop
        |
        v
  可运行的完整项目（含测试、e2e 验证报告）
```

## 快速开始

### 前置条件

- Node.js >= 18
- 已安装 monorepo 依赖并构建（`npm install && npm run build`）
- 至少一个 LLM Provider 的 API Key

### 1. 构建 agent-team

从 monorepo 根目录：

```bash
cd packages/agent-team
npx tsgo -p tsconfig.build.json
```

### 2. 配置

```bash
cd packages/agent-team
cp agent-team.example.json agent-team.json
```

编辑 `agent-team.json`，填入你的模型信息：

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

> `agent-team.json` 已 gitignore，不会被提交。

**配置文件发现顺序**：`--config <path>` > `./agent-team.json` > `~/.pi/agent-team.json`

### 3. 运行

```bash
cd packages/agent-team

# 带 TUI 交互界面（默认）
node dist/main.js "Build a todo app with Express and SQLite"

# 无 TUI，纯后台运行
node dist/main.js --no-interactive "Build a REST API for notes"

# CLI 参数覆盖模型
node dist/main.js "Build a chat app" --provider anthropic --model claude-sonnet-4-6
```

## 支持的模型 Provider

| Provider | 环境变量 | 示例模型 |
|----------|---------|---------|
| `zai` (智谱) | `ZAI_API_KEY` | `glm-5.1`, `glm-4.7` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| `openrouter` | `OPENROUTER_API_KEY` | `deepseek-chat` |
| `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |

未注册的 OpenAI 兼容服务需要额外提供 `baseUrl` 和 `apiKey`，详见 [configuration.md](packages/agent-team/docs/configuration.md)。

## 架构

4 层架构，从上到下：

```
┌─────────────────────────────────────────────┐
│  CLI (main.ts)                              │
│  解析参数 → 加载配置 → 启动 TeamRun          │
├─────────────────────────────────────────────┤
│  Planner (LLM)                              │
│  需求 → 团队计划（角色、任务、DAG、契约）     │
├─────────────────────────────────────────────┤
│  TeamLead (确定性调度器)                     │
│  按依赖拓扑并行分发任务 → 验证 → 修复循环     │
├─────────────────────────────────────────────┤
│  Worker Agents (LLM)                        │
│  7 种内置角色，各自写代码、跑测试、交付产出    │
├─────────────────────────────────────────────┤
│  Validator + Supervisor                     │
│  静态检查 + 运行时验证 + LLM 语义审查        │
└─────────────────────────────────────────────┘
```

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

### Agent 间通信

Agent 不直接发消息，通过文件系统共享上下文：

1. **契约文件** (`docs/contracts/*.json`) — 计划、OpenAPI 规范、数据模型
2. **项目文件** — Agent 写的实际源代码
3. **交接文件** (`docs/agent-team/tasks/<taskId>-handoff.json`) — 每个 Agent 的产出说明
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
--supervision-mode <mode>  Supervisor：off / milestone
--permission-mode <mode>   文件权限：open / owned
--execution-mode <mode>    执行权限：open / restricted
--approval-policy <policy> 审批策略：minimal / strict
--interactive              启用 TUI + 审批
--no-interactive           禁用 TUI
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
  tests/
  docs/
    contracts/
      team-plan.json           # 团队计划
      project-manifest.json    # 项目目标
      openapi.json             # API 规范
      data-model.json          # 数据模型
    agent-team/
      events.jsonl             # 事件流
      run-summary.md           # 运行摘要
      tasks/
        setup-handoff.json     # 任务交接
        setup.jsonl            # 任务日志
      supervision/
        001-plan_created.json  # Supervisor 决策
    e2e-report.md              # E2E 验证报告
```

## 安全模型

| 模式 | 选项 | 说明 |
|------|------|------|
| `permissionMode` | `open` / `owned` | `owned` 限制 Agent 只能写分配的目录 |
| `executionMode` | `open` / `restricted` | `restricted` 限制安装和长驻服务命令 |
| `approvalPolicy` | `minimal` / `strict` | `minimal` 仅高风险需审批；`strict` 中+高风险 |
| `supervisionMode` | `milestone` / `off` | 里程碑节点 LLM 审查 |

### Bash 风险分级

| 级别 | 默认策略 | 示例 |
|------|---------|------|
| safe | 自动通过 | `mkdir`, `node --check`, `npm test`, `curl localhost` |
| medium | minimal 自动; strict 需审批 | `npm install`, `npx`, `npm run start` |
| high | 始终需审批或阻止 | `rm`, `chmod`, `docker build`, `curl external`, `Stop-Process -Name "node"` |

## 测试

```bash
cd packages/agent-team

# 跑全部测试
npx tsx ../../node_modules/vitest/dist/cli.js --run

# 跑单个文件
npx tsx ../../node_modules/vitest/dist/cli.js --run test/bash-safety.test.ts

# 按名称过滤
npx tsx ../../node_modules/vitest/dist/cli.js --run -t "blocks commands"
```

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
agent-team                    团队编排（本包）
```

## 完整文档

| 文档 | 说明 |
|------|------|
| [README.md](packages/agent-team/README.md) | 包级 README（英文） |
| [configuration.md](packages/agent-team/docs/configuration.md) | 配置字段完整参考 |
| [design-document.md](packages/agent-team/docs/design-document.md) | 技术设计文档（模块级） |
| [agent-collaboration-and-quality.md](packages/agent-team/docs/agent-collaboration-and-quality.md) | Agent 协作与质量保障 |
| [future-roadmap.md](packages/agent-team/docs/future-roadmap.md) | 后续规划路线图 |
