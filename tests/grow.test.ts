// Renderer core: growth geometry and display helpers.
import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { esc, fmtK, fmtT, grow, mulberry32, R } from '../src/render/grow.ts';
import type { PetriEvent } from '../src/types.ts';

const KINDS = ['sense', 'act', 'run', 'meta'] as const;

function randomRun(seed: number, n = 200): { id: string; events: PetriEvent[] } {
  const r = mulberry32(seed), events: PetriEvent[] = [];
  let g = 0;
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.06) events.push({ k: 'prompt', t: null, s: 'p' });
    else if (x < 0.08) events.push({ k: 'molt', t: null });
    else if (x < 0.11) events.push({ k: 'talk', t: null, out: Math.floor(r() * 4000) });
    else if (x < 0.13) events.push({ k: 'spawn', t: null, tool: 'Agent', g: g++, par: 0, res: 100, out: 50, sub: { calls: Math.floor(r() * 200), errors: Math.floor(r() * 5), out: 0 } });
    else {
      const par = r() < 0.25 && i > 0 ? 1 : 0;
      if (!par) g++;
      events.push({ k: KINDS[Math.floor(r() * 4)]!, t: null, tool: 'X', g, par, res: Math.floor(r() ** 3 * 300000), out: Math.floor(r() * 6000), ...(r() < 0.1 ? { err: 1 as const } : {}) });
    }
  }
  return { id: `run-${seed}`, events };
}
const budsFor = (calls: number) => (calls ? Math.max(3, Math.min(14, Math.round(Math.sqrt(calls) * 2))) : 0);
const call = (g: number, par: number, extra: Partial<PetriEvent> = {}): PetriEvent => ({ k: 'sense', t: null, tool: 'Read', g, par, ...extra });
const P: PetriEvent = { k: 'prompt', t: null };

describe('grow', () => {
  it('an empty run is just the nucleus', () => {
    const g = grow({ id: 'e', events: [] });
    assert.equal(g.nodes.length, 1);
    assert.equal(g.nodes[0]!.k, 'nucleus');
    assert.deepEqual(g.chains, []);
  });
  it('is deterministic per run id and differs across ids', () => {
    const run = randomRun(7), shape = (x: { id: string; events: PetriEvent[] }) => JSON.stringify(grow(x).nodes.map(n => [n.x, n.y]));
    assert.equal(shape(run), shape(run));
    assert.notEqual(shape(run), shape({ ...run, id: 'something-else' }));
  });
  it('node count: nucleus, one per event except molts, an implicit lobe, and buds', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const run = randomRun(seed), g = grow(run);
      const firstReal = run.events.findIndex(e => e.k !== 'molt');
      const implicit = firstReal >= 0 && run.events[firstReal]!.k !== 'prompt' ? 1 : 0;
      const expected = 1 + implicit + run.events.filter(e => e.k !== 'molt').length + run.events.reduce((a, e) => a + (e.k === 'spawn' ? budsFor(e.sub!.calls) : 0), 0);
      assert.equal(g.nodes.length, expected, `seed ${seed}`);
    }
  });
  it('every coordinate is finite and stays inside the dish', () => {
    let worst = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const n of grow(randomRun(seed, 1 + (seed * 37) % 900)).nodes) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `seed ${seed}`);
        worst = Math.max(worst, Math.hypot(n.x, n.y) / R);
      }
    }
    assert.ok(worst <= 1, `growth escaped the dish: ${worst.toFixed(3)} × R`);
  });
  it('parents always precede children', () => {
    grow(randomRun(11, 600)).nodes.forEach((n, i) => {
      if (i === 0) assert.equal(n.p, -1);
      else assert.ok(n.p >= 0 && n.p < i, `node ${i} has parent ${n.p}`);
    });
  });
  it('nodes come in event order', () => {
    const is = grow(randomRun(3, 400)).nodes.slice(1).map(n => n.i);
    assert.deepEqual(is, [...is].sort((a, b) => a - b));
  });
  it('each prompt starts a new chain from the nucleus', () => {
    const g = grow({ id: 'p', events: [P, call(1, 0), P, { k: 'act', t: null, tool: 'Edit', g: 2, par: 0 }] });
    assert.equal(g.chains.length, 2);
    for (const ch of g.chains) assert.equal(g.nodes[ch[0]!]!.p, 0);
    assert.equal(g.nodes[g.chains[1]![1]!]!.p, g.chains[1]![0]);
  });
  it('events before any prompt get an implicit lobe', () => {
    const g = grow({ id: 'np', events: [call(1, 0), call(2, 0)] });
    assert.equal(g.chains.length, 1);
    assert.equal(g.nodes[1]!.k, 'prompt');
    assert.equal(g.nodes[1]!.ev, null);
  });
  it('parallel calls fan from the same joint and do not extend the chain', () => {
    const g = grow({ id: 'par', events: [P, call(1, 0), call(2, 0), call(2, 1), call(2, 1)] });
    const [, , a, b, c] = g.nodes.slice(1);
    assert.equal(b!.p, a!.p);
    assert.equal(c!.p, a!.p);
    assert.equal(g.chains[0]!.length, 3);
  });
  it('a parallel flag without a matching turn grows in sequence', () => {
    const g = grow({ id: 'np2', events: [P, call(1, 0), call(2, 1)] });
    assert.equal(g.nodes[3]!.p, 2);
    assert.equal(g.chains[0]!.length, 3);
  });
  it('molts advance the epoch of later growth', () => {
    const g = grow({ id: 'm', events: [P, call(1, 0), { k: 'molt', t: null }, call(2, 0), { k: 'molt', t: null }, call(3, 0)] });
    assert.deepEqual(g.molts, [2, 4]);
    assert.deepEqual(g.nodes.slice(1).map(n => n.epoch), [0, 0, 1, 2]);
  });
  it('subagent buds scale with calls, clamp to 3..14, and carry errors', () => {
    for (const [calls, want] of [[0, 0], [1, 3], [9, 6], [49, 14], [5000, 14]] as const) {
      const g = grow({ id: `b${calls}`, events: [P, { k: 'spawn', t: null, tool: 'Agent', g: 1, par: 0, sub: { calls, errors: 0, out: 0 } }] });
      assert.equal(g.nodes.filter(n => n.k === 'bud').length, want, `calls=${calls}`);
    }
    const g = grow({ id: 'be', events: [P, { k: 'spawn', t: null, tool: 'Agent', g: 1, par: 0, sub: { calls: 40, errors: 4, out: 0 } }] });
    assert.ok(g.nodes.filter(n => n.k === 'bud' && n.err).length >= 1);
  });
  it('byEvent maps every non-molt event to its nodes', () => {
    const run = randomRun(5, 300), g = grow(run);
    run.events.forEach((e, i) => {
      if (e.k === 'molt') assert.equal(g.byEvent.get(i), undefined);
      else assert.ok((g.byEvent.get(i)?.length ?? 0) >= 1, `event ${i}`);
    });
  });
  it('bigger results make bigger nodes, errors a little bigger', () => {
    const g = grow({ id: 's', events: [P, call(1, 0, { res: 10 }), call(2, 0, { res: 200000 }), call(3, 0, { res: 10, err: 1 })] });
    const [, small, big, scar] = g.nodes.slice(1);
    assert.ok(big!.r > small!.r);
    assert.ok(scar!.r > small!.r);
  });
});

describe('display helpers', () => {
  it('fmtK', () => {
    assert.equal(fmtK(999), '999');
    assert.equal(fmtK(1500), '2k');
    assert.equal(fmtK(2_500_000), '2.5M');
  });
  it('fmtT', () => {
    assert.equal(fmtT(0), '0:00');
    assert.equal(fmtT(59), '0:59');
    assert.equal(fmtT(3661), '1:01:01');
    assert.equal(fmtT(-5), '0:00');
    assert.equal(fmtT(undefined), '0:00');
  });
  it('esc neutralizes markup', () => {
    assert.equal(esc('<img src="x" onerror=a()>&'), '&lt;img src=&quot;x&quot; onerror=a()&gt;&amp;');
    assert.equal(esc(null), '');
    assert.equal(esc(42), '42');
  });
});
