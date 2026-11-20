---
name: petri
description: Show the agent its own usage as a roguelite organism grown from Claude Code transcripts — fitness, damage ledger, traits and concrete mutations for the next run. Use when asked "/petri", "how am I doing", "review my tool usage", or at the start of a long session to learn from the previous runs.
---

# Petri

Text report for this project's lineage (latest run first, then trend):

```bash
petri --report
```

If `petri` is not on the PATH, run `bun link` once in the Petri checkout, or call `bun <petri checkout>/src/cli.ts --report`.

- `--all` scores every project; a path to a `.jsonl` scores one transcript.
- Without `--report` it also writes and opens the visual dish (`--no-open` to skip the browser).

Read the "mutations for next run" lines and apply them in this session. Tell the user the fitness score and the single biggest mutation in one line, nothing more unless asked.
