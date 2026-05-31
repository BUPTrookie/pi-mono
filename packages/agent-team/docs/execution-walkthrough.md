# agent-team 完整执行流程走查

本文档以一个具体需求为例，从 CLI 命令行输入到最终产出，逐行追踪 agent-team 系统内部每一步发生了什么。

---

## 目录

- [一个类比](#一个类比)
- [全流程图](#全流程图)
- [具体示例：构建一个投票 API](#具体示例构建一个投票-api)
  - [Step 1：CLI 启动](#step-1cli-启动--maints)
  - [Step 2：配置发现与合并](#step-2配置发现与合并--configts)
  - [Step 3：创建 DynamicTeamRun](#step-3创建-dynamicteamrun--team-runnerts)
  - [Step 4：TeamLead 编排开始](#step-4teamlead-编排开始--team-leadts)
  - [Step 5：LLM Planner 生成计划](#step-5llm-planner-生成计划--plannerts)
  - [Step 6：创建角色注册表](#step-6创建角色注册表--plannerts)
  - [Step 7：构建 DAG 并调度](#step-7构建-dag-并调度--task-graphts--task-schedulerts)
  - [Step 8：第一轮调度 — task-setup](#step-8第一轮调度--task-setupbatch-1)
  - [Step 8 续：第二轮调度 — task-db + task-api](#step-8-续第二轮调度--task-db--task-apibatch-2)
  - [Step 8 续：第三轮调度 — task-test](#step-8-续第三轮调度--task-testbatch-3)
  - [Step 9：验证](#step-9验证--validatorts)
  - [Step 10：修复循环](#step-10修复循环round-1)
  - [最终磁盘产物](#最终磁盘产物)
- [关键设计：Agent 之间如何通信](#关键设计agent-之间如何通信)
- [已知缺陷对本流程的影响](#已知缺陷对本流程的影响)

---

## 一个类比

想象你开了一家**建筑公司**（agent-team）。流程是这样的：

1. **客户下订单**（CLI 命令）—— "帮我盖一个投票网站"
2. **前台接收需求，查配置**（main.ts + config.ts）—— 确认预算、用什么建材
3. **总工拿到需求做施工图**（Planner LLM）—— 决定需要水电工、泥瓦工几个工种，谁先谁后
4. **施工图存档到档案室**（契约文件写入磁盘）—— 所有工人共享这份图纸
5. **总工按施工图排工期**（DAG + Scheduler）—— 水电先做，泥瓦后做，可以并行的就并行
6. **每个工人领自己的任务单**（TeamAgent 创建）—— 任务单上写着"你要看图纸第几页、只能动哪些房间"
7. **工人干活时，安全员在旁边盯着**（beforeToolCall 钩子）—— "这个房间不是你的，不能砸墙"
8. **每批工人干完，质检员来检查**（Validator）—— "水龙头装了吗？"
9. **检查不合格，返工单下发给对应工人**（修复循环）
10. **全部合格，交付**

---

## 全流程图

```
用户敲命令
  |
  v
+---------------------------------------------------------------------+
| Step 1: main.ts  CLI 参数解析                                        |
|   node dist/main.js --requirement "Build a poll API..." --output ./ |
+----------------------------------+----------------------------------+
                                   |
  v
+---------------------------------------------------------------------+
| Step 2: config.ts  配置发现与合并                                     |
|   CLI args > agent-team.json > 硬编码默认值                            |
+----------------------------------+----------------------------------+
                                   |
  v
+---------------------------------------------------------------------+
| Step 3: team-runner.ts  创建 DynamicTeamRun                          |
|   创建项目目录 -> 注册API Key -> 解析模型 -> 创建 TeamLead             |
+----------------------------------+----------------------------------+
                                   |
  v
+---------------------------------------------------------------------+
| Step 4: team-lead.ts  TeamLead.orchestrate()                         |
|   发射 run_start 事件                                                 |
+----------------------------------+----------------------------------+
                                   |
  v
+---------------------------------------------------------------------+
| Step 5: planner.ts  LLM Planner                                      |
|   发 systemPrompt + 用户需求 -> LLM 返回完整 JSON                     |
|   parsePlannerOutput() -> validatePlannerJson()                      |
|   writeContracts() -> 写 5 个契约文件到磁盘                            |
+----------------------------------+----------------------------------+
                                   |
  v
+---------------------------------------------------------------------+
| Step 6: planner.ts  createRoleRegistry() -> Map<name, RoleDefinition>|
+----------------------------------+----------------------------------+
                                   |
  v
+---------------------------------------------------------------------+
| Step 7: task-graph.ts + task-scheduler.ts  构建 DAG 并调度            |
|   batch 1: [task-setup] -> batch 2: [task-api, task-db] -> ...      |
+----------------------------------+----------------------------------+
                                   |
           +-----------------------+----------------------+
           v                       v                      v
  +----------------+      +----------------+      +----------------+
  | Step 8: Agent  |      | Step 8: Agent  |      | Step 8: Agent  |
  |  task-setup    |      |  task-api      |      |  task-test     |
  |                |      |                |      |                |
  | buildToolPool  |      | buildToolPool  |      | buildToolPool  |
  | ownershipGuard |      | ownershipGuard |      | ownershipGuard |
  | bashSafety     |      | bashSafety     |      | bashSafety     |
  | Agent.prompt() |      | Agent.prompt() |      | Agent.prompt() |
  +-------+--------+      +-------+--------+      +-------+--------+
          |                        |                        |
          +------------------------+------------------------+
                                   v
  +---------------------------------------------------------------------+
  | Step 9: validator.ts  静态检查 + 运行时检查                           |
  |   文件存在？OpenAPI路径覆盖？node --check？npm test？                 |
  +----------------------------------+----------------------------------+
                                     |
                        +------------+-----------+
                        v                        v
                 全部通过？                  有 error？
                 返回成功                 创建 repair tasks
                                              |
                                              v
                                       回到 Step 7 重跑
```

---

## 具体示例：构建一个投票 API

### Step 1：CLI 启动 — main.ts

用户在终端执行：

```bash
node packages/agent-team/dist/main.js \
  --requirement "Build a RESTful polling API with Express and SQLite. It should support creating polls, voting, and getting results. Include tests." \
  --output ./output \
  --model glm-5.1 \
  --provider zai \
  --api-key sk-xxx \
  --max-parallel 2
```

**`parseArgs(process.argv.slice(2))`** 解析结果：

```typescript
parsed = {
  requirement: "Build a RESTful polling API with Express and SQLite. It should support creating polls, voting, and getting results. Include tests.",
  outputDir: "./output",
  model: {
    provider: "zai",
    model: "glm-5.1",
    apiKey: "sk-xxx",
    // baseUrl: undefined
  },
  options: {
    maxParallelAgents: 2,  // parseInt("2")
    // thinkingLevel: undefined
    // maxRepairRounds: undefined
    // interventionMode: undefined
  },
  // interactive: undefined
}
```

> **代码位置**：`main.ts:40-87`
>
> `parseArgs` 用一个 `for` 循环逐个消费 `argv`。每遇到 `--xxx` 就读下一个元素作为值。注意 `parseInt` 没有 NaN 检查（已知的 L-1 缺陷）。

`main()` 函数做两件事：
1. 校验 `--requirement` 和 `--output` 必须存在（`main.ts:125-135`），缺失直接 `process.exit(1)`
2. 因为 `parsed.interactive` 是 `undefined`，走 `await runTeam(config)` 分支（`main.ts:156`）

---

### Step 2：配置发现与合并 — config.ts

**`findConfigFile(undefined)`** — 没有传 `--config`，按以下顺序搜索：

| 顺序 | 路径 | 结果 |
|------|------|------|
| 1 | `${cwd}/agent-team.json` | 假设不存在，跳过 |
| 2 | `${homedir()}/.pi/agent-team.json` | 假设不存在，返回 `undefined` |

**`mergeConfig(undefined, cliModel, cliOptions)`** — 因为文件配置为 `undefined`，CLI 参数直接生效，未设置的字段用硬编码默认值：

```typescript
merged = {
  model: {
    provider: "zai",              // 来自 CLI --provider
    model: "glm-5.1",             // 来自 CLI --model
    apiKey: "sk-xxx",             // 来自 CLI --api-key
    baseUrl: undefined,           // 未传
  },
  maxParallelAgents: 2,           // 来自 CLI --max-parallel
  thinkingLevel: undefined,       // 未传，最终用 "off"
  maxRepairRounds: undefined,     // 未传，最终用默认 2
  interventionMode: undefined,    // 未传，最终用 "none"
}
```

> 注意 `config.ts:78` 中的硬编码默认模型 `"claude-sonnet-4-6"` — 因为 CLI 已提供 `model`，这里不生效。

最终组装的 `TeamConfig` 对象（`main.ts:141-149`）：

```typescript
config: TeamConfig = {
  requirement: "Build a RESTful polling API...",
  outputDir: "D:\\code\\...\\output",    // resolve("./output") 变为绝对路径
  model: {
    provider: "zai",
    model: "glm-5.1",
    apiKey: "sk-xxx",
  },
  maxParallelAgents: 2,
  maxRepairRounds: undefined,             // 后面由 team-lead 用 ?? 2 补全
  interventionMode: undefined,            // 后面由 team-lead 用 ?? "none" 补全
  thinkingLevel: undefined,               // 后面传给 Agent 为 "off"
}
```

---

### Step 3：创建 DynamicTeamRun — team-runner.ts

`runTeam(config)` 一行代码（`team-runner.ts:248`）：

```typescript
return createTeamRun(config).start();
// 即 return new DynamicTeamRun(config).start();
```

**`DynamicTeamRun.start()`** 内部依次做了 5 件事：

#### 3a. 创建项目目录

```typescript
// team-runner.ts:213-218
const baseDir = resolve("./output");           // "D:\code\...\output"
mkdirSync(baseDir, { recursive: true });       // 确保基础目录存在
const projectDir = uniqueDir(baseDir, deriveProjectSlug(requirement));
```

`deriveProjectSlug` 从需求文本提取关键词：

```
"Build a RESTful polling API with Express and SQLite..."
-> 去掉 a/an/the/build/create/with/for/and/app/application...
-> 保留 ["restful", "polling", "api", "express"]
-> slug = "restful-polling-api-express"
```

`uniqueDir` 检查 `./output/restful-polling-api-express` 是否已存在，存在则加 `-2` 后缀。

最终项目目录：**`D:\code\...\output\restful-polling-api-express`**

#### 3b. 注册 API Key

```typescript
// team-runner.ts:175-179
const authStorage = AuthStorage.create(join(homedir(), ".pi", "auth.json"));
// config.model.apiKey = "sk-xxx"，resolvedProvider = "zai"
if ("sk-xxx" && "zai") {
  authStorage.setRuntimeApiKey("zai", "sk-xxx");
}
```

把 API Key 注册到 `AuthStorage`，后续 `ModelRegistry` 可以查到。

#### 3c. 创建模型注册表并解析模型

```typescript
// team-runner.ts:180-186
const modelRegistry = ModelRegistry.create(authStorage);
// registry 里现在有所有已知 provider 的模型列表，zai provider 下的 "glm-5.1" 也能找到
const model = resolveModel(modelRegistry, "zai", "glm-5.1", undefined);
```

`resolveModel` 的匹配路径（`team-runner.ts:62-108`）：

```
1. resolvedProvider = "zai", resolvedModelId = "glm-5.1"
2. registry.find("zai", "glm-5.1") -> 精确匹配成功
3. 返回 Model 对象：
   {
     id: "glm-5.1",
     provider: "zai",
     name: "GLM 5.1",
     contextWindow: 128000,
     maxOutputTokens: 16384,
     ...
   }
```

如果精确匹配失败，还会尝试：
- Provider 模板回退：用该 provider 的第一个模型作为模板，替换 id
- 无 provider 全局搜索：遍历所有 provider 的所有模型

#### 3d. 定义 getApiKey 回调

```typescript
// team-runner.ts:193-201
const getApiKey = async (provider: string) => {
  if (projectConfig.model.apiKey) return "sk-xxx";  // 优先返回配置的 key
  // 否则从 ModelRegistry 查环境变量
  const key = await modelRegistry.getApiKeyForProvider(provider);
  if (!key) throw new Error(`No API key found for ${provider}...`);
  return key;
};
```

这个回调会传给 TeamLead，再传给每个 Agent，确保所有 LLM 调用都有 API Key。

#### 3e. 创建 TeamLead

```typescript
// team-runner.ts:204-208
this.lead = new TeamLead(
  projectConfig,               // TeamConfig
  model,                       // Model<Api> -- glm-5.1
  getApiKey,                   // (provider) => "sk-xxx"
  (event) => this.emit(event), // 事件发射器 -- 转发给所有 listeners
  {                            // TeamLeadControls
    waitIfPaused: () => this.waitIfPaused(),
    requestApproval: (req) => this.requestApproval(req.taskId, req.reason, req.command),
    getInterventions: () => [...this.interventions],
  }
);
```

此时 `DynamicTeamRun` 内部状态：

```typescript
{
  listeners: [],               // 还没有人订阅
  started: true,
  lead: TeamLead { ... },
  paused: false,
  approvals: Map(0),
  interventions: [],
  approvalCounter: 0,
}
```

---

### Step 4：TeamLead 编排开始 — team-lead.ts

`this.lead.orchestrate()` 开始执行（`team-lead.ts:125`）。

```typescript
// team-lead.ts:130
this.emit({
  type: "run_start",
  requirement: "Build a RESTful polling API...",
  outputDir: "D:\\code\\...\\restful-polling-api-express",
  timestamp: 1717123200000
});
```

控制台输出：

```
[team-lead] Starting dynamic team orchestration for: Build a RESTful polling API with Express and SQLite. It should ...
[team-lead] Output directory: D:\code\...\restful-polling-api-express
```

`TeamLead` 构造函数接收 6 个参数（`team-lead.ts:102-119`）：

| 参数 | 值 | 用途 |
|------|----|------|
| `config` | TeamConfig | 需求、输出目录、模型配置 |
| `model` | Model<Api> | 所有 Agent 共用的 LLM 模型 |
| `getApiKey` | `(provider) => key` | API Key 获取回调 |
| `emit` | `(event) => this.emit(event)` | 事件发射函数 |
| `controls` | TeamLeadControls | 暂停/审批/人工干预控制 |
| `agentRunner` | `runTeamAgent` | Agent 运行函数（默认值） |
| `plannerRunner` | `llmPlannerRunner` | Planner 运行函数（默认值） |
| `validatorRunner` | `validateTeamOutputWithChecks` | 验证器运行函数（默认值） |

---

### Step 5：LLM Planner 生成计划 — planner.ts

`llmPlannerRunner` 被调用（`team-lead.ts:136`），内部做了 3 步：

#### 5a. 构建 system prompt

`plannerSystemPrompt()`（`planner.ts:231-287`）返回一段 2000+ 字符的系统提示，告诉 LLM：

> 你是动态工程团队的首席规划师。只返回 JSON，格式必须包含 teamPlan（roles + tasks）、projectManifest、可选的 openapi/dataModel/notes。角色和任务由你根据实际需求动态决定。

完整的 system prompt 结构：

```
You are the Lead Planner for a dynamic AI engineering team.

Your job is to understand the user's project globally and produce the
collaboration contracts worker agents will implement.

Return ONLY valid JSON. Do not use markdown.

Required top-level shape:
{
  "teamPlan": {
    "id": "short-plan-id",
    "summary": "project summary",
    "roles": [
      {
        "name": "role-id",
        "description": "role purpose",
        "allowedTools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
        "ownedDirectories": ["src"],
        "maxTurns": 40,
        "systemPrompt": "optional role-specific system prompt"
      }
    ],
    "tasks": [
      {
        "id": "task-id",
        "role": "role-id",
        "subject": "task subject",
        "description": "specific implementation instructions",
        "dependencies": [],
        "ownedDirectories": ["src"],
        "expectedOutputs": ["src", "package.json"],
        "acceptanceCriteria": ["concrete criterion"]
      }
    ],
    "validationRules": ["project-specific validation rule"]
  },
  "projectManifest": { ... },
  "openapi": { ... },        // 可选
  "dataModel": { ... },      // 可选
  "notes": { ... }           // 可选
}

Rules:
- You decide roles, tasks, dependencies, contracts, and validation rules from the actual requirement.
- Include openapi only if the project needs an HTTP API.
- Include dataModel only if the project needs persistent or structured domain data.
- Do not invent generic placeholder APIs or domain objects.
- All paths must be relative to the project root. Never use absolute paths or ..
- Every task role must exist in teamPlan.roles.
- Every task dependency must reference an existing task id.
- Contract files are communication artifacts for workers; make them specific enough to prevent drift.
```

#### 5b. 发送第一次 LLM 请求

`completePlannerJson` 调用 `completeSimple`（来自 `@mariozechner/pi-ai`）：

```
调用参数:
  model:        Model { id: "glm-5.1", provider: "zai" }
  systemPrompt: plannerSystemPrompt() 的完整输出
  messages:     [{
    role: "user",
    content: "Project requirement:\nBuild a RESTful polling API with Express and SQLite...\n\nPlan the team and generate contracts. Return JSON only.",
    timestamp: 1717123200000
  }]
  apiKey:       "sk-xxx"
  reasoning:    undefined  (thinkingLevel 是 undefined -> off)
```

`completeSimple` 是 `@mariozechner/pi-ai` 提供的非流式完成函数，会根据 `model.provider` 路由到对应的 LLM 提供商（这里是 "zai"），发送请求并等待完整响应。

#### 5c. LLM 返回的 JSON（模拟）

LLM 返回类似这样的结构：

```json
{
  "teamPlan": {
    "id": "poll-api",
    "summary": "RESTful polling API with Express + SQLite",
    "roles": [
      {
        "name": "setup-engineer",
        "description": "Initialize project structure, install deps, configure SQLite",
        "allowedTools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
        "ownedDirectories": ["."],
        "maxTurns": 20
      },
      {
        "name": "api-builder",
        "description": "Implement Express routes and controllers for poll CRUD + voting",
        "allowedTools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
        "ownedDirectories": ["src"],
        "maxTurns": 35
      },
      {
        "name": "db-engineer",
        "description": "Design SQLite schema, write migration and seed scripts",
        "allowedTools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
        "ownedDirectories": ["src/db"],
        "maxTurns": 25
      },
      {
        "name": "test-engineer",
        "description": "Write integration tests for all API endpoints",
        "allowedTools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
        "ownedDirectories": ["tests"],
        "maxTurns": 30
      }
    ],
    "tasks": [
      {
        "id": "task-setup",
        "role": "setup-engineer",
        "subject": "Initialize project",
        "description": "Create package.json with express/better-sqlite3/vitest deps. Create src/index.js entry point.",
        "dependencies": [],
        "ownedDirectories": ["."],
        "expectedOutputs": ["package.json", "src/index.js"],
        "acceptanceCriteria": [
          "package.json has express and better-sqlite3",
          "src/index.js exists and imports express"
        ]
      },
      {
        "id": "task-db",
        "role": "db-engineer",
        "subject": "Create SQLite schema and helpers",
        "description": "Create src/db/schema.js with CREATE TABLE statements. Create src/db/helpers.js with CRUD functions.",
        "dependencies": ["task-setup"],
        "ownedDirectories": ["src/db"],
        "expectedOutputs": ["src/db/schema.js", "src/db/helpers.js"],
        "acceptanceCriteria": [
          "schema creates polls and votes tables",
          "helpers export createPoll, vote, getResults"
        ]
      },
      {
        "id": "task-api",
        "role": "api-builder",
        "subject": "Implement API routes",
        "description": "Create src/routes/polls.js with POST /polls, POST /polls/:id/vote, GET /polls/:id/results.",
        "dependencies": ["task-setup"],
        "ownedDirectories": ["src"],
        "expectedOutputs": ["src/routes/polls.js"],
        "acceptanceCriteria": [
          "POST /polls creates a poll",
          "POST /polls/:id/vote records a vote",
          "GET /polls/:id/results returns aggregated results"
        ]
      },
      {
        "id": "task-test",
        "role": "test-engineer",
        "subject": "Write integration tests",
        "description": "Create tests/polls.test.js with vitest tests for all three endpoints.",
        "dependencies": ["task-db", "task-api"],
        "ownedDirectories": ["tests"],
        "expectedOutputs": ["tests/polls.test.js"],
        "acceptanceCriteria": [
          "Tests cover all three endpoints",
          "Tests use in-memory SQLite"
        ]
      }
    ],
    "validationRules": [
      "All required contract files must exist.",
      "Task expected outputs must exist after execution."
    ]
  },
  "projectManifest": {
    "goal": "RESTful polling API",
    "features": ["Create polls", "Vote on polls", "Get poll results"],
    "nonFunctionalRequirements": ["Use Express.js", "Use SQLite via better-sqlite3"],
    "implementationNotes": ["In-memory SQLite for tests"]
  },
  "openapi": {
    "openapi": "3.1.0",
    "info": { "title": "Poll API", "version": "1.0.0" },
    "paths": {
      "/polls": { "post": { "summary": "Create a poll" } },
      "/polls/{pollId}/votes": { "post": { "summary": "Vote on a poll" } },
      "/polls/{pollId}/results": { "get": { "summary": "Get poll results" } }
    }
  }
}
```

#### 5d. 解析与校验 — validatePlannerJson()

调用链：`parsePlannerOutput` -> `extractJsonText` -> `JSON.parse` -> `validatePlannerJson`（`planner.ts:146`）

**`extractJsonText`**（`planner.ts:210-216`）先从 LLM 输出中提取纯 JSON：
1. `stripCodeFence` 去掉可能的 ```json ... ``` 包裹
2. 找到第一个 `{` 和最后一个 `}`，截取中间部分

校验步骤依次为：

| 校验 | 代码行 | 做了什么 |
|------|--------|---------|
| teamPlan 必须是对象 | `L147` | `asRecord(raw.teamPlan, "teamPlan")` |
| roles 至少 1 个 | `L150-151` | `Array.isArray && length > 0` |
| tasks 至少 1 个 | `L152-153` | 同上 |
| 路径安全检查 | `L160-161` | 每个 role 的 ownedDirectories 不能含 `..`、绝对路径 |
| 任务 ID 唯一 | `L163-164` | `taskIds.has(task.id)` 重复则抛错 |
| 任务引用的角色必须存在 | `L165` | `!roleNames.has(task.role)` |
| 依赖必须引用已存在的任务 | `L170-171` | `!taskIds.has(dependency)` |
| 自依赖检查 | `L172` | `dependency === task.id` |

> **已知缺陷 [C-2]**：不检查循环依赖。A->B->C->A 会通过验证，导致 `getReadyTasks()` 永远不返回这些任务，调度卡死。

如果第一次 LLM 返回的 JSON 无效，会自动 repair 一次（`planner.ts:333-351`）：把原始输出和错误信息发给 LLM，要求修正。第二次仍失败则终止 run。

校验通过后返回 `PlannerResult`：

```typescript
{
  plan: {
    id: "poll-api",
    summary: "RESTful polling API with Express + SQLite",
    roles: [
      { name: "setup-engineer", allowedTools: [...], ownedDirectories: ["."], maxTurns: 20, ... },
      { name: "api-builder",    allowedTools: [...], ownedDirectories: ["src"], maxTurns: 35, ... },
      { name: "db-engineer",    allowedTools: [...], ownedDirectories: ["src/db"], maxTurns: 25, ... },
      { name: "test-engineer",  allowedTools: [...], ownedDirectories: ["tests"], maxTurns: 30, ... },
    ],
    tasks: [
      { id: "task-setup", role: "setup-engineer", dependencies: [], ... },
      { id: "task-db",    role: "db-engineer",    dependencies: ["task-setup"], ... },
      { id: "task-api",   role: "api-builder",    dependencies: ["task-setup"], ... },
      { id: "task-test",  role: "test-engineer",  dependencies: ["task-db", "task-api"], ... },
    ],
    contracts: [
      { path: "docs/contracts/team-plan.json", kind: "team-plan", required: true },
      { path: "docs/contracts/project-manifest.json", kind: "project-manifest", required: true },
      { path: "docs/contracts/openapi.json", kind: "openapi", required: true },
      // dataModel 不存在（LLM 没返回），notes 也没有
    ],
    validationRules: [...],
  },
  contracts: { projectManifest: {...}, openapi: {...} },
  diagnostics: [],
}
```

#### 5e. 写入契约文件 — writeContracts()

`writeContracts(outputDir, plannerResult)`（`planner.ts:360-366`）在磁盘上创建：

```
output/restful-polling-api-express/
  docs/
    contracts/
      team-plan.json         <- 完整的 plan 对象（角色+任务+依赖+契约引用）
      project-manifest.json  <- { goal, features, nonFunctionalRequirements, ... }
      openapi.json           <- { openapi: "3.1.0", paths: { "/polls": ..., ... } }
```

每个文件都是 `JSON.stringify(value, null, 2)` 格式化输出，通过 `mkdirSync(dirname, { recursive: true })` 确保目录存在。

**契约文件的内容和作用**：

| 文件 | 内容 | 谁读它 |
|------|------|--------|
| `team-plan.json` | 完整的角色、任务、依赖、验收标准 | 所有 Agent — 了解全局计划和自己的职责 |
| `project-manifest.json` | 项目目标、功能列表、非功能需求 | 所有 Agent — 了解项目要做什么 |
| `openapi.json` | API 路径、请求/响应格式 | api-builder — 按规格实现路由 |
| `data-model.json` | 数据实体和关系（本例无） | db-engineer — 按规格建表 |
| `notes.json` | 风险和交接说明（本例无） | 所有 Agent — 了解注意事项 |

发射事件：

```typescript
{ type: "plan_created", plan: TeamPlan, timestamp: ... }
```

---

### Step 6：创建角色注册表 — planner.ts

`createRoleRegistry(plan)`（`planner.ts:39-45`）把 `plan.roles` 中的 4 个 `RoleSpec` 转换为 `RoleDefinition`：

```typescript
// roleFromSpec (planner.ts:28-37) 对每个 role 做了什么：
roleFromSpec({
  name: "api-builder",
  description: "Implement Express routes...",
  allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  ownedDirectories: ["src"],
  maxTurns: 35,
  systemPrompt: undefined,  // LLM 没提供
})
```

因为 `systemPrompt` 为空，调用 `buildRoleSystemPrompt(spec)` 自动生成（`system-prompts.ts:3-18`）：

```
You are api-builder, a specialist in a dynamic AI engineering team.

Role:
Implement Express routes...

Collaboration contract:
- Read docs/contracts/team-plan.json and docs/contracts/project-manifest.json before changing files.
- If docs/contracts/openapi.json exists, API routes and client calls must follow it exactly.
- If docs/contracts/data-model.json exists, persistence and domain types must follow it.
- Only write files inside your owned paths: src.
- Treat acceptance criteria in the task prompt as mandatory.
- Prefer small, coherent files over unrelated broad rewrites.
- Do not run long-lived services or dependency installation commands unless explicitly approved.
- Report what you changed, which contract entries you satisfied, and anything left unresolved.
```

最终 `roleRegistry` 是一个 `Map<string, RoleDefinition>`：

```
"setup-engineer" -> { ownedDirectories: ["."],      maxTurns: 20, systemPrompt: "..." }
"api-builder"    -> { ownedDirectories: ["src"],     maxTurns: 35, systemPrompt: "..." }
"db-engineer"    -> { ownedDirectories: ["src/db"],  maxTurns: 25, systemPrompt: "..." }
"test-engineer"  -> { ownedDirectories: ["tests"],   maxTurns: 30, systemPrompt: "..." }
```

---

### Step 7：构建 DAG 并调度 — task-graph.ts + task-scheduler.ts

`toGraph(tasks)` 把 4 个任务加入 `TaskGraph`（`task-graph.ts:6-9`）：

```typescript
graph = TaskGraph {
  tasks: Map {
    "task-setup" -> { status: "pending", dependencies: [] },
    "task-db"    -> { status: "pending", dependencies: ["task-setup"] },
    "task-api"   -> { status: "pending", dependencies: ["task-setup"] },
    "task-test"  -> { status: "pending", dependencies: ["task-db", "task-api"] },
  }
}
```

DAG 可视化：

```
  task-setup
    /       \
task-db    task-api
    \       /
    task-test
```

`TaskScheduler` 初始化（`task-scheduler.ts:4`）：

```typescript
scheduler = new TaskScheduler(graph, maxParallel = 2)
// runningCount = 0
```

**`getReadyTasks()` 算法**（`task-graph.ts:25-48`）：
- 遍历所有 status="pending" 的任务
- 检查每个依赖：
  - 如果有依赖 status="failed" -> 该任务被阻塞（blocked = true）
  - 如果有依赖 status 不是 "completed" -> 依赖未满足（allDepsCompleted = false）
- 只有 `!blocked && allDepsCompleted` 的任务才返回

---

### Step 8：第一轮调度 — task-setup（Batch 1）

`runTasks` 的主循环（`team-lead.ts:254`）：

```typescript
while (!scheduler.isDone()) {
  const batch = scheduler.nextBatch();  // 拿到就绪任务
  // ...
}
```

#### Batch 1: `[task-setup]`

`scheduler.nextBatch()`（`task-scheduler.ts:13-18`）：
- `graph.getReadyTasks()` -> 扫描所有 status="pending" 的任务
  - `task-setup`：无依赖 -> 就绪
  - `task-db`：依赖 `task-setup`（pending）-> 未就绪
  - `task-api`：依赖 `task-setup`（pending）-> 未就绪
  - `task-test`：依赖 `task-db`（pending）-> 未就绪
- `slots = 2 - 0 = 2`，就绪 1 个 -> 返回 `[task-setup]`

`scheduler.startTask("task-setup")`（`task-scheduler.ts:21-24`）：
- `graph.markInProgress("task-setup")` -> status 变为 `"in_progress"`
- `runningCount = 1`

发射事件：

```typescript
{ type: "task_start", task: { id: "task-setup", status: "in_progress", ... }, timestamp: ... }
```

#### 创建 Agent — runTeamAgent()

`buildTaskDescription`（`team-lead.ts:43-88`）拼接出完整的任务描述字符串：

```
Project requirement:
Build a RESTful polling API with Express and SQLite...

Team plan summary:
RESTful polling API with Express + SQLite

Assigned role:
setup-engineer - Initialize project structure, install deps, configure SQLite

Task:
Initialize project

Instructions:
Create package.json with express/better-sqlite3/vitest deps. Create src/index.js entry point.

Contract files to read first:
- docs/contracts/team-plan.json (team-plan, required)
- docs/contracts/project-manifest.json (project-manifest, required)
- docs/contracts/openapi.json (openapi, required)

Owned paths:
- .

Expected outputs:
- package.json
- src/index.js

Acceptance criteria:
- package.json has express and better-sqlite3
- src/index.js exists and imports express

Self-check before finishing:
- Run the narrowest relevant checks for your owned area after writing files.
- Backend tasks should at minimum run syntax/load checks such as node --check on changed JS files
  and npm run check or npm test when those scripts exist.
- If a check fails, fix the issue and rerun the check before finalizing.
- Do not run dependency installation or long-lived service commands; the Lead runs controlled
  install and whole-project validation.

Do not rely on prior agent prose summaries. Use the contract files and the actual files in the
workspace as source of truth.
```

然后调用 `runTeamAgent(description, agentConfig)`（`team-agent.ts:99`），创建第一个真正的 Agent。

**`agentConfig` 的完整内容**：

```typescript
agentConfig = {
  role: RoleDefinition {           // <- 从 roleRegistry.get("setup-engineer") 取出
    name: "setup-engineer",
    description: "Initialize project structure...",
    systemPrompt: "You are setup-engineer, a specialist in...\n\nCollaboration contract:\n- Read docs/contracts/team-plan.json...\n- Only write files inside your owned paths: .\n...",
    allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    ownedDirectories: ["."],
    maxTurns: 20,
  },
  model: Model {                   // <- glm-5.1
    id: "glm-5.1",
    provider: "zai",
    ...
  },
  outputDir: "D:\\code\\...\\restful-polling-api-express",
  streamFn: streamSimple,          // <- 来自 @mariozechner/pi-ai
  getApiKey: async (provider) => "sk-xxx",
  parentSignal: abortController.signal,  // <- TeamLead 的 AbortController
  thinkingLevel: undefined,        // -> Agent 内部用 "off"
  interventionMode: undefined,      // -> "none"
  taskId: "task-setup",
  onTaskProgress: (message) => emit({ type: "task_progress", ... }),
  onAgentEvent: (event) => emit({ type: "agent_event", ... }),
  requestApproval: (req) => controls.requestApproval(req),
}
```

#### Agent 内部构造细节 — team-agent.ts

**8a. 构建工具池** — `buildToolPool(role, outputDir)`（`tool-pool.ts:32`）

```typescript
// role.allowedTools = ["read", "write", "edit", "bash", "grep", "find", "ls"]
// TOOL_FACTORIES 中有 7 个工具，全部匹配

tools = [
  createReadTool("D:\\code\\...\\restful-polling-api-express"),   // cwd = outputDir
  createWriteTool("D:\\code\\...\\restful-polling-api-express"),
  createEditTool("D:\\code\\...\\restful-polling-api-express"),
  createBashTool("D:\\code\\...\\restful-polling-api-express"),
  createGrepTool("D:\\code\\...\\restful-polling-api-express"),
  createFindTool("D:\\code\\...\\restful-polling-api-express"),
  createLsTool("D:\\code\\...\\restful-polling-api-express"),
]
```

每个工具的 `cwd` 都指向项目输出目录，所以 Agent 执行 `read` 读 `package.json` 实际读的是 `D:\code\...\restful-polling-api-express\package.json`。

**8b. 创建归属守卫** — `createOwnershipGuard(["."], outputDir)`（`file-ownership.ts:31`）

```typescript
absoluteOwned = [
  resolve("D:\\code\\...\\restful-polling-api-express", ".")
  = "D:\\code\\...\\restful-polling-api-express"
]
// setup-engineer 拥有 "." (项目根目录)，所以它可以在任何位置写文件
```

归属守卫只拦截 `write` 和 `edit` 工具（`file-ownership.ts:39`），不拦截 `bash`。

**8c. 创建 bash 安全守卫** — `createBashSafetyGuard({...})`（`bash-safety.ts:43`）

```typescript
{
  taskId: "task-setup",
  interventionMode: "none",
  requestApproval: (req) => controls.requestApproval(req),
}
```

危险模式列表（`bash-safety.ts:17-23`）：

| 模式 | 匹配的命令 |
|------|-----------|
| `rm -rf` / `rm /s /q` | `rm -rf node_modules` |
| `del /s /q` / `rmdir` | Windows 删除命令 |
| `npm/pnpm/yarn install/add/remove/start` | 依赖安装和服务启动 |
| `npm run dev/start` | 开发服务器 |
| `docker build/up` | Docker 操作 |

安全通道：`mkdir -p src` 会匹配 `SAFE_MKDIR_PATTERN`，直接放行。

**8d. 创建 Agent 实例**（`team-agent.ts:111-136`）

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: "You are setup-engineer, a specialist in...",  // 角色的系统提示
    model: Model { id: "glm-5.1", provider: "zai" },            // LLM 模型
    thinkingLevel: "off",                                         // 未配置 -> off
    tools: [read, write, edit, bash, grep, find, ls],            // 工具池
  },
  streamFn: streamSimple,            // 来自 pi-ai 的流式函数
  getApiKey: async (p) => "sk-xxx",  // API Key 回调
  convertToLlm: convertToLlm,        // 来自 pi-coding-agent，消息格式转换
  beforeToolCall: async (context) => {
    // 第 1 关：归属守卫 -- 只检查 write 和 edit
    const ownershipResult = await ownershipGuard(context);
    if (ownershipResult?.block) return ownershipResult;   // 被挡就返回，不继续

    // 第 2 关：bash 安全 -- 只检查 bash 工具
    const bashResult = await bashSafetyGuard(context);
    return bashResult;
  },
  transformContext: createContractAwareTransformContext(120),  // 上下文压缩
});
```

**8e. 上下文压缩策略**（`team-agent.ts:67-93`）

```typescript
// createContractAwareTransformContext(120) 的行为：
// 当消息数 > 120 条时触发：
//
// 保留的消息:
//   1. 第 1 条消息（系统提示）
//   2. 所有含 "docs/contracts/" 或 "Acceptance criteria:" 的用户消息
//   3. 最近 119 条消息
//
// 去重后返回（通过 seen Set 避免重复）

function createContractAwareTransformContext(maxMessages: number) {
  return async (messages: AgentMessage[]) => {
    if (messages.length <= maxMessages) return messages;

    const systemMsg = messages[0];
    const recent = messages.slice(-(maxMessages - 1));
    const contractMessages = messages.slice(1, -recent.length).filter((message) => {
      if (message.role !== "user") return false;
      const text = /* 提取文本 */;
      return text.includes("docs/contracts/") || text.includes("Acceptance criteria:");
    });
    const merged = [systemMsg, ...contractMessages, ...recent];
    // 去重
    const seen = new Set<AgentMessage>();
    return merged.filter((message) => {
      if (seen.has(message)) return false;
      seen.add(message);
      return true;
    });
  };
}
```

**8f. 注册父级中止监听**（`team-agent.ts:139-153`）

```typescript
// 如果 TeamLead 的 AbortController 被触发 -> 调用 agent.abort()
parentSignal.addEventListener("abort", () => agent.abort(), { once: true });
```

**8g. 注册轮次计数器**（`team-agent.ts:157-165`）

```typescript
agent.subscribe((event) => {
  onAgentEvent(event);          // 转发给 TeamLead -> 转发为 agent_event
  if (event.type === "turn_end") {
    turnsUsed++;
    if (turnsUsed >= 20) {       // maxTurns = 20
      agent.abort();             // 强制中止
    }
  }
});
```

**8h. Agent 开始执行** — `agent.prompt(taskDescription)`（`team-agent.ts:168`）

Agent 的完整 prompt 是上面 `buildTaskDescription` 拼出的那个长文本。Agent 内部会：

1. 用 `systemPrompt` + `taskDescription` 构建初始消息序列
2. 调用 `streamFn`（即 `streamSimple`）发送给 LLM
3. LLM 返回的工具调用会经过 `beforeToolCall` 钩子链
4. 工具执行后结果返回给 Agent，继续下一轮

**setup-engineer Agent 可能执行的操作序列**：

```
Turn 1: LLM -> toolCall: read("docs/contracts/team-plan.json")
         -> 工具返回 JSON 内容
         -> Agent 看到了完整的团队计划

Turn 2: LLM -> toolCall: read("docs/contracts/openapi.json")
         -> Agent 看到了 API 规格

Turn 3: LLM -> toolCall: write("package.json", '{"name":"poll-api", ...}')
         -> beforeToolCall:
           - ownershipGuard: path "." -> ownedDirectories ["."] -> 通过
         -> 文件写入磁盘: D:\...\restful-polling-api-express\package.json

Turn 4: LLM -> toolCall: write("src/index.js", "import express from 'express'; ...")
         -> beforeToolCall:
           - ownershipGuard: "." 归属包含 "src/index.js" -> 通过
         -> 文件写入磁盘

Turn 5: LLM -> toolCall: bash("node --check src/index.js")
         -> beforeToolCall:
           - bashSafetyGuard: "node --check" 不匹配任何危险模式 -> 通过
         -> 执行命令，检查语法

Turn 6: LLM -> 返回文本摘要（不再调用工具）
         -> Agent 结束
```

每一步工具调用时，TeamLead 都会收到事件：

```typescript
{ type: "task_progress", taskId: "task-setup", message: "Blocked write: ...", timestamp: ... }
{ type: "agent_event", taskId: "task-setup", role: "setup-engineer", event: AgentEvent, timestamp: ... }
```

**8i. Agent 结束，收集结果**（`team-agent.ts:168-201`）

```typescript
// 成功时：
return {
  taskId: "",
  success: true,
  output: "I've created package.json and src/index.js...",  // 最后一条 assistant 文本
  filesCreated: ["package.json", "src/index.js"],             // 从 write/edit 工具调用提取
  turnsUsed: 6,
}
```

`extractFinalText` 从消息历史中反向查找最后一条 assistant 文本。`extractFilesCreated` 遍历所有 assistant 消息中的 `write`/`edit` 工具调用，收集 `path` 参数。

回到 `team-lead.ts:296-320`：

```typescript
result.taskId = "task-setup";         // 覆盖为实际 task ID
graph.markComplete("task-setup", result);   // status -> "completed"
results.push(result);
scheduler.finishTask();               // runningCount = 0

emit({ type: "task_end", task: {..., status: "completed"}, result, timestamp: ... });
```

此时磁盘上的文件：

```
restful-polling-api-express/
  docs/contracts/
    team-plan.json
    project-manifest.json
    openapi.json
  package.json                  <- setup-engineer 创建
  src/
    index.js                    <- setup-engineer 创建
```

---

### Step 8 续：第二轮调度 — task-db + task-api（Batch 2）

回到 `while` 循环，`scheduler.nextBatch()`：

- `graph.getReadyTasks()`：
  - `task-db`：依赖 `task-setup`（completed）-> 就绪
  - `task-api`：依赖 `task-setup`（completed）-> 就绪
  - `task-test`：依赖 `task-db`（pending）-> 未就绪
- `slots = 2 - 0 = 2`，就绪 2 个 -> 返回 `[task-db, task-api]`

**两个 Agent 并行创建！** `Promise.allSettled` 同时等待两者完成。

#### Agent 2: task-db (db-engineer)

```typescript
agentConfig = {
  role: {
    name: "db-engineer",
    systemPrompt: "You are db-engineer...\n- Only write files inside your owned paths: src/db\n...",
    allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    ownedDirectories: ["src/db"],         // <- 只能写 src/db 下的文件
    maxTurns: 25,
  },
  model: Model { id: "glm-5.1" },
  outputDir: "D:\\code\\...\\restful-polling-api-express",
  ...
}
```

**归属守卫**：

```typescript
absoluteOwned = [
  resolve(outputDir, "src/db") = "D:\\code\\...\\restful-polling-api-express\\src\\db"
]
```

如果 db-engineer 尝试 `write("src/routes/polls.js")`：

```
beforeToolCall:
  ownershipGuard:
    absPath = resolve(outputDir, "src/routes/polls.js")
    isPathOwnedBy(absPath, ["...\\src\\db"]) -> false
    -> return { block: true, reason: "Cannot write to \"src/routes/polls.js\". This agent only owns: src/db." }
```

**db-engineer Agent 可能执行的操作**：

```
Turn 1: read("docs/contracts/team-plan.json")  -> 看团队计划
Turn 2: read("docs/contracts/openapi.json")     -> 看 API 规格（了解数据结构）
Turn 3: write("src/db/schema.js", "CREATE TABLE polls (...) ...")
         -> 归属检查: src/db/schema.js 在 src/db 下 -> 通过
Turn 4: write("src/db/helpers.js", "export function createPoll() { ... }")
         -> 归属检查: src/db/helpers.js 在 src/db 下 -> 通过
Turn 5: bash("node --check src/db/helpers.js")
         -> 安全检查: 不匹配危险模式 -> 通过
Turn 6: 返回文本
```

#### Agent 3: task-api (api-builder)

```typescript
agentConfig = {
  role: {
    name: "api-builder",
    ownedDirectories: ["src"],            // <- 可以写 src 下任何文件
    maxTurns: 35,
    ...
  },
  ...
}
```

**api-builder 如何读取 db-engineer 的产出？** 见下文 [Agent 之间如何通信](#关键设计agent-之间如何通信)。

**api-builder Agent 可能执行的操作**：

```
Turn 1: read("docs/contracts/openapi.json")     -> 看 API 规格
Turn 2: read("src/db/helpers.js")                -> 看 db-engineer 的实际代码（已写完并存盘）
Turn 3: write("src/routes/polls.js", "import { createPoll, vote, getResults } from '../db/helpers.js'; ...")
         -> 归属检查: src/routes/polls.js 在 src 下 -> 通过
Turn 4: bash("node --check src/routes/polls.js")
         -> 安全检查 -> 通过
Turn 5: 返回文本
```

#### 两个 Agent 并行执行（Promise.allSettled）

```typescript
// team-lead.ts:300
const settledResults = await Promise.allSettled([agent2Promise, agent3Promise]);
// agent2 (db-engineer) 用了 5 轮
// agent3 (api-builder) 用了 5 轮
// 两者并行跑，总耗时 = max(5, 5) 约等于单个 Agent 的时间
```

完成后（`team-lead.ts:301-321`）：

```typescript
for (const settled of settledResults) {
  scheduler.finishTask();    // runningCount 从 2 -> 1 -> 0
  // settled.status === "fulfilled"（假设都成功）
  const { task, result } = settled.value;
  graph.markComplete(task.id, result);
  results.push(result);
  emit({ type: "task_end", ... });
}
```

> **已知缺陷 [C-1]**：如果某个 Agent rejected，`find(in_progress)` 可能匹配到错误的任务。因为 `Promise.allSettled` 返回的数组中，rejected 的元素没有 `value`，代码无法直接知道是哪个 task ID 失败了。

此时磁盘文件：

```
restful-polling-api-express/
  docs/contracts/
    team-plan.json
    project-manifest.json
    openapi.json
  package.json
  src/
    index.js
    db/
      schema.js            <- db-engineer 创建
      helpers.js           <- db-engineer 创建
    routes/
      polls.js             <- api-builder 创建
```

---

### Step 8 续：第三轮调度 — task-test（Batch 3）

`scheduler.nextBatch()`：
- `task-test`：依赖 `task-db`（completed）+ `task-api`（completed）-> 就绪
- `slots = 2 - 0 = 2` -> 返回 `[task-test]`

#### Agent 4: task-test (test-engineer)

```typescript
role: {
  name: "test-engineer",
  ownedDirectories: ["tests"],
  maxTurns: 30,
}
```

test-engineer 先读契约文件，再读 `src/routes/polls.js` 和 `src/db/helpers.js`（这些是前两个 Agent 创建的实际文件），然后写测试：

```
Turn 1: read("docs/contracts/openapi.json")       -> 看 API 规格
Turn 2: read("src/routes/polls.js")               -> 看 api-builder 的实际代码
Turn 3: read("src/db/helpers.js")                 -> 看 db-engineer 的实际代码
Turn 4: write("tests/polls.test.js", "import { describe, it, expect } from 'vitest'; ...")
         -> 归属检查: tests/polls.test.js 在 tests 下 -> 通过
Turn 5: 返回文本
```

---

### Step 9：验证 — validator.ts

所有任务完成后，`team-lead.ts:172`：

```typescript
const issues = await validateTeamOutputWithChecks(outputDir, plan, signal);
```

#### Phase 1：静态检查 -- validateTeamOutput()

| 检查项 | 代码行 | 检查结果 |
|--------|--------|---------|
| 契约文件存在？ | `L353-363` | `docs/contracts/team-plan.json` 通过, `project-manifest.json` 通过, `openapi.json` 通过 |
| task-setup 期望输出？ | `L365-377` | `package.json` 通过, `src/index.js` 通过 |
| task-db 期望输出？ | | `src/db/schema.js` 通过, `src/db/helpers.js` 通过 |
| task-api 期望输出？ | | `src/routes/polls.js` 通过 |
| task-test 期望输出？ | | `tests/polls.test.js` 通过 |
| package.json 有 scripts？ | `L390-399` | 假设有 `"test": "vitest"` -> 通过 |
| OpenAPI 路径在代码中体现？ | `L402-419` | `/polls` -> 通过, `/polls/{pollId}/votes` -> 通过, `/polls/{pollId}/results` -> 通过 |

**OpenAPI 路径匹配的三种模式**（`validator.ts:123-140`）：

```
原始路径: /polls/{pollId}/votes

模式 1 (collapse): /polls//votes  -> 在项目文本中搜索
模式 2 (Express):  /polls/:pollId/votes -> 在项目文本中搜索
模式 3 (段拼接):   polls/votes -> 在项目文本中搜索

任意一种匹配即视为覆盖。
```

> **已知缺陷 [H-3]**：如果 `package.json` 没有 scripts，validator 在 `L394` 会硬编码 `ownerTaskId: "task-api"`, `ownerRole: "api-builder"` -- 但动态计划中可能根本没有这个角色。

> **已知缺陷 [M-4]**：模式 3（段拼接）会把 `polls/votes` 在整个项目文本中搜索。如果注释或文档中出现这个词也会匹配成功，产生假阴性。

#### Phase 2：运行时检查 -- buildRuntimeCommands() + runCommand()

因为 Phase 1 无 error，继续 Phase 2（`validator.ts:429-430`）：

```typescript
const options = {
  installDependencies: true,     // 运行 npm install
  runPackageScripts: true,       // 运行 npm run check / test / build
  runSyntaxChecks: true,         // 运行 node --check
  commandTimeoutMs: 60000,       // 60 秒
  installTimeoutMs: 180000,      // 3 分钟
};
```

生成的命令序列：

```
1. node --check src/index.js          (语法检查, timeout 60s)
2. node --check src/db/schema.js      (语法检查)
3. node --check src/db/helpers.js     (语法检查)
4. node --check src/routes/polls.js   (语法检查)
5. npm install                         (安装依赖, timeout 180s)
6. npm test                            (运行 vitest, timeout 60s)
7. npm run build (如果存在)
```

每个命令按顺序执行（`validator.ts:453-460`），**第一个失败就中断**：

```typescript
for (const command of commands) {
  const result = await runCommand(outputDir, command, options.signal);
  if (result.exitCode !== 0 || result.timedOut) {
    issues.push(issueForCommandFailure(command, result));
    break;   // <- 中断！后续命令不再执行
  }
}
```

> **已知缺陷 [L-12]**：静态检查提前返回会阻止运行时检查发现更多问题。

假设 `npm test` 失败了（比如测试断言错误）：

```typescript
issues = [{
  id: "runtime-check-npm-test",
  severity: "error",
  message: "Runtime check failed: npm test exited with code 1.\nOutput:\nFAIL tests/polls.test.js\n  * create poll -> expected 201, got 500",
  ownerRole: "test-engineer",      // ownerForWholeProjectCheck 匹配到含 "test" 的任务
  ownerTaskId: "task-test",
  file: "package.json",
}]
```

发射事件：

```typescript
{ type: "validation_start", round: 0, timestamp: ... }
{ type: "validation_end", round: 0, issues: [...1 个 error], timestamp: ... }
```

---

### Step 10：修复循环（Round 1）

`hasBlockingIssues(issues)` 返回 `true`（有 severity="error"），`round(0) < maxRepairRounds(2)`（`team-lead.ts:176-228`）。

#### 10a. 创建修复任务 -- createRepairTasks()

```typescript
// planner.ts:368-396
// 按 ownerTaskId 分组：
grouped = Map {
  "task-test" -> [issue: "Runtime check failed: npm test exited with code 1..."]
}

// 为每个 owner 创建修复任务：
repairTasks = [{
  id: "repair-1-task-test",           // 格式: repair-{round}-{originalTaskId}
  role: "test-engineer",
  subject: "Repair Write integration tests",
  description: "Create tests/polls.test.js with vitest tests...\n\nFix these validation issues:\n- runtime-check-npm-test: Runtime check failed: npm test exited with code 1...",
  dependencies: [],                    // 修复任务无依赖，直接执行
  ownedDirectories: ["tests"],
  expectedOutputs: ["tests/polls.test.js"],
  acceptanceCriteria: [...],
  repairOf: ["runtime-check-npm-test"],
}]
```

> **已知缺陷 [M-7]**：无 `ownerTaskId` 的验证问题被 `createRepairTasks` 静默丢弃（`planner.ts:371` 的 `if (!key) continue`）。

发射事件：

```typescript
{ type: "repair_requested", round: 1, issues: [...], tasks: repairTasks, timestamp: ... }
{ type: "plan_updated", plan: ..., reason: "Added 1 repair task(s).", timestamp: ... }
```

#### 10b. 重新调度修复任务

`tasksToRun = repairTasks.map(taskFromSpec)`，回到 `runTasks`：

```
scheduler.nextBatch() -> [repair-1-task-test]
-> 创建 Agent（test-engineer 角色，maxTurns=30）
-> 任务描述中包含失败的详细信息
-> Agent 读取失败的测试输出，修复代码
-> 再次验证
```

修复后如果验证通过（无 error 级 issue），返回成功：

```typescript
{ type: "run_end", result: {
  success: true,
  outputDir: "D:\\code\\...\\restful-polling-api-express",
  tasks: [
    { taskId: "task-setup", success: true, turnsUsed: 6, filesCreated: ["package.json", "src/index.js"] },
    { taskId: "task-db",    success: true, turnsUsed: 5, filesCreated: ["src/db/schema.js", "src/db/helpers.js"] },
    { taskId: "task-api",   success: true, turnsUsed: 5, filesCreated: ["src/routes/polls.js"] },
    { taskId: "task-test",  success: true, turnsUsed: 5, filesCreated: ["tests/polls.test.js"] },
    // 修复任务的 result 也会包含在内
  ],
  totalTurns: 21 + 修复轮次,
  plan: TeamPlan,
  validationIssues: [...可能还有 warning 级别的],
} }
```

如果修复 2 轮后仍有 error，返回失败：

```typescript
{ type: "run_end", result: {
  success: false,
  error: "Validation failed after 2 repair rounds: ...",
  ...
} }
```

---

### 最终磁盘产物

```
D:\code\...\output\restful-polling-api-express\
  docs/
    contracts/
      team-plan.json              <- Step 5e: Planner 写入
      project-manifest.json       <- Step 5e: Planner 写入
      openapi.json                <- Step 5e: Planner 写入
  package.json                    <- Agent 1 (setup-engineer) 写入
  src/
    index.js                      <- Agent 1 (setup-engineer) 写入
    db/
      schema.js                   <- Agent 2 (db-engineer) 写入
      helpers.js                  <- Agent 2 (db-engineer) 写入
    routes/
      polls.js                    <- Agent 3 (api-builder) 写入
  tests/
    polls.test.js                 <- Agent 4 (test-engineer) 写入，可能经修复循环更新
```

---

## 关键设计：Agent 之间如何通信

```
                    +-----------------------------+
                    |     契约文件（磁盘共享）        |
                    |  team-plan.json              | <- 告诉所有 Agent：
                    |  project-manifest.json       |    "项目是什么、有哪些接口"
                    |  openapi.json                |    "API 路径和数据结构"
                    +-------------+----------------+
                                  |
          +-----------------------+--------------------+
          | 所有 Agent 启动时       |                    |
          | 第一步都是 read()       |                    |
          v                        v                    v
    +-------------+        +-------------+       +-------------+
    |Agent 2      |        |Agent 3      |       |Agent 4      |
    |db-engineer  |        |api-builder  |       |test-eng.    |
    |             |        |             |       |             |
    | 写 src/db/  |------->| 读 src/db/  |------>| 读 src/     |
    |             | 文件    | 写 src/     | 文件  | 写 tests/   |
    |             | 系统    | routes/     | 系统  |             |
    +-------------+        +-------------+       +-------------+
         |                       |                      |
         |    每个Agent的任务描述中包含：                |
         |    - 期望读取的契约路径                      |
         |    - 允许写入的 ownedDirectories            |
         |    - expectedOutputs（验证用）               |
         |    - acceptanceCriteria                     |
         +--------------------------------------------+
```

**核心要点**：

1. **Agent 之间从不直接发消息**。它们通过磁盘上的契约文件 + 实际代码文件间接通信
2. **每个 Agent 的任务描述**（由 `buildTaskDescription` 拼接）包含：契约路径、owned paths、expected outputs、acceptance criteria
3. **归属守卫**确保每个 Agent 只能写自己负责的目录
4. **bash 安全守卫**确保不会执行危险命令
5. **上下文压缩**在消息超过 120 条时保留含契约引用的消息
6. DAG 保证 `task-test` 在 `task-db` 和 `task-api` 都完成后才启动——此时文件已存在于磁盘上
7. **修复循环**中，修复 Agent 收到的任务描述包含原始任务说明 + 具体的验证失败信息

---

## 已知缺陷对本流程的影响

| 缺陷 ID | 影响场景 | 严重性 |
|---------|---------|--------|
| C-1 | Batch 2 中如果一个 Agent rejected，`find(in_progress)` 可能归因到另一个 Agent | CRITICAL |
| C-2 | 如果 Planner 生成了循环依赖，调度会卡死，无任务可以执行 | CRITICAL |
| H-3 | 静态检查发现 package.json 无 scripts 时，修复任务路由到不存在的 "task-api" 角色 | HIGH |
| H-4 | Agent 可以通过 `rm file.txt`（不带 -rf）绕过 bash 安全 | HIGH |
| H-5 | Agent 可以通过 `bash("echo content > ../other-dir/file.txt")` 绕过归属限制 | HIGH |
| M-4 | OpenAPI 路径匹配模式 3（段拼接）可能产生假阴性 | MEDIUM |
| M-7 | 无 ownerTaskId 的验证问题被静默丢弃，不会被修复 | MEDIUM |
| M-9 | `validationRules` 字段写入契约但从未被消费 | MEDIUM |
| L-12 | 静态检查有 error 时不执行运行时检查，可能遗漏更多问题 | LOW |
