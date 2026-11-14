/** Test fixtures: a builder that writes transcripts shaped like Claude Code's JSONL. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmp } from 'node:os';
import { join } from 'node:path';
import { parseRun } from '../src/parse.ts';
import { score } from '../src/score.ts';
import type { PetriEvent, Run, ScoredRun } from '../src/types.ts';

export const SID = '11111111-2222-3333-4444-555555555555';

type Json = Record<string, unknown>;
export type Usage = Json | null;

export function usage({ out = 100, think = 80, inp = 5, cacheRead = 1000, cacheCreate = 0 } = {}): Json {
  return {
    input_tokens: inp, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
    output_tokens: out, output_tokens_details: { thinking_tokens: think },
  };
}
export const USAGE = usage();

const made: string[] = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

export function tmpdir(): string {
  const d = mkdtempSync(join(osTmp(), 'petri-test-'));
  made.push(d);
  return d;
}

/** A tool call spec: [name, input, result?, isError?]. */
export type CallSpec = [name: string, input: unknown, result?: unknown, isError?: boolean];

interface Sub { agentId: string; toolUseId: string | undefined; lines: Json[]; meta: true | string | null }

export interface TranscriptOptions { sid?: string; cwd?: string; start?: number; model?: string; sidechain?: boolean }

/** Fluent builder. Every line gets a timestamp one second after the previous one by default. */
export class Transcript {
  sid: string;
  cwd: string;
  model: string;
  clock: number;
  sidechain: boolean;
  lines: Json[] = [];
  subs: Sub[] = [];
  private tid = 0;
  private mid = 0;

  constructor({ sid = SID, cwd = '/w', start = 1_790_000_000, model = 'claude-test', sidechain = false }: TranscriptOptions = {}) {
    this.sid = sid; this.cwd = cwd; this.model = model; this.clock = start; this.sidechain = sidechain;
  }

  // -- low level --------------------------------------------------------------
  stamp(dt = 1): string {
    this.clock += dt;
    return new Date(this.clock * 1000).toISOString();
  }

  base(type: string, dt = 1, extra: Json = {}): Json {
    return { type, timestamp: this.stamp(dt), cwd: this.cwd, sessionId: this.sid, isSidechain: this.sidechain, ...extra };
  }

  raw(d: Json): this {
    this.lines.push(d);
    return this;
  }

  // -- user side ----------------------------------------------------------------
  prompt(text: unknown, extra: Json = {}, dt = 1): this {
    this.lines.push(this.base('user', dt, { message: { role: 'user', content: text }, ...extra }));
    return this;
  }

  /** items: [toolUseId, content, isError]. */
  results(items: [string, unknown, boolean][], toolUseResult?: Json, dt = 1): this {
    const content = items.map(([id, res, err]) => ({ type: 'tool_result', tool_use_id: id, content: res, is_error: err }));
    const d = this.base('user', dt, { message: { role: 'user', content } });
    if (toolUseResult !== undefined) d.toolUseResult = toolUseResult;
    this.lines.push(d);
    return this;
  }

  // -- assistant side ----------------------------------------------------------------
  /** Real transcripts write one line per content block, repeating the message id and usage. */
  assistant(blocks: Json[], { use = USAGE as Usage, mid = undefined as string | undefined, dt = 1, extra = {} as Json } = {}): string {
    const id = mid ?? `msg_${++this.mid}`;
    let step = dt;
    for (const b of blocks) {
      this.lines.push(this.base('assistant', step, { message: { id, role: 'assistant', model: this.model, content: [b], usage: use }, ...extra }));
      step = 0;
    }
    return id;
  }

  say(text: string, opts: Parameters<Transcript['assistant']>[1] = {}): this {
    this.assistant([{ type: 'text', text }], opts);
    return this;
  }

  /** One assistant turn with several tool_use blocks. */
  calls(specs: CallSpec[], { use = USAGE as Usage, results = true, toolUseResult = undefined as Json | undefined, thinking = false } = {}): string[] {
    const uses: Json[] = [], items: [string, unknown, boolean][] = [];
    for (const [name, input, result = 'ok', err = false] of specs) {
      const id = `toolu_${++this.tid}`;
      uses.push({ type: 'tool_use', id, name, input });
      items.push([id, result, err]);
    }
    this.assistant([...(thinking ? [{ type: 'thinking', thinking: '', signature: 'x' }] : []), ...uses], { use });
    if (results) this.results(items, toolUseResult);
    return items.map(i => i[0]);
  }

  call(name: string, input: unknown, result: unknown = 'ok', err = false, opts: Parameters<Transcript['calls']>[1] = {}): string {
    return this.calls([[name, input, result, err]], opts)[0]!;
  }

  compact({ pre = 100_000, post = 5_000, trigger = 'auto', summary = true } = {}): this {
    this.lines.push(this.base('system', 1, { subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { preTokens: pre, postTokens: post, trigger } }));
    if (summary) this.prompt('This session is being continued from a previous conversation.', { isCompactSummary: true });
    return this;
  }

  /** Attach a subagent transcript. meta: true writes meta.json, a string writes it verbatim, null skips it. */
  subagent(agentId: string, { toolUseId = undefined as string | undefined, calls = 2, errors = 0, meta = true as true | string | null, out = 50 } = {}): this {
    const sub = new Transcript({ sid: this.sid, cwd: this.cwd, start: this.clock, model: 'claude-sub', sidechain: true });
    for (let i = 0; i < calls; i++) {
      const bad = i < errors;
      sub.call('Bash', { command: `echo ${i}` }, bad ? 'Exit code 1' : 'ok', bad, { use: usage({ out }) });
    }
    this.subs.push({ agentId, toolUseId, lines: sub.lines, meta });
    return this;
  }

  // -- output ----------------------------------------------------------------------
  write(root?: string, name?: string): string {
    const dir = root ?? tmpdir();
    mkdirSync(dir, { recursive: true });
    const stem = name ?? this.sid;
    const f = join(dir, `${stem}.jsonl`);
    writeFileSync(f, this.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    for (const s of this.subs) {
      const sd = join(dir, stem, 'subagents');
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, `agent-${s.agentId}.jsonl`), s.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      if (s.meta === true) writeFileSync(join(sd, `agent-${s.agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: s.toolUseId }));
      else if (typeof s.meta === 'string') writeFileSync(join(sd, `agent-${s.agentId}.meta.json`), s.meta);
    }
    return f;
  }

  run(): ScoredRun {
    return score(parseRun(this.write()));
  }

  parse(): Run {
    return parseRun(this.write());
  }
}

export const tools = (r: Run) => r.events.filter(e => e.tool);
export const kinds = (r: Run) => r.events.map(e => e.k);
export const flags = (r: Run) => tools(r).map(e => e.flags ?? []);
export const dmg = (r: Run) => tools(r).map(e => e.d ?? 0);
export const first = (r: Run): PetriEvent => tools(r)[0]!;

/** A scored run with `calls` single-call turns, the first `errors` of them failing. */
export function makeRun({ calls = 25, errors = 0, start = 1_790_000_000, sid = undefined as string | undefined, prompt = 'task' } = {}): ScoredRun {
  const t = new Transcript({ sid: sid ?? `${Math.floor(start).toString(16)}-0000-0000-0000-000000000000`, start });
  t.prompt(prompt);
  for (let i = 0; i < calls; i++) {
    const bad = i < errors;
    t.call('Bash', { command: `step ${i}` }, bad ? 'Exit code 1\nboom' : 'ok', bad);
  }
  return t.run();
}

/** A test that must fail until a known gap is fixed; it fails loudly once the gap closes. */
export function knownGap(reason: string, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(`known gap now passes, remove the knownGap marker: ${reason}`);
  };
}
