// Property tests: seeded random sessions must always satisfy the parser's invariants.
// PETRI_FUZZ=N raises the number of generated sessions (default 300).
import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { parseRun } from '../src/parse.ts';
import { score } from '../src/score.ts';
import { checkInvariants, randomSession } from './invariants.ts';

describe('invariants', () => {
  const N = Number(process.env.PETRI_FUZZ ?? 300);
  it(`hold for ${N} random sessions, deterministically`, () => {
    for (let seed = 0; seed < N; seed++) {
      const f = randomSession(seed).write();
      const a = score(parseRun(f)), b = score(parseRun(f));
      try {
        checkInvariants(a);
        assert.equal(JSON.stringify(a), JSON.stringify(b), 'parse is not deterministic');
      } catch (e) {
        (e as Error).message = `seed ${seed}: ${(e as Error).message}`;
        throw e;
      }
    }
  }, 20 * 60_000); // Bun stops a test after 5 s by default; a long fuzz run needs minutes
  it('the generator reaches every damage path', () => {
    const seen = { rereads: 0, retries: 0, thrash: 0, compactions: 0, fat: 0, errors: 0, agents: 0 };
    for (let seed = 0; seed < 100; seed++) {
      const st = score(parseRun(randomSession(seed).write())).stats;
      for (const k of Object.keys(seen) as (keyof typeof seen)[]) if (st[k]) seen[k]++;
    }
    for (const [k, v] of Object.entries(seen)) assert.ok(v >= 5, `only ${v} of 100 sessions exercised ${k}`);
  });
});
