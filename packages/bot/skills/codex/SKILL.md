---
name: codex
description: Delegate coding tasks to Codex (OpenAI coding agent). Use when asked to write code, refactor, debug, review PRs, or any task that involves reading/editing code files and running commands in a project.
---

# Codex Delegation

Use the `codex` tool to delegate coding tasks to Codex, an AI coding agent running locally. Codex can read files, edit code, run commands, and manage git -- all within a sandboxed project directory.

## When to Use

- Writing or modifying code
- Refactoring
- Debugging and fixing bugs
- Code review (PR or uncommitted changes)
- Running tests, builds, lints

## When NOT to Use

- Simple questions you can answer directly ("what does this function do?")
- Information lookups (use web_search or memory_search)
- Non-coding tasks (file organization, scheduling, etc.)
- If you can answer a code question from memory, do it yourself

## Actions

### ask -- Send a coding task

```
codex(action="ask", prompt="<detailed task>", cwd="<project dir>")
```

- `prompt`: Be specific. Include file paths, function names, desired behavior.
- `cwd`: Project directory. **Different cwd = different codex thread** (project isolation). Always specify for clarity.
- `model`: Optional model override (e.g., "o3", "gpt-4.1").

### review -- Code review

```
codex(action="review", cwd="<project dir>")
codex(action="review", cwd="<project dir>", base="main")
codex(action="review", cwd="<project dir>", uncommitted=false, base="main")
```

- Default: reviews uncommitted changes
- `base`: compare against a branch (e.g., "main", "develop")
- `uncommitted`: set to `false` to only review committed changes vs base

### respond -- Reply to approval requests

```
codex(action="respond", requestId=<id>, response={decision: "accept"})
```

See the Approval Flow section below for details.

### interrupt -- Stop current task

```
codex(action="interrupt", cwd="<project dir>")
```

Stops the current codex turn. Use when the task is going in the wrong direction or taking too long.

## Approval Flow (Critical)

Codex requests approval before running commands or editing files. This is the core interaction loop:

### Step 1: Send task

```
codex(action="ask", prompt="Add input validation to the signup form", cwd="/home/user/myapp")
```

### Step 2: Read the result

Codex returns a `TurnResult` with:
- `status`: "completed" | "waiting_approval" | "interrupted" | "failed"
- Pending requests (if status is "waiting_approval")

Example output:
```
[Codex] Status: waiting_approval

Output:
I'll add input validation. Let me first check the current form implementation.

Pending requests:
  [commandExecution] (id: 1): Command: cat src/components/SignupForm.tsx [decisions: accept, acceptForSession, decline, cancel]

Use action="respond" with requestId and response to approve/decline each.
```

### Step 3: Review and approve/decline each request

For each pending request, evaluate safety and relevance, then respond:

```
codex(action="respond", requestId=1, response={decision: "accept"})
```

### Step 4: Repeat until completed

After responding, codex continues working. It may request more approvals. Keep reviewing and responding until `status: "completed"`.

### Decision options

| Request type | Decisions | Notes |
|---|---|---|
| commandExecution | accept, acceptForSession, decline, cancel | `acceptForSession` auto-approves similar commands for the rest of this task |
| fileChange | accept, acceptForSession, decline, cancel | Same as above |
| permissions | Varies -- check the request | Respond with `{permissions: {...}, scope: "turn" or "session"}` |
| userInput | N/A | Respond with `{answers: {questionId: "answer", ...}}` |

### Safety rules for approval

- **Read-only commands** (cat, ls, grep, find, git log, git diff): Generally safe to accept
- **Build/test commands** (npm test, npm run build, cargo test): Generally safe
- **File modifications** (write, edit, patch): Review the changes described before accepting
- **Destructive commands** (rm, git reset, DROP TABLE): **Decline** unless the user explicitly asked for this
- **Package installation** (npm install, pip install): Review what's being installed
- When in doubt, **decline** and ask the user

## Tips

- Give codex **specific, detailed prompts**. "Fix the bug" is bad. "Fix the TypeError in src/auth.ts:42 where `user.email` is undefined when OAuth callback has no email scope" is good.
- Use `cwd` consistently for the same project. Different cwd values create separate threads with separate context.
- If codex gets stuck in a loop (requesting the same approval repeatedly), use `interrupt` and try a different approach.
- After codex completes, summarize what it did for the user in natural language. Don't paste raw codex output.
