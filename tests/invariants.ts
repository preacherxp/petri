// Seeded random sessions and the invariants every scored run must satisfy. Shared by the fuzz and corpus tests.
import assert from 'node:assert/strict';
import { DMG } from '../src/classify.ts';
import { mulberry32 } from '../src/render/grow.ts';
import type { ScoredRun } from '../src/types.ts';
import { Transcript, usage } from './helpers.ts';
import type { CallSpec } from './helpers.ts';

export const TRAITS = new Set(['Clean Run', 'Batcher', 'Surgeon', 'Eidetic', 'Delegator', 'Forager', 'Deep Thinker', 'Marathon', 'Glutton', 'Scarred', 'Molted']);
const KINDS = new Set(['prompt', 'talk', 'molt', 'sense', 'act', 'run', 'spawn', 'meta']);
const SIZES = [0, 10, 900, 5_000, 10_000, 10_001, 15_000, 60_000, 250_000];

export function randomSession(seed: number): Transcript {
  const rnd = mulberry32(seed + 1);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const TOOLS: [string, () => unknown][] = [
    ['Read', () => ({ file_path: `/w/${pick([...'abc'])}.py`, ...(rnd() < 0.2 ? { offset: 1, limit: 20 } : {}) })],
    ['Edit', () => ({ file_path: `/w/${pick([...'abc'])}.py` })],
    ['Write', () => ({ file_path: `/w/${pick([...'xyz'])}.md` })],
    ['Grep', () => ({ pattern: pick(['foo', 'bar']) })],
    ['Bash', () => ({ command: pick(['ls', 'npm test', 'git commit -m x', 'cat a > b', 'rm x', 'python3 run.py']) })],
    ['WebFetch', () => ({ url: 'https://example.com' })],
    ['Agent', () => ({ description: 'sub task' })],
    ['Skill', () => ({ skill: 's' })],
  ];
  const t = new Transcript({ sid: `fuzz-${seed}`, start: 1_790_000_000 + seed });
  const pending: [string, unknown, boolean][] = [];
  for (let step = int(0, 70); step > 0; step--) {
    const x = rnd();
    if (x < 0.08) t.prompt(pick(['do it', 'fix', '<system-reminder>x', '[Request interrupted by user]', 'why?']));
    else if (x < 0.13) t.say(pick(['done', ' ', 'here is the answer']), { use: usage({ out: int(0, 3000), think: int(0, 2000) }) });
    else if (x < 0.16) t.compact({ pre: int(50_000, 900_000), post: int(5_000, 30_000), trigger: pick(['auto', 'manual']), summary: rnd() < 0.7 });
    else if (x < 0.18) t.results([[`toolu_ghost${int(0, 9)}`, 'orphan', rnd() < 0.5]]);
    else if (x < 0.20) {
      const side = new Transcript({ sidechain: true });
      side.call('Bash', { command: 'ls' }, 'x', true);
      t.lines.push(...side.lines);
    } else if (x < 0.22 && pending.length) t.results([pending.pop()!]);
    else {
      const specs: CallSpec[] = [];
      for (let n = pick([1, 1, 1, 2, 3]); n > 0; n--) {
        const [name, make] = pick(TOOLS);
        specs.push([name, make(), 'x'.repeat(pick(SIZES)), rnd() < 0.2]);
      }
      const answered = rnd() < 0.9;
      const ids = t.calls(specs, { use: usage({ out: int(0, 5000), think: int(0, 3000), cacheRead: int(0, 200_000) }), results: answered });
      if (!answered) pending.push(...ids.map(id => [id, 'late', false] as [string, unknown, boolean]));
    }
  }
  return t;
}

/** Everything that must hold for any scored run, synthetic or real. */
export function checkInvariants(r: ScoredRun): void {
  const st = r.stats, calls = r.events.filter(e => e.tool);
  assert.ok(r.fitness >= 0 && r.fitness <= 100, 'fitness in 0..100');
  assert.ok(r.damage_rate >= 0);
  assert.equal(st.calls, calls.length);
  assert.equal(st.calls, Object.values(st.by_kind).reduce((a, b) => a + (b ?? 0), 0));
  assert.ok(st.errors <= st.calls && st.rereads <= st.reads && st.fat <= st.calls && st.retries <= st.calls);
  assert.ok(st.thrash * 3 <= st.errors);
  assert.ok(st.turns <= st.calls);
  if (st.calls) assert.ok(st.calls_per_turn >= 1);
  assert.ok(st.cache_ratio >= 0 && st.cache_ratio <= 1);
  assert.ok(st.think_ratio >= 0);
  const perEvent = calls.reduce((a, e) => a + (e.d ?? 0), 0) + st.compactions * DMG.molt;
  assert.equal(perEvent, r.damage.reduce((a, l) => a + l.dmg, 0), 'ledger equals per-event damage');
  assert.ok(r.damage.every(l => l.n > 0));
  assert.ok(r.hints.length <= 5);
  assert.ok(r.traits.every(t => TRAITS.has(t)));
  const ts = r.events.map(e => e.t).filter((t): t is number => t !== null);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'times never go backwards');
  const gs = calls.map(e => e.g!);
  assert.deepEqual(gs, [...gs].sort((a, b) => a - b), 'turns never go backwards');
  for (const e of r.events) {
    assert.ok(KINDS.has(e.k), e.k);
    assert.ok(!('sig' in e) && !('id' in e));
    if (e.tool === 'Agent') assert.ok(e.sub);
    if (e.err) assert.ok(typeof e.e === 'string');
  }
  JSON.stringify(r);
}

