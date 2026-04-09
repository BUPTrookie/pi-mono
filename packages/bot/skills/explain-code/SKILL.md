---
name: explain-code
description: Explain how code works. Use when asked to explain, walk through, or describe a piece of code, file, function, or system.
---

# Explain Code

Read and explain code clearly and concisely.

## Strategy

1. Read the target file(s)
2. If the user points to a specific function/class, focus there
3. If broader, trace the call flow from entry points
4. Explain at the right level -- match the user's apparent expertise

## Output Format

### What It Does
One paragraph summary of the code's purpose.

### How It Works
Step-by-step walkthrough of the logic:
1. First, ...
2. Then, ...
3. Finally, ...

### Key Details
- Important types, interfaces, or data structures
- Non-obvious behavior or edge cases
- Dependencies on external code

### Diagram (if helpful)
Simple ASCII diagram of data flow or architecture:
```
Input -> ProcessA -> ProcessB -> Output
              |
              v
          SideEffect
```

Keep explanations practical. Prioritize "why" over "what" when the code is self-evident.
