# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                    # Install all dependencies
npm run build                  # Build all packages (order: tui -> ai -> agent -> coding-agent -> mom -> bot -> web-ui -> pods)
npm run check                  # Format (biome), lint, type check (tsgo), browser smoke test. Requires build first.
./test.sh                      # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh                   # Run pi from source (can be run from any directory)
```

Run a single test (from the package root, not repo root):
```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

**Do not run** `npm run dev`, `npm run build`, or `npm test` unless explicitly asked.

## Architecture

This is a TypeScript monorepo (npm workspaces) for building AI coding agents. Packages are published under `@mariozechner/` scope.

### Package Dependency Graph

```
tui (terminal UI library)
ai (unified LLM API, 20+ providers) --> depends on tui
agent (agent runtime, tool calling) --> depends on ai
coding-agent (interactive CLI)       --> depends on agent, ai, tui
mom (Slack bot)                      --> depends on coding-agent
bot (multi-platform bot)             --> depends on coding-agent
web-ui (Lit web components)          --> depends on ai
pods (vLLM GPU pod CLI)              --> depends on ai
```

### Key Entry Points

- `packages/ai/src/stream.ts` - Central stream dispatcher, routes to provider-specific stream functions
- `packages/ai/src/types.ts` - Core types: `Api`, `Model`, `AssistantMessageEventStream`, provider option types
- `packages/agent/src/` - Agent runtime with transport abstraction and state management
- `packages/coding-agent/src/` - Interactive CLI with session management, tools (read/edit/write/bash)
- `packages/coding-agent/src/core/model-resolver.ts` - Default model IDs per provider

## Code Style

- **Formatting**: Biome (not ESLint/Prettier). Tab indentation, 3-space tab width, 120 char line width
- **TypeScript**: Strict mode, ES2022 target, Node16 modules. Uses `tsgo` for type checking (`npm run check`)
- **No inline imports**: Never use `await import()` or dynamic type imports. Always use standard top-level imports.
- **No `any`**: Avoid `any` types. Check `node_modules` for external API type definitions instead of guessing.
- **No emojis** in commits, issues, PR comments, or code
- **No fluff**: Keep answers short, technical, direct

## Testing

- Vitest for all testing
- Tests live in `packages/*/test/`
- Run tests from the **package root**, not the repo root
- When creating/modifying a test file, run it and iterate until it passes
- Many tests require provider API keys and are skipped without them

## Adding a New LLM Provider

Requires changes across these files (in order):
1. `packages/ai/src/types.ts` - Add to `Api` union, create options interface, update `ApiOptionsMap`
2. `packages/ai/src/providers/<provider>.ts` - Stream function, message conversion, event emission
3. `packages/ai/src/stream.ts` - Import, credential detection, option mapping, add to `streamFunctions`
4. `packages/ai/scripts/generate-models.ts` - Model fetching logic
5. `packages/ai/test/` - Add provider to all existing test files (stream, tokens, abort, etc.)
6. `packages/coding-agent/src/core/model-resolver.ts` - Default model ID
7. Update `packages/ai/README.md` and `CHANGELOG.md`

## Git & PR Workflow

- Pre-commit hook runs `npm run check` via Husky
- Never use `git add -A` or `git add .` - always stage specific files
- Include `fixes #<number>` or `closes #<number>` in commit messages for linked issues
- Never commit unless asked. Never force push.
- Feature branches merged into main, then pushed

## Lockstep Versioning

All packages share the same version. Release via:
```bash
npm run release:patch   # Bug fixes and new features
npm run release:minor   # API breaking changes
```

Each package has its own `CHANGELOG.md` with `## [Unreleased]` sections. Entries use format: `Fixed foo bar ([#123](link))`

## GitHub Issue Labels

`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`

## agent-team Package

`packages/agent-team` — 多 Agent 团队编排系统，用于全栈开发自动化。

**项目文档**：`packages/agent-team/docs/project-status.md` — 记录已完成部分、存在问题、后续改进路线。修改此包前请先阅读。

- 构建：`cd packages/agent-team && npx tsgo -p tsconfig.build.json`
- 测试：`cd packages/agent-team && npx tsx ../../node_modules/vitest/dist/cli.js --run`
- 运行：`node packages/agent-team/dist/main.js --requirement "..." --output ./output`
