---
name: refactor
description: Refactor code for better structure, readability, or performance. Use when asked to refactor, clean up, simplify, or reorganize code.
---

# Refactor

Improve code structure without changing behavior.

## Strategy

1. Read the target code thoroughly
2. Identify what needs improvement:
   - Duplicated logic -> extract shared functions
   - Long functions -> break into smaller pieces
   - Poor naming -> rename for clarity
   - Complex conditionals -> simplify or extract
   - Missing types -> add type annotations
3. Plan changes before making them
4. Make changes incrementally, verifying at each step

## Rules

- Preserve external behavior -- refactoring must not change what the code does
- Run existing tests after changes if available
- Keep the scope focused -- only refactor what was asked for
- If a refactor reveals bugs, fix them but note it separately

## Output Format

### Changes Made
1. What was changed and why
2. ...

### Files Modified
- `path/to/file.ts` - what changed

### Before/After (key changes)
Show the most significant transformation briefly.

### Verification
How the refactor was verified (tests, manual check, type check).
