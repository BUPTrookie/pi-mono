---
name: git-commit
description: Create a well-formed git commit. Use when asked to commit changes, stage files, or prepare a commit message.
---

# Git Commit

Create a well-formed git commit with a clear message.

## Strategy

1. Run `git status` to see what changed
2. Run `git diff` (and `git diff --staged` if there are staged files) to understand the changes
3. Run `git log --oneline -5` to see the project's commit message style
4. Draft a commit message that matches the project style

## Commit Message Rules

- First line: concise summary (50-72 chars), imperative mood ("Add feature" not "Added feature")
- Match the project's existing style (conventional commits, prefixes, etc.)
- If the project uses `type(scope): message` format, follow it
- Body (if needed): explain why, not what -- the diff shows what changed

## Safety

- Never use `git add -A` or `git add .` -- add specific files
- Never use `--force`, `--no-verify`, or `--hard`
- Show the user what will be committed before committing
- If unsure about what to include, ask

## Output

Show the user:
1. Files to be committed (from git status)
2. The proposed commit message
3. Ask for confirmation before executing `git commit`
