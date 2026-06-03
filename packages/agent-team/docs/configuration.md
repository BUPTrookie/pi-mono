# agent-team 配置说明

复制 `agent-team.example.json` 为 `agent-team.json`，按需修改。

```bash
cp agent-team.example.json agent-team.json
```

`agent-team.json` 已被 gitignore，不会被提交。

## 配置文件发现顺序

1. `--config <path>` 显式指定
2. `./agent-team.json` 当前工作目录
3. `~/.pi/agent-team.json` 用户主目录

首个找到即生效，不叠加。

## 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `outputDir` | `string` | `"./output"` | 项目输出根目录，每次运行在其下创建子目录 |
| `model` | `object` | 见下方 | 模型配置 |
| `maxParallelAgents` | `number` | `2` | 最大并行 Agent 数 |
| `thinkingLevel` | `string` | `"off"` | 推理深度：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `maxRepairRounds` | `number` | `2` | 最大修复轮次 |
| `interventionMode` | `string` | `"none"` | 人工干预：`none` / `approval` / `interactive` |
| `supervisionMode` | `string` | `"milestone"` | Supervisor 审查：`off` / `milestone` |
| `permissionMode` | `string` | `"open"` | 文件权限：`open`（不限制）/ `owned`（限制在角色目录内） |
| `executionMode` | `string` | `"open"` | 执行权限：`open`（允许所需命令）/ `restricted`（限制安装和长驻服务） |
| `approvalPolicy` | `string` | `"minimal"` | 审批策略：`minimal`（仅高风险）/ `strict`（中+高风险） |

## model 配置

```json
"model": {
    "provider": "提供商标识",
    "model": "模型ID",
    "apiKey": "API密钥（可选，可走环境变量）",
    "baseUrl": "自定义端点（可选）"
}
```

### 情况一：内置 Provider（推荐）

pi-ai 底层已注册的 provider，只需 `provider` + `model`，不需要 `baseUrl`。API Key 通过环境变量提供。

**智谱 (zai)**：

```json
{
    "provider": "zai",
    "model": "glm-5.1"
}
```

环境变量：`ZAI_API_KEY`

可用模型：`glm-4.5-air`、`glm-4.7`、`glm-5-turbo`、`glm-5.1`、`glm-5v-turbo`

**Anthropic**：

```json
{
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
}
```

环境变量：`ANTHROPIC_API_KEY`

**OpenAI**：

```json
{
    "provider": "openai",
    "model": "gpt-4o"
}
```

环境变量：`OPENAI_API_KEY`

**OpenRouter**：

```json
{
    "provider": "openrouter",
    "model": "deepseek-chat"
}
```

环境变量：`OPENROUTER_API_KEY`

**Google**：

```json
{
    "provider": "google",
    "model": "gemini-2.5-pro"
}
```

环境变量：`GOOGLE_API_KEY`

### 情况二：未注册的 OpenAI 兼容 Provider

对于 ModelRegistry 中没有注册的 provider（如 DeepSeek 官方 API），需要提供 `baseUrl` 和 `apiKey`。系统会借一个已注册的 openai-completions 模板来连接。

**DeepSeek 官方**：

```json
{
    "provider": "openrouter",
    "model": "deepseek-chat",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-your-deepseek-key"
}
```

> `provider` 字段随便填一个已注册的（如 `openrouter`），实际连接由 `baseUrl` 决定。`apiKey` 也可以用环境变量 `OPENROUTER_API_KEY`。

**其他 OpenAI 兼容服务**（本地部署、第三方代理等）：

```json
{
    "provider": "openrouter",
    "model": "your-model-id",
    "baseUrl": "https://your-service.example.com/v1",
    "apiKey": "your-key"
}
```

### 情况三：CLI 参数覆盖

不需要改配置文件，直接用 CLI 参数一次性覆盖：

```bash
node dist/main.js "你的需求" --provider zai --model glm-5.1
node dist/main.js "你的需求" --model openrouter/deepseek-chat --base-url https://api.deepseek.com --api-key sk-xxx
```

`--model` 支持 `provider/model` 格式，等同于分别指定 `--provider` 和 `--model`。

## 完整示例

最简配置（用智谱 GLM-5.1）：

```json
{
    "outputDir": "./output",
    "model": {
        "provider": "zai",
        "model": "glm-5.1"
    },
    "maxParallelAgents": 2
}
```

全字段配置：

```json
{
    "outputDir": "./output",
    "model": {
        "provider": "zai",
        "model": "glm-5.1"
    },
    "maxParallelAgents": 2,
    "thinkingLevel": "off",
    "maxRepairRounds": 2,
    "interventionMode": "none",
    "supervisionMode": "milestone",
    "permissionMode": "open",
    "executionMode": "open",
    "approvalPolicy": "minimal"
}
```

严格隔离模式（恢复角色写权限限制）：

```json
{
    "outputDir": "./output",
    "model": {
        "provider": "zai",
        "model": "glm-5.1"
    },
    "maxParallelAgents": 2,
    "permissionMode": "owned",
    "executionMode": "restricted",
    "approvalPolicy": "strict"
}
```
