# Changelog

## [Unreleased]

### Added
- Codex app-server integration: direct JSON-RPC over stdio communication with codex, replacing the third-party `codex-mcp-server` MCP wrapper. The bot now acts as a native codex client -- creating threads, sending turns, receiving streaming output, and handling approval requests (command execution, file changes, permissions). The LLM sees a single `codex` tool with ask/review/respond/interrupt actions and acts as the human reviewer for codex operations.
- Layered memory system: daily logs (`memory/YYYY-MM-DD.md`) for session notes alongside long-term `MEMORY.md`
- `memory_search` tool: BM25 keyword search across all memory files with CJK bigram support
- Pre-compaction auto-flush: automatically saves context excerpts to daily log when context reaches 70% capacity
- Skills support: load reusable prompt modules from `{dataDir}/skills/` (global) and `{dataDir}/{channel}/{chatId}/skills/` (conversation-level), conversation-level skills override global ones on name collision
- 13 built-in skills: find-skills, writing-plans, executing-plans, systematic-debugging, test-driven-development, verification-before-completion, brainstorming, code-review, scout, summarize, git-commit, explain-code, refactor
- Events watcher: scheduled tasks via JSON files in `{dataDir}/events/`, supports immediate, one-shot (ISO 8601 time), and periodic (cron) events
- MCP (Model Context Protocol) support: connect to external tool servers via `mcpServers` config, tools are auto-discovered and available to the agent as `mcp__{server}__{tool}`
- Initial bot package with multi-platform IM bot architecture
- Channel abstraction layer with CLI, Telegram, and Feishu implementations
- Message bus with per-conversation serial queue
- Agent runner integrating AgentSession for each conversation
- Tools: bash, read, write, edit
- Session store with per-conversation directory management
- System prompt builder
- CLI mode for development and testing
