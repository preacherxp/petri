import { DMG, EDIT_TOOLS, FAT, WEB_TOOLS } from './classify.ts';
import type { Kind, LedgerLine, PetriEvent, Run, ScoredRun, Stats, Tokens } from './types.ts';
import { cut, pyFloat, pyRound } from './util.ts';

const tools = (evs: PetriEvent[]) => evs.filter(e => e.tool);
const has = (e: PetriEvent, f: string) => (e.flags ?? []).includes(f as never);

export function stats(evs: PetriEvent[], tok: Tokens, peakCtx: number, thrash: number): Stats {
  const calls = tools(evs);
  const turns = new Set(calls.map(e => e.g)).size;
  const reads = calls.filter(e => e.tool === 'Read');
  const edits = calls.filter(e => EDIT_TOOLS.has(e.tool!));
  const byKind: Partial<Record<Kind, number>> = {};
  for (const e of calls) byKind[e.k as Kind] = (byKind[e.k as Kind] ?? 0) + 1;
  return {
    prompts: evs.filter(e => e.k === 'prompt').length,
    turns,
    calls: calls.length,
    errors: calls.filter(e => e.err).length,
    rereads: calls.filter(e => has(e, 'reread')).length,
    fat: calls.filter(e => has(e, 'fat')).length,
    retries: calls.filter(e => has(e, 'retry')).length,
    thrash,
    compactions: evs.filter(e => e.k === 'molt').length,
    agents: calls.filter(e => e.tool === 'Agent').length,
    web: calls.filter(e => WEB_TOOLS.has(e.tool!)).length,
    reads: reads.length,
    edits: edits.length,
    edit_errors: edits.filter(e => e.err).length,
    calls_per_turn: turns ? pyRound(calls.length / turns, 2) : 0,
    peak_ctx: peakCtx,
    cache_ratio: pyRound(tok.cache_read / Math.max(1, tok.in + tok.cache_read + tok.cache_create), 3),
    think_ratio: pyRound(tok.think / Math.max(1, tok.out), 3),
    by_kind: byKind,
  };
}

/** Fill in the damage ledger, fitness (100 minus damage per 100 actions), traits and hints. */
export function score(run: Run): ScoredRun {
  const st = run.stats, evs = run.events;
  const ledger: LedgerLine[] = [
    { kind: 'error', n: st.errors, dmg: st.errors * DMG.error },
    { kind: 'reread', n: st.rereads, dmg: st.rereads * DMG.reread },
    { kind: 'fat', n: st.fat, dmg: evs.filter(e => has(e, 'fat')).reduce((a, e) => a + Math.min(8, Math.ceil(((e.res ?? 0) - FAT) / FAT)), 0) },
    { kind: 'retry', n: st.retries, dmg: st.retries * DMG.retry },
    { kind: 'thrash', n: st.thrash, dmg: st.thrash * DMG.thrash },
    { kind: 'molt', n: st.compactions, dmg: st.compactions * DMG.molt },
  ].filter(l => l.n) as LedgerLine[];
  const dmg = ledger.reduce((a, l) => a + l.dmg, 0);
  const rate = 100 * dmg / Math.max(st.calls, 20); // runs under 20 actions count as 20
  const scored = run as ScoredRun;
  scored.damage = ledger;
  scored.damage_rate = pyRound(rate, 1);
  scored.fitness = Math.max(0, Math.min(100, pyRound(100 - rate)));
  scored.traits = traits(st, run.tokens);
  scored.hints = hints(scored);
  return scored;
}

type TraitStats = Pick<Stats, 'calls' | 'errors' | 'calls_per_turn' | 'edits' | 'edit_errors' | 'reads' | 'rereads' | 'agents' | 'web' | 'think_ratio' | 'fat' | 'compactions'>;

export function traits(st: TraitStats, tok: Pick<Tokens, 'out'>): string[] {
  const c = st.calls, out: string[] = [];
  if (c >= 10 && st.errors === 0) out.push('Clean Run');
  if (c >= 10 && st.calls_per_turn >= 1.5) out.push('Batcher');
  if (st.edits >= 8 && st.edit_errors / st.edits < 0.05) out.push('Surgeon');
  if (st.reads >= 10 && st.rereads === 0) out.push('Eidetic');
  if (st.agents >= 2) out.push('Delegator');
  if (st.web) out.push('Forager');
  if (tok.out >= 10_000 && st.think_ratio >= 0.6) out.push('Deep Thinker');
  if (c >= 200) out.push('Marathon');
  if (st.fat >= 5) out.push('Glutton');
  if (c >= 10 && st.errors / c >= 0.15) out.push('Scarred');
  if (st.compactions) out.push('Molted');
  return out;
}

const ERROR_ADVICE: [needle: string, advice: string][] = [
  ['has not been read', 'Read the file before Edit/Write.'],
  ['not found in file', 'Re-read the exact lines (offset/limit) before editing; old_string must match byte for byte.'],
  ['String to replace', 'Re-read the exact lines (offset/limit) before editing; old_string must match byte for byte.'],
  ['permission', 'Prefer actions the permission mode allows, or ask once instead of retrying.'],
  ['Exit code', "Inspect the first failing command's output before issuing the next one."],
  ['timed out', 'Long commands: run in background or narrow the scope.'],
];

/** "Mutations for next run": up to five concrete fixes, biggest damage first. */
export function hints(run: Pick<ScoredRun, 'stats' | 'events' | 'damage'>): string[] {
  const st = run.stats, evs = run.events, calls = tools(evs);
  const out: [number, string][] = [];
  if (st.errors) {
    const byTool = new Map<string, PetriEvent[]>();
    for (const e of calls) if (e.err) byTool.set(e.tool!, [...(byTool.get(e.tool!) ?? []), e]);
    const first = calls.find(e => e.err)!;
    const msg = cut((first.e ?? '').replace(/^Exit code \d+\s*/, '').replace(/<\/?tool_use_error>/g, '').trim(), 70);
    const groups = [...byTool.values()].sort((a, b) => b.length - a.length);
    const counts = groups.map(v => `${v[0]!.tool} ×${v.length}`).join(', ');
    let advice = '';
    outer: for (const v of groups) for (const [needle, a] of ERROR_ADVICE) if (v.some(e => (e.e ?? '').toLowerCase().includes(needle.toLowerCase()))) { advice = a; break outer; }
    out.push([st.errors * DMG.error, `${st.errors} errors (${counts}). First: \`${cut(first.s ?? '', 45)}\` → "${msg}"` + (advice ? ` — ${advice}` : '')]);
  }
  if (st.rereads) {
    const paths = new Map<string, number>();
    for (const e of calls) if (has(e, 'reread')) paths.set(e.s!, (paths.get(e.s!) ?? 1) + 1);
    const top = [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push([st.rereads * DMG.reread, 'Re-read unchanged files: ' + top.map(([p, n]) => `${p} ${n}×`).join(', ') + ' — keep what you read in working memory, or read a slice with offset/limit.']);
  }
  if (st.fat) {
    const big = calls.filter(e => has(e, 'fat')).reduce((a, e) => ((e.res ?? 0) > (a.res ?? 0) ? e : a));
    const fatDmg = run.damage.filter(l => l.kind === 'fat').reduce((a, l) => a + l.dmg, 0);
    out.push([fatDmg, `${st.fat} tool results over ${Math.floor(FAT / 1000)}k chars (largest: ${big.tool} \`${cut(big.s ?? '', 50)}\` ${Math.floor((big.res ?? 0) / 1000)}k) — pipe through head/grep/wc, or Read with offset/limit.`]);
  }
  if (st.retries) out.push([st.retries * DMG.retry, `${st.retries} verbatim retries after an error — change the input before retrying.`]);
  if (st.thrash) out.push([st.thrash * DMG.thrash, `${st.thrash} error streaks of 3+ — after two consecutive failures, stop and re-plan instead of pushing on.`]);
  if (st.compactions) {
    const dropped = evs.filter(e => e.k === 'molt').reduce((a, e) => a + ((e.pre ?? 0) - (e.post ?? 0)), 0);
    out.push([st.compactions * DMG.molt, `Context compacted ${st.compactions}× (dropped ${Math.floor(dropped / 1000)}k tokens) — trim tool output to make the run last longer.`]);
  }
  if (st.calls >= 20 && st.calls_per_turn < 1.2) {
    out.push([1, `${pyFloat(st.calls_per_turn)} tool calls per turn — independent reads/greps/searches can go in one turn.`]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, h]) => h);
}
