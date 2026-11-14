// Opt-in: every real transcript under ~/.claude/projects must parse and satisfy the invariants.
//   bun run test:corpus
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'bun:test';
import { collect, projectsDir } from '../src/collect.ts';
import { lineage, report } from '../src/report.ts';
import { checkInvariants } from './invariants.ts';

const enabled = !!process.env.PETRI_CORPUS && existsSync(projectsDir());

describe.skipIf(!enabled)('real corpus', () => {
  it('every session parses and holds the invariants', () => {
    const t0 = performance.now();
    const runs = collect(undefined, true);
    const seconds = (performance.now() - t0) / 1000;
    assert.ok(runs.length > 0);
    for (const r of runs) {
      try {
        checkInvariants(r);
      } catch (e) {
        (e as Error).message = `${r.project}/${r.short}: ${(e as Error).message}`;
        throw e;
      }
    }
    assert.ok(seconds < 30, `parsing ${runs.length} runs took ${seconds.toFixed(1)}s`);
  });
  it('the lineage report', () => {
    const runs = collect(undefined, true);
    assert.ok(report(runs, lineage(runs), 'all projects').startsWith('PETRI · all projects'));
  });
});
