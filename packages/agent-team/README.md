# @mariozechner/pi-agent-team

Multi-agent team orchestrator for full-stack development. Give it a natural language requirement, it plans the team, writes the code, validates the output, and repairs issues automatically.

## What It Does

```
"创建一个 Markdown 笔记 API 服务：Express + SQL.js 持久化。支持创建/编辑/删除笔记。"
        |
        v
  Planner (LLM) -- generates --> Team Plan + Contracts
        |
        v
  TeamLead (scheduler) -- dispatches --> Worker Agents in parallel
        |
        v
  Validator + Supervisor -- checks --> Quality Gates
        |
        v
  Repair Loop (up to 2 rounds) -- fixes --> Issues
        |
        v
  Working project with tests and e2e report
```

## Quick Start

### 1. Build

From the monorepo root:

```bash
npm install
npm run build
```

Or from this package:

```bash
cd packages/agent-team
npx tsgo -p tsconfig.build.json
```

### 2. Configure

Copy the example config and edit:

```bash
cp agent-team.example.json agent-team.json
```

Minimal config (using Zhipu GLM-5.1):

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

Config file discovery order: `--config <path>` > `./agent-team.json` > `~/.pi/agent-team.json`. `agent-team.json` is gitignored.

For full configuration details, see [docs/configuration.md](docs/configuration.md).

### 3. Run

**With TUI (default):**

```bash
node dist/main.js "Build a todo app with Express and SQLite"
```

**Without TUI:**

```bash
node dist/main.js --no-interactive "Build a todo app with Express and SQLite"
```

**CLI parameter overrides:**

```bash
node dist/main.js "Build a todo app" --provider anthropic --model claude-sonnet-4-6
node dist/main.js "Build a todo app" --model openrouter/deepseek-chat --max-parallel 4
```

## Architecture

The system has 4 layers:

| Layer | Component | Type | Role |
|-------|-----------|------|------|
| **Planning** | Planner | LLM agent | Decomposes requirement into roles, tasks, DAG, contracts |
| **Scheduling** | TeamLead | Deterministic | Orchestrates execution, validation, repair |
| **Execution** | Worker Agents | LLM agents | Write code, run tests, create files |
| **Verification** | Validator + Supervisor | Code + LLM | Static/runtime checks + semantic review |

### 7 Built-in Worker Roles

| Role | Responsibility |
|------|---------------|
| `project-setup` | Project skeleton, package.json, config, scripts |
| `backend-engineer` | API routes, server logic, business rules |
| `data-engineer` | Database schema, persistence, seed data |
| `frontend-engineer` | UI, client state, browser interaction |
| `test-engineer` | Unit and integration tests |
| `e2e-verifier` | End-to-end verification, writes `docs/e2e-report.md` |
| `docs-engineer` | Usage docs, handoff notes |

The Planner can only select from these profiles. It cannot define custom tools, prompts, or models.

### How Agents Communicate

Agents do not send messages to each other. They share context through:

1. **Contract files** (`docs/contracts/*.json`) — Plan, OpenAPI spec, data model
2. **Project files** — Actual source code written by workers
3. **Handoff files** (`docs/agent-team/tasks/<taskId>-handoff.json`) — What each agent did
4. **Event stream** (`docs/agent-team/events.jsonl`) — Structured run log

### Quality Gates

```
Layer 1: Worker self-check (checksRun from bash events)
Layer 2: Handoff quality (must have handoff + successful checks)
Layer 3: Validator (static + runtime: file existence, node --check, npm test, npm run check/build)
Layer 4: E2E verifier (starts server, sends real HTTP requests, writes report)
Layer 5: Supervisor (optional LLM-based semantic review at milestones)
```

## Command Reference

```
Usage:
  agent-team "Build a todo app"
  agent-team --requirement "Build a todo app" --output ./output
  agent-team "Build a todo app" --max-parallel 4

Options:
  [requirement]              Project requirement (positional)
  --requirement <text>       Project requirement description
  --output <path>            Output directory (default: from config or "./output")
  --config <path>            Config file path
  --model <id>               Model ID (supports "provider/model" format)
  --provider <name>          Provider name
  --api-key <key>            API key
  --base-url <url>           Override model base URL
  --max-parallel <n>         Max parallel agents (default: 2)
  --max-repair-rounds <n>    Max repair rounds (default: 2)
  --thinking-level <lvl>     off, minimal, low, medium, high, xhigh
  --intervention-mode <mode> none, approval, interactive
  --supervision-mode <mode>  off, milestone
  --permission-mode <mode>   open, owned
  --execution-mode <mode>    open, restricted
  --approval-policy <policy> minimal, strict
  --interactive              Run with TUI + enable approvals
  --no-interactive           Run without TUI
  -h, --help                 Show help
```

## TUI Controls

| Key | Action |
|-----|--------|
| `p` | Pause / Resume |
| `a` | Approve current request |
| `r` | Reject current request |
| `Ctrl+C` | Abort run |

## Output Structure

```
output/<project-slug>/
  package.json
  src/
    ...
  tests/
    ...
  docs/
    contracts/
      team-plan.json          # Full team plan with roles, tasks, DAG
      project-manifest.json   # Project goals and features
      openapi.json            # API spec (if applicable)
      data-model.json         # Data schema (if applicable)
    agent-team/
      events.jsonl            # Full event stream
      run-summary.md          # Run result summary
      tasks/
        setup-handoff.json    # Per-task handoff
        setup.jsonl           # Per-task event log
      supervision/
        001-plan_created.json # Supervisor decisions
        002-task_end.json
    e2e-report.md             # End-to-end verification report
```

## Configuration

See [docs/configuration.md](docs/configuration.md) for the full reference.

### Supported Model Providers

**Built-in (just provider + model):**

| Provider | Environment Variable | Example Model |
|----------|---------------------|---------------|
| `zai` (Zhipu) | `ZAI_API_KEY` | `glm-5.1`, `glm-4.7` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| `openrouter` | `OPENROUTER_API_KEY` | `deepseek-chat` |
| `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |

**Custom OpenAI-compatible endpoints (need baseUrl + apiKey):**

```json
{
  "provider": "openrouter",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-xxx"
}
```

### Security Modes

| Mode | Default | Description |
|------|---------|-------------|
| `permissionMode` | `open` | `open`: agents can write anywhere; `owned`: restricted to assigned directories |
| `executionMode` | `open` | `open`: agents can run needed commands; `restricted`: limits install and long-running commands |
| `approvalPolicy` | `minimal` | `minimal`: only high-risk commands need approval; `strict`: medium+high need approval |
| `supervisionMode` | `milestone` | `milestone`: LLM-based review at key points; `off`: skip |

### Bash Risk Classification

| Level | Default Policy | Examples |
|-------|---------------|---------|
| **safe** | Auto-approve | `mkdir`, `node --check`, `npm test`, `curl localhost` |
| **medium** | minimal: auto-approve; strict: needs approval | `npm install`, `npx`, `npm run start` |
| **high** | Always blocked or requires approval | `rm`, `chmod`, `docker build`, `curl external`, `$(...)`, `Stop-Process -Name "node"` |

## Testing

```bash
# Run all tests
cd packages/agent-team
npx tsx ../../node_modules/vitest/dist/cli.js --run

# Run a specific test
npx tsx ../../node_modules/vitest/dist/cli.js --run test/bash-safety.test.ts

# Run with pattern
npx tsx ../../node_modules/vitest/dist/cli.js --run -t "blocks commands"
```

### Test Coverage

| Module | Test File | Status |
|--------|-----------|--------|
| Task DAG | `task-graph.test.ts` | Covered |
| Task Scheduler | `task-scheduler.test.ts` | Covered |
| Bash Safety | `bash-safety.test.ts` | Covered |
| File Ownership | `file-ownership.test.ts` | Covered |
| Planner | `planner.test.ts` | Covered |
| Team Lead | `team-lead.test.ts` | Covered |
| Team Runner | `team-runner.test.ts` | Covered |
| Execution Recorder | `execution-recorder.test.ts` | Covered |
| TUI | `team-tui.test.ts` | Covered |
| Validator | `validator.test.ts` | Covered |
| Role Profiles | `role-profiles.test.ts` | Covered |
| Supervisor | `supervisor.test.ts` | Covered |
| Team Agent | — | Not covered |
| Tool Pool | — | Not covered |
| Config | — | Not covered |

## Package Dependencies

```
@ mariozechner/pi-tui          Terminal UI components
         |
@ mariozechner/pi-ai            Unified LLM API (stream/complete)
         |
@ mariozechner/pi-agent-core    Agent runtime, tool calling
         |
@ mariozechner/pi-coding-agent  Coding tools (read/write/edit/bash/grep/find/ls)
         |
** this package **              Team orchestration
```

## Documentation

| Document | Description |
|----------|-------------|
| [configuration.md](docs/configuration.md) | Full config reference with provider examples |
| [design-document.md](docs/design-document.md) | Complete technical design doc (module-level detail) |
| [agent-collaboration-and-quality.md](docs/agent-collaboration-and-quality.md) | Agent roles, communication, quality gates |
| [architecture-audit.md](docs/architecture-audit.md) | Known defects and issues |
| [future-roadmap.md](docs/future-roadmap.md) | Planned improvements and roadmap |

## License

MIT
