import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { baseTool, classifyCall, DMG, EDIT_TOOLS, FAT, resultSize, stripWrappers, summarize, textOf, ts } from './classify.ts';
import { iterJson } from './jsonl.ts';
import { stats } from './score.ts';
import type { Flag, PetriEvent, Run, SubStats, Tokens } from './types.ts';
import { collapse, cut, isRecord, pyRound, stableStringify } from './util.ts';

/**
 * User lines Claude Code writes on its own that are not wrapped in one closed tag: an unclosed agent message, an interruption.
 * Lines made only of tag blocks (slash commands, ! shell mode, task notices, reminders) are dropped by stripWrappers.
 */
const SKIP_PROMPT = ['<agent-message', '[Request interrupted'];

type Json = Record<string, unknown>;

/** A tool call while its result is outstanding: the event plus bookkeeping stripped before output. */
interface Pending extends PetriEvent {
  id?: string;
  sig?: string;
}

/** Cheap stats for one subagent transcript. */
export function subStats(path: string): SubStats & { model: string | null } {
  const st = { calls: 0, errors: 0, out: 0, model: null as string | null };
  const seen = new Set<unknown>();
  for (const d of iterJson(path)) {
    const m = d.message;
    if (!isRecord(m)) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    if (d.type === 'assistant') {
      st.model ??= typeof m.model === 'string' ? m.model : null;
      if (!seen.has(m.id) && isRecord(m.usage)) {
        seen.add(m.id);
        st.out += Number(m.usage.output_tokens) || 0;
      }
      st.calls += content.filter(b => isRecord(b) && b.type === 'tool_use').length;
    } else {
      st.errors += content.filter(b => isRecord(b) && b.type === 'tool_result' && b.is_error).length;
    }
  }
  return st;
}

/** Parse one session transcript into a run: events, token totals, timing and stats. Not yet scored. */
export function parseRun(path: string): Run {
  const id = basename(path, extname(path));
  const evs: Pending[] = [];
  const run: Run = {
    id, short: id.slice(0, 8), file: path, events: evs, cwd: null, model: null,
    started: null, ended: null, duration_s: 0, title: '',
    tokens: { in: 0, cache_read: 0, cache_create: 0, out: 0, think: 0 },
    stats: undefined as never,
  };
  const tok: Tokens = run.tokens;
  const pending = new Map<string, Pending>();
  const toolOfAgent = new Map<string, string>();
  let prevTurn: Pending[] = [], thisTurn: Pending[] = [];
  const seenMsgs = new Set<unknown>(), toolMsgs = new Map<unknown, number>();
  let t0: number | null = null, tLast: number | null = null;
  const readVer = new Map<string, number>(), seenVer = new Map<string, number>();
  let peakCtx = 0, streak = 0, thrash = 0;
  // The assistant message being read. One message spans several lines, one per content block.
  let cur: { id: unknown; out: number; ctx: number; t: number | null; texts: string[]; uses: number } | null = null;

  const flush = () => {
    if (cur && !cur.uses && cur.texts.length) { // a text-only turn is the agent talking to the user
      evs.push({ k: 'talk', t: cur.t, s: cut(collapse(cur.texts[0]!), 120), out: cur.out, ctx: cur.ctx });
    }
    cur = null;
  };

  for (const d of iterJson(path)) {
    if (d.isSidechain) continue;
    const typ = d.type;
    const m: Json | null = isRecord(d.message) ? d.message : null;
    // One message can be split by the result of its first call, so a results-only user line does not end it.
    const sameMsg = typ === 'assistant' && m && m.id === (cur as { id: unknown } | null)?.id;
    if (cur && !sameMsg && !isResultsOnly(d)) flush();
    const t = d.timestamp ? ts(d.timestamp) : null;
    if (t) {
      t0 ||= t;
      tLast = t;
    }
    const rel = t && t0 ? pyRound(t - t0, 1) : null;
    run.cwd ||= typeof d.cwd === 'string' ? d.cwd : null;

    if (typ === 'system' && d.subtype === 'compact_boundary') {
      const cm = isRecord(d.compactMetadata) ? d.compactMetadata : {};
      evs.push({ k: 'molt', t: rel, pre: num(cm.preTokens), post: num(cm.postTokens), trig: typeof cm.trigger === 'string' ? cm.trigger : null });
      continue;
    }
    if (!m) continue;
    const content = m.content;

    if (typ === 'user') {
      if (d.isCompactSummary) {
        if (!evs.length || evs[evs.length - 1]!.k !== 'molt') evs.push({ k: 'molt', t: rel });
        continue;
      }
      if (Array.isArray(content) && content.some(b => isRecord(b) && b.type === 'tool_result')) {
        for (const b of content) {
          if (!(isRecord(b) && b.type === 'tool_result')) continue;
          const ev = pending.get(String(b.tool_use_id));
          if (!ev) continue;
          pending.delete(String(b.tool_use_id));
          ev.res = resultSize(b.content);
          if (b.is_error) {
            ev.err = 1;
            ev.e = cut(collapse(textOf(b.content ?? '')), 160);
          }
          const tur = d.toolUseResult;
          if (baseTool(ev) === 'Agent' && isRecord(tur) && typeof tur.agentId === 'string' && ev.id) toolOfAgent.set(tur.agentId, ev.id);
          const flags = (ev.flags ??= []);
          if (ev.res > FAT) {
            flags.push('fat');
            ev.d = (ev.d ?? 0) + Math.min(8, DMG.fat * Math.ceil((ev.res - FAT) / FAT));
          }
          if (ev.err) {
            ev.d = (ev.d ?? 0) + DMG.error;
            streak++;
            if (streak === 3) {
              thrash++;
              flags.push('thrash');
              ev.d += DMG.thrash;
            }
          } else {
            streak = 0;
          }
        }
        continue;
      }
      if (d.isMeta || (isRecord(d.origin) && typeof d.origin.kind === 'string' && d.origin.kind !== 'human')) continue;
      const text = stripWrappers(collapse(textOf(content)));
      if (!text || SKIP_PROMPT.some(p => text.startsWith(p))) continue;
      evs.push({ k: 'prompt', t: rel, s: cut(text, 120) });
      continue;
    }

    if (typ !== 'assistant' || d.isApiErrorMessage) continue;
    run.model ||= typeof m.model === 'string' ? m.model : null;
    const mid = m.id;
    if (cur === null) {
      cur = { id: mid, out: 0, ctx: 0, t: rel, texts: [], uses: 0 };
      if (!seenMsgs.has(mid)) { // usage repeats on every line of a message: count it once
        seenMsgs.add(mid);
        const u = isRecord(m.usage) ? m.usage : {};
        const details = isRecord(u.output_tokens_details) ? u.output_tokens_details : {};
        cur.out = n0(u.output_tokens);
        cur.ctx = n0(u.input_tokens) + n0(u.cache_read_input_tokens) + n0(u.cache_creation_input_tokens);
        tok.in += n0(u.input_tokens);
        tok.cache_read += n0(u.cache_read_input_tokens);
        tok.cache_create += n0(u.cache_creation_input_tokens);
        tok.out += cur.out;
        tok.think += n0(details.thinking_tokens);
        peakCtx = Math.max(peakCtx, cur.ctx);
      }
    }
    const c = cur as NonNullable<typeof cur>;
    const blocks = Array.isArray(content) ? content : [];
    const uses = blocks.filter(isRecord).filter(b => b.type === 'tool_use');
    c.uses += uses.length;
    for (const b of blocks) if (isRecord(b) && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) c.texts.push(b.text);
    for (const b of uses) {
      const tool = typeof b.name === 'string' && b.name ? b.name : '?';
      const call = classifyCall(tool, isRecord(b.input) ? b.input : {});
      const inp = call.input, base = call.as ?? tool;
      if (!toolMsgs.has(mid)) {
        toolMsgs.set(mid, toolMsgs.size);
        [prevTurn, thisTurn] = [thisTurn, []];
      }
      const g = toolMsgs.get(mid)!;
      const ev: Pending = {
        k: call.kind, tool, ...(call.as ? { as: call.as } : {}), s: summarize(base, isRecord(b.input) ? inp : b.input ?? {}, run.cwd), t: rel, g,
        par: thisTurn.length ? 1 : 0,
        out: c.out, ctx: c.ctx, id: typeof b.id === 'string' ? b.id : undefined, res: 0,
      };
      c.out = c.ctx = 0; // the message's usage lands on its first tool call
      const flags: Flag[] = [];
      const sig = stableStringify(inp);
      if (prevTurn.some(p => p.err && p.tool === tool && p.sig === sig)) { // verbatim repeat of a call that just failed
        flags.push('retry');
        ev.d = (ev.d ?? 0) + DMG.retry;
      }
      const fp = typeof inp.file_path === 'string' && inp.file_path ? inp.file_path : null;
      if (base === 'Read' && fp) {
        const { file_path: _, ...range } = inp; // offset/limit, or a harness's own range fields
        const key = stableStringify([fp, range]);
        if (seenVer.has(key) && seenVer.get(key) === (readVer.get(fp) ?? 0)) {
          flags.push('reread');
          ev.d = (ev.d ?? 0) + DMG.reread;
        }
        seenVer.set(key, readVer.get(fp) ?? 0);
      } else if (EDIT_TOOLS.has(base) && fp) {
        readVer.set(fp, (readVer.get(fp) ?? 0) + 1);
      }
      if (flags.length) ev.flags = flags;
      ev.sig = sig;
      if (ev.id) pending.set(ev.id, ev);
      thisTurn.push(ev);
      evs.push(ev);
    }
  }
  flush();

  attachSubagents(path, evs, toolOfAgent);
  for (const ev of evs) {
    delete ev.sig;
    delete ev.id;
    if (baseTool(ev) === 'Agent' && !ev.sub) ev.sub = { calls: 0, errors: 0, out: 0 };
  }

  run.started = t0;
  run.ended = tLast;
  run.duration_s = pyRound((tLast ?? 0) - (t0 ?? 0));
  run.title = evs.find(e => e.k === 'prompt')?.s ?? '';
  run.stats = stats(evs, tok, peakCtx, thrash);
  return run;
}

/** Subagent transcripts live next to the session: <session>/subagents/agent-<id>.jsonl, plus a meta.json. */
function attachSubagents(path: string, evs: Pending[], toolOfAgent: Map<string, string>): void {
  const subdir = join(dirname(path), basename(path, extname(path)), 'subagents');
  if (!existsSync(subdir) || !statSync(subdir).isDirectory()) return;
  const byId = new Map(evs.filter(e => baseTool(e) === 'Agent' && e.id).map(e => [e.id!, e]));
  const files = readdirSync(subdir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl')).sort();
  for (const f of files) {
    const stem = f.slice(0, -'.jsonl'.length);
    let tid: string | undefined;
    const metaPath = join(subdir, `${stem}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (isRecord(meta) && typeof meta.toolUseId === 'string') tid = meta.toolUseId;
      } catch {
        // a broken meta file falls back to the agentId link below
      }
    }
    tid ??= toolOfAgent.get(stem.slice('agent-'.length));
    const ev = tid ? byId.get(tid) : undefined;
    if (ev) ev.sub = subStats(join(subdir, f));
  }
}

function isResultsOnly(d: Json): boolean {
  const c = isRecord(d.message) ? d.message.content : null;
  return d.type === 'user' && Array.isArray(c) && c.length > 0 && c.every(b => isRecord(b) && b.type === 'tool_result');
}

function n0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
