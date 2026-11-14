# Petri

A roguelite organism grown from your Claude Code sessions. Every session is a run. Every tool call grows the creature. Mistakes leave scars. The lineage remembers.

```bash
bun install                       # once: dev tools, then builds the browser renderer
bun run petri                     # this project's runs → writes dish.html and opens it
bun run petri --all               # every project under ~/.claude/projects
bun run petri --report            # text only, for agents (also installed as the /petri skill)
bun run petri path/to.jsonl       # one transcript
bun run test                      # build, type-check, full test suite
```

TypeScript on Bun. Bun runs the command line straight from source, bundles the browser renderer into `dist/app.js`, and runs the tests. TypeScript is a dev tool for type checking only, because Bun doesn't check types. There are no runtime dependencies, and nothing leaves the machine. The dish is one self-contained HTML file: `dish.html#run=12&end` deep-links run 12, fully grown.

| Path | What it is |
|---|---|
| `src/parse.ts` | Transcript JSONL into events, token totals, timing, subagent stats |
| `src/score.ts` | Stats, damage ledger, fitness, traits, hints |
| `src/report.ts` | Lineage and the text report |
| `src/collect.ts` | Finding transcripts for a working directory |
| `src/cli.ts` | Command line |
| `src/dish.ts` | Assembles the dish from template, bundle and data |
| `src/render/grow.ts` | Organism growth geometry, shared by the browser and the tests |
| `src/render/app.ts` | The dish in the browser: replay, hover, panel, lineage strip |
| `src/render/dish.html` | The dish template |

## What grows what

| Transcript | Organism |
|---|---|
| user prompt | a new tendril from the nucleus |
| tool call | a node on the tendril; size = tokens moved (result size + output tokens) |
| Read / Grep / Glob / web / read-only Bash | cyan (sense) |
| Edit / Write / writing Bash | magenta (act) |
| other Bash | amber (run) |
| Agent | violet node with a bud; bud size = the subagent's call count |
| final text answer | pale mint bulb |
| parallel calls in one turn | a fan off the same joint |
| tool error | red scar, tendril kinks |
| context compaction | molt: everything before it fades to shed skin; red tick on the timeline |

The ring around the nucleus is fitness. The bar at the bottom replays the run; the context meter shows how full the window was at that moment.

## Fitness

Damage per 100 actions, subtracted from 100. Ledger:

| Event | Damage | Detection |
|---|---|---|
| error | 3 | `is_error` tool result |
| reread | 2 | Read of a file/range already read and not edited since |
| fat | 1 per 10k over | tool result over 10k chars (cap 8) |
| retry | 2 | identical call repeated right after it errored |
| thrash | 5 | three errors in a row |
| molt | 5 | context compaction |

Runs under 20 actions are scored as if they had 20, so a tiny run can't tank on one slip.

Traits: Clean Run, Batcher (≥1.5 calls/turn), Surgeon, Eidetic (no rereads), Delegator, Forager, Deep Thinker, Marathon, and the bad ones: Glutton, Scarred, Molted. "Mutations for next run" are the hints, ordered by damage.

## Tests

```bash
bun run test          # build, type-check, then 187 tests in about 5 seconds
bun run test:corpus   # every real transcript in ~/.claude/projects must parse and hold the invariants
bun run test:fuzz     # 5,000 random sessions instead of 300
```

Tests use Bun's runner, `bun:test`. Plain `bun test` skips the build and type check.

| File | Covers |
|---|---|
| `tests/helpers.ts` | Builder that writes transcripts in Claude Code's JSONL shape, subagents included |
| `classify.test.ts` | Shell command classification, summaries, sizes, timestamps, JSONL reading, Python-compatible rounding |
| `parse.test.ts` | Prompts, talk, usage accounting, tool pairing, turns, compactions, timing, noise lines, subagents |
| `flags.test.ts` | Reread, oversized result, retry and error-streak detection, with boundaries |
| `score.test.ts` | Stats, the damage ledger, fitness, every trait threshold, hints and their order |
| `lineage.test.ts` | Lineage aggregates, trend, best run, the agent-facing report |
| `cli.test.ts` | Finding projects from a working directory, the CLI, dish output and script-injection safety |
| `invariants.test.ts` | Seeded random sessions checked against invariants, including determinism |
| `grow.test.ts` | Growth geometry: determinism, node counts, staying inside the dish, parallel fans, molts, buds |
| `render.test.ts` | Headless Chrome renders the dish with no script errors and escaped text; skipped without Chrome |
| `corpus.test.ts` | Opt-in scan of your real transcripts |

Tests wrapped in `knownGap` record known heuristic gaps. Shell writes don't invalidate the reread cache, and heredoc scripts that write files are classified as "run". Each of these tests passes while its gap exists. Once a gap is fixed, its test fails and asks for the marker to be removed.

Scores were first defined in Python. The TypeScript port rounds half to even and slices strings by code point, the way Python does. Before the Python version was deleted, both produced identical JSON for all 125 real sessions and identical reports for all 36 projects. The same check was repeated when moving from Node to Bun.

## Limits

- Subagent runs are summarized onto their Agent node, not scored into the parent's fitness.
- Bash is classified by its first verb; a heredoc'd script that writes files still reads as "run".
- Only the last 40 runs embed full events (`--runs N`); older runs keep stats and a fitness dot.
