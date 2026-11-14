// lineage() aggregates and the text report agents read through /petri.
import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { lineage, report } from '../src/report.ts';
import type { ScoredRun } from '../src/types.ts';
import { makeRun } from './helpers.ts';

/** Scored runs with forced fitness, keeping real structure for the report. */
const runsWith = (spec: [fitness: number, calls: number][]): ScoredRun[] =>
  spec.map(([fit, calls], i) => ({ ...makeRun({ calls, start: 1_790_000_000 + i * 3600 }), fitness: fit }));
const rep = (runs: ScoredRun[]) => report(runs, lineage(runs), 'proj');

describe('lineage', () => {
  it('basic aggregates', () => {
    const lin = lineage(runsWith([[80, 25], [90, 25], [70, 25]]));
    assert.deepEqual([lin.n, lin.median, lin.best, lin.fitness, lin.calls, lin.trend], [3, 80, 90, [80, 90, 70], 75, null]);
  });
  it('best ignores tiny runs', () => assert.equal(lineage(runsWith([[100, 3], [70, 25]])).best, 70));
  it('best falls back when every run is tiny', () => assert.equal(lineage(runsWith([[60, 3], [95, 4]])).best, 95));
  it('the trend needs more than five runs', () => {
    const lin = lineage(runsWith([...Array(5).fill([50, 25]), [60, 25], [70, 25], [80, 25], [90, 25], [100, 25]]));
    assert.deepEqual(lin.last5, [60, 70, 80, 90, 100]);
    assert.equal(lin.trend, 30);
  });
  it('the trend with a partial previous window', () => {
    assert.equal(lineage(runsWith([[40, 25], [60, 25], [80, 25], [80, 25], [80, 25], [80, 25], [80, 25]])).trend, 30);
  });
  it('an even count takes the middle average', () => assert.equal(lineage(runsWith([[80, 25], [91, 25]])).median, 85.5));
  it('traits sorted by count', () => {
    const runs = runsWith([[90, 25], [90, 25]]);
    runs[0]!.traits = ['Batcher', 'Molted'];
    runs[1]!.traits = ['Molted'];
    assert.deepEqual(Object.entries(lineage(runs).traits), [['Molted', 2], ['Batcher', 1]]);
  });
  it('empty', () => {
    const lin = lineage([]);
    assert.deepEqual([lin.n, lin.median, lin.best, lin.trend], [0, 0, 0, null]);
  });
});

describe('report', () => {
  it('header and body', () => {
    const r = makeRun({ calls: 25, errors: 2 });
    const text = rep([r]), lines = text.split('\n');
    assert.ok(lines[0]!.startsWith('PETRI · proj · 1 runs · median fitness'), text);
    assert.ok(text.includes(`FITNESS ${r.fitness}`));
    assert.ok(text.includes('calls 25 (1.0/turn) · errors 2'), text);
    assert.ok(text.includes('damage 24.0/100 actions: error ×2 −6'), text);
    assert.ok(text.includes('mutations for next run:'));
    assert.ok(!text.includes('lineage:'));
    assert.ok(!text.includes('NEW BEST'));
  });
  it('a clean report', () => {
    const text = rep([makeRun({ calls: 5 })]);
    assert.ok(text.includes('damage 0.0/100 actions: none'), text);
    assert.ok(text.includes('traits: —'));
    assert.ok(!text.includes('mutations'));
  });
  it('a prompt-only run prints 0 calls per turn', () => {
    const r = makeRun({ calls: 0 });
    assert.ok(rep([r]).includes('calls 0 (0/turn)'));
  });
  it('a median of x.5 rounds to even, like the Python original', () => {
    assert.ok(rep(runsWith([[84, 25], [85, 25]])).startsWith('PETRI · proj · 2 runs · median fitness 84 · best 85'));
  });
  it('new best', () => assert.ok(rep(runsWith([[80, 25], [90, 25]])).includes('★ NEW BEST')));
  it('not best when tied or lower', () => {
    assert.ok(!rep(runsWith([[90, 25], [90, 25]])).includes('NEW BEST'));
    assert.ok(!rep(runsWith([[95, 25], [90, 25]])).includes('NEW BEST'));
  });
  it('a tiny last run cannot be best', () => assert.ok(!rep(runsWith([[80, 25], [100, 5]])).includes('NEW BEST')));
  it('tiny earlier runs do not block best', () => assert.ok(rep(runsWith([[100, 5], [90, 25]])).includes('NEW BEST')));
  it('the lineage line with a trend', () => {
    assert.ok(rep(runsWith([[80, 25], [85, 25], [90, 25]])).includes('lineage: last 3 fitness 80 85 90'));
    const text = rep(runsWith([...Array(5).fill([90, 25]), ...Array(5).fill([80, 25])]));
    assert.ok(text.includes('fitness 80 80 80 80 80, -10 vs previous 5'), text);
    assert.ok(rep(runsWith([...Array(10).fill([80, 25])])).includes(', +0 vs previous 5'));
  });
  it('the title is cut to 100', () => {
    const line = rep([makeRun({ calls: 3, prompt: 'word '.repeat(100) })]).split('\n')[2]!;
    assert.ok(line.trim().length <= 100);
  });
});
