// stats(), score(): ledger, fitness, traits and the hints ("mutations for next run").
import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { DMG } from '../src/classify.ts';
import { traits } from '../src/score.ts';
import { makeRun, tools, Transcript, usage } from './helpers.ts';

describe('stats', () => {
  it('counts', () => {
    const t = new Transcript().prompt('q');
    t.calls([['Read', { file_path: '/w/a' }], ['Read', { file_path: '/w/b' }]]);
    t.call('Edit', { file_path: '/w/a' }, 'x', true);
    t.call('Write', { file_path: '/w/c' });
    t.call('Agent', { description: 'x' });
    t.call('WebSearch', { query: 'q' });
    t.say('done');
    const st = t.run().stats;
    assert.deepEqual([st.calls, st.turns, st.calls_per_turn], [6, 5, 1.2]);
    assert.deepEqual([st.reads, st.edits, st.edit_errors, st.agents, st.web, st.errors], [2, 2, 1, 1, 1, 1]);
    assert.deepEqual(st.by_kind, { sense: 3, act: 2, spawn: 1 });
  });
  it('ratios', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: '/w/a' }, 'ok', false, { use: usage({ out: 200, think: 50, inp: 10, cacheRead: 60, cacheCreate: 30 }) });
    const st = t.run().stats;
    assert.equal(st.cache_ratio, 0.6);
    assert.equal(st.think_ratio, 0.25);
  });
  it('no division by zero', () => {
    const st = new Transcript().prompt('q').run().stats;
    assert.deepEqual([st.calls_per_turn, st.cache_ratio, st.think_ratio], [0, 0, 0]);
  });
});

describe('fitness', () => {
  it('a clean run is 100', () => {
    const r = makeRun({ calls: 25 });
    assert.deepEqual([r.fitness, r.damage, r.damage_rate], [100, [], 0]);
  });
  it('the rate is per 100 actions', () => {
    const r = makeRun({ calls: 40, errors: 2 });
    assert.deepEqual([r.damage_rate, r.fitness], [15, 85]);
  });
  it('small runs use a floor of 20', () => {
    const r = makeRun({ calls: 5, errors: 1 });
    assert.deepEqual([r.damage_rate, r.fitness], [15, 85]);
  });
  it('a prompt-only run is 100', () => assert.equal(new Transcript().prompt('hello').say('hi').run().fitness, 100));
  it('clamps at zero', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 30; i++) t.call('Bash', { command: 'same' }, 'x'.repeat(200_000), true);
    const r = t.run();
    assert.equal(r.fitness, 0);
    assert.ok(r.damage_rate > 100);
  });
  it('rounds a .5 fitness to even, like the Python original', () => {
    const r = makeRun({ calls: 40, errors: 1 }); // 3 damage over 40 calls = 7.5 per 100
    assert.deepEqual([r.damage_rate, r.fitness], [7.5, 92]);
  });
  it('ledger order and amounts', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: '/w/a' }, 'x'.repeat(35_000));
    t.call('Read', { file_path: '/w/a' });
    t.call('Bash', { command: 'x' }, 'e', true);
    t.call('Bash', { command: 'x' }, 'e', true);
    t.call('Bash', { command: 'y' }, 'e', true);
    t.compact();
    assert.deepEqual(t.run().damage.map(l => [l.kind, l.n, l.dmg]),
      [['error', 3, 9], ['reread', 1, 2], ['fat', 1, 3], ['retry', 1, 2], ['thrash', 1, 5], ['molt', 1, 5]]);
  });
  it('the ledger matches per-event damage', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 12; i++) t.call(i % 3 ? 'Read' : 'Bash', { file_path: `/w/${i % 2}`, command: String(i % 2) }, 'x'.repeat(i * 4000), i % 4 === 0);
    t.compact();
    const r = t.run();
    const perEvent = tools(r).reduce((a, e) => a + (e.d ?? 0), 0) + r.stats.compactions * DMG.molt;
    assert.equal(perEvent, r.damage.reduce((a, l) => a + l.dmg, 0));
  });
});

const st = (over: Partial<Parameters<typeof traits>[0]>) => ({
  calls: 0, errors: 0, calls_per_turn: 0, edits: 0, edit_errors: 0, reads: 0, rereads: 0, agents: 0, web: 0, think_ratio: 0, fat: 0, compactions: 0, ...over,
});

describe('traits', () => {
  const CASES: [string, ReturnType<typeof st>, boolean][] = [
    ['Clean Run', st({ calls: 10 }), true], ['Clean Run', st({ calls: 9 }), false], ['Clean Run', st({ calls: 10, errors: 1 }), false],
    ['Batcher', st({ calls: 10, calls_per_turn: 1.5 }), true], ['Batcher', st({ calls: 10, calls_per_turn: 1.49 }), false],
    ['Batcher', st({ calls: 9, calls_per_turn: 3 }), false],
    ['Surgeon', st({ edits: 8 }), true], ['Surgeon', st({ edits: 7 }), false],
    ['Surgeon', st({ edits: 20, edit_errors: 1 }), false], ['Surgeon', st({ edits: 21, edit_errors: 1 }), true],
    ['Eidetic', st({ reads: 10 }), true], ['Eidetic', st({ reads: 9 }), false], ['Eidetic', st({ reads: 10, rereads: 1 }), false],
    ['Delegator', st({ agents: 2 }), true], ['Delegator', st({ agents: 1 }), false],
    ['Forager', st({ web: 1 }), true], ['Forager', st({}), false],
    ['Marathon', st({ calls: 200 }), true], ['Marathon', st({ calls: 199 }), false],
    ['Glutton', st({ fat: 5 }), true], ['Glutton', st({ fat: 4 }), false],
    ['Scarred', st({ calls: 20, errors: 3 }), true], ['Scarred', st({ calls: 20, errors: 2 }), false],
    ['Scarred', st({ calls: 9, errors: 9 }), false],
    ['Molted', st({ compactions: 1 }), true], ['Molted', st({}), false],
  ];
  it('every threshold, on both sides', () => {
    for (const [trait, s, want] of CASES) assert.equal(traits(s, { out: 0 }).includes(trait), want, `${trait} ${JSON.stringify(s)}`);
  });
  it('Deep Thinker', () => {
    for (const [out, ratio, want] of [[10_000, 0.6, true], [9_999, 0.9, false], [50_000, 0.59, false]] as const) {
      assert.equal(traits(st({ think_ratio: ratio }), { out }).includes('Deep Thinker'), want, `${out} ${ratio}`);
    }
  });
  it('traits from a real parse', () => {
    const r = makeRun({ calls: 30 });
    assert.ok(r.traits.includes('Clean Run'));
    assert.ok(!r.traits.includes('Batcher'));
  });
});

describe('hints', () => {
  it('a clean run has none', () => assert.deepEqual(makeRun({ calls: 10 }).hints, []));
  it('the error hint', () => {
    const t = new Transcript().prompt('q');
    t.call('Bash', { command: 'cd /w && npm run build' }, 'Exit code 2\nsrc/a.ts(3,1): error TS1005', true);
    t.call('Bash', { command: 'npm run lint' }, 'Exit code 1\nlint failed', true);
    t.call('Edit', { file_path: '/w/a' }, '<tool_use_error>File has not been read yet</tool_use_error>', true);
    const h = t.run().hints[0]!;
    assert.ok(h.startsWith('3 errors (Bash ×2, Edit ×1). First: `npm run build` → "src/a.ts(3,1): error TS1005"'), h);
    assert.ok(h.endsWith("Inspect the first failing command's output before issuing the next one."), h);
  });
  it('advice comes from the largest group', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 2; i++) t.call('Edit', { file_path: `/w/${i}` }, '<tool_use_error>File has not been read yet. Read it first</tool_use_error>', true);
    t.call('Bash', { command: 'x' }, 'Exit code 1', true);
    const h = t.run().hints[0]!;
    assert.ok(h.includes('Edit ×2, Bash ×1'), h);
    assert.ok(h.includes('→ "File has not been read yet. Read it first"'), h);
    assert.ok(h.endsWith('Read the file before Edit/Write.'), h);
  });
  it('an error without known advice', () => {
    const t = new Transcript().prompt('q');
    t.call('WebFetch', { url: 'u' }, '404', true);
    assert.ok(t.run().hints[0]!.endsWith('→ "404"'));
  });
  it('the reread hint counts total reads', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 3; i++) t.call('Read', { file_path: '/w/src/a.py' });
    assert.ok(t.run().hints[0]!.includes('src/a.py 3×'));
  });
  it('the fat hint names the largest', () => {
    const t = new Transcript().prompt('q');
    t.call('Bash', { command: 'cat small.log' }, 'x'.repeat(12_000));
    t.call('Read', { file_path: '/w/huge.json' }, 'x'.repeat(64_000));
    const h = t.run().hints[0]!;
    assert.ok(h.includes('2 tool results over 10k chars'), h);
    assert.ok(h.includes('largest: Read `huge.json` 64k'), h);
  });
  it('the compaction hint', () => {
    const h = new Transcript().prompt('q').compact({ pre: 300_000, post: 12_000 }).run().hints[0]!;
    assert.ok(h.includes('Context compacted 1× (dropped 288k tokens)'), h);
  });
  it('the batching hint threshold, printed like Python floats', () => {
    const at20 = makeRun({ calls: 20 }).hints;
    assert.ok(at20.some(h => h.startsWith('1.0 tool calls per turn')), at20.join('|'));
    assert.ok(!makeRun({ calls: 19 }).hints.some(h => h.includes('tool calls per turn')));
  });
  it('ordered by damage', () => {
    const t = new Transcript().prompt('q');
    t.call('Bash', { command: 'x' }, 'e', true);
    for (let i = 0; i < 4; i++) t.call('Read', { file_path: '/w/a' });
    const hs = t.run().hints;
    assert.ok(hs[0]!.startsWith('Re-read'), hs.join('|'));
    assert.ok(hs[1]!.startsWith('1 errors'), hs.join('|'));
  });
  it('at most five', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 3; i++) t.call('Bash', { command: 'same' }, 'x'.repeat(30_000), true);
    for (let i = 0; i < 3; i++) t.call('Read', { file_path: '/w/a' });
    for (let i = 0; i < 20; i++) t.call('Bash', { command: `ok ${i}` });
    t.compact();
    assert.equal(t.run().hints.length, 5);
  });
});
