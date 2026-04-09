---
name: scout
description: Fast codebase reconnaissance. Use when asked to explore, understand, or find code in a repository. Returns structured findings with file paths, key code, and architecture overview.
---

# Codebase Scout

Quickly investigate a codebase and return structured findings.

## Strategy

1. Use bash with `find`, `grep`, `ls` to locate relevant code
2. Use read to inspect key sections (not entire files -- focus on relevant parts)
3. Identify types, interfaces, key functions
4. Note dependencies between files

## Thoroughness (infer from task, default medium)

- **Quick**: Targeted lookups, key files only
- **Medium**: Follow imports, read critical sections
- **Thorough**: Trace all dependencies, check tests and types

## Output Format

### Files Retrieved
List with exact line ranges:
1. `path/to/file.ts` (lines 10-50) - Description of what's here
2. `path/to/other.ts` (lines 100-150) - Description

### Key Code
Critical types, interfaces, or functions (paste actual code, not paraphrasing):

```
interface Example {
  // actual code from the files
}
```

### Architecture
Brief explanation of how the pieces connect.

### Start Here
Which file to look at first and why.
