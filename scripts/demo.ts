#!/usr/bin/env bun
/**
 * Grow a dish from made-up sessions, so Petri can be tried without any Claude Code history.
 * Writes ten synthetic transcripts for an imaginary "shop-api" project, then runs the CLI on them.
 *   bun run demo [--report] [--no-open] [-o FILE]
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { mulberry32 } from '../src/render/grow.ts';
import { Transcript, usage } from '../tests/helpers.ts';
import type { CallSpec } from '../tests/helpers.ts';

const CWD = '/demo/shop-api';
const FILES = ['src/orders.ts', 'src/cart.ts', 'src/auth.ts', 'src/db.ts', 'src/routes.ts', 'tests/orders.test.ts', 'README.md'];
const TASKS = [
  'Add rate limiting to the /orders endpoint',
  'Fix the flaky cart total test',
  'Move session tokens out of local storage',
  'Paginate the order history query',
  'Why does checkout time out on large carts?',
  'Add a health check route',
  'Rename customerId to accountId everywhere',
  'Write tests for refunds',
  'Cache product lookups for a minute',
  'Clean up the README and the API examples',
];

/**
 * The same calls as an IDE harness would send them, as MCP tools with its own field names.
 * Petri maps them back, so these runs grow the same colours and get the same checks.
 */
function viaMcp([name, input, ...rest]: CallSpec): CallSpec {
  const i = input as Record<string, unknown>;
  const { file_path, old_string, new_string, ...other } = i;
  const moved = { ...(file_path ? { path: file_path } : {}), ...(old_string ? { oldString: old_string, newString: new_string } : {}), ...other };
  const as: Record<string, string> = { Read: 'read', Edit: 'edit', Write: 'write', Bash: 'shell', Grep: 'grep', Glob: 'glob', WebSearch: 'websearch' };
  return as[name] ? [`mcp__ide__${as[name]}`, moved, ...rest] : [name, input, ...rest];
}

/** One session: quality improves with i, so the lineage shows a trend. */
function session(i: number): Transcript {
  const rnd = mulberry32(1000 + i), pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const sloppy = 1 - i / TASKS.length; // early runs make more mistakes
  const mcp = i >= 7; // the last three runs come through an IDE harness
  const send = (specs: CallSpec[], opts: Parameters<Transcript['calls']>[1]) => t.calls(mcp ? specs.map(viaMcp) : specs, opts);
  const t = new Transcript({ sid: `demo${String(i).padStart(4, '0')}-5eed-4000-8000-00000000000${i % 10}`, cwd: CWD, start: 1_793_000_000 + i * 86_400, model: 'claude-demo' });
  const use = () => usage({ out: 200 + Math.floor(rnd() * 1800), think: Math.floor(rnd() * 900), inp: 8, cacheRead: 20_000 + Math.floor(rnd() * 90_000), cacheCreate: Math.floor(rnd() * 4000) });
  const read = new Set<string>();
  const file = () => `${CWD}/${pick(FILES)}`;
  /** A Read, or a Grep instead when a careful run already read that file and has not edited it since. */
  const look = (size: number): CallSpec => {
    const f = file();
    if (read.has(f) && rnd() > sloppy) return ['Grep', { pattern: pick(['export', 'TODO']), path: f }, 'x'.repeat(300)];
    read.add(f);
    return ['Read', { file_path: f }, 'x'.repeat(size)];
  };
  const edit = (): CallSpec => {
    const f = file();
    read.delete(f);
    const bad = rnd() < 0.25 * sloppy;
    return ['Edit', { file_path: f, old_string: 'a', new_string: 'b' }, bad ? '<tool_use_error>String to replace not found in file.</tool_use_error>' : 'ok', bad];
  };
  const wait = () => { t.clock += 5 + Math.floor(rnd() * 40); };
  for (let p = 0; p < 2 + Math.floor(rnd() * 2); p++) {
    t.prompt(p === 0 ? TASKS[i]! : pick(['run the tests again', 'also handle the empty case', 'looks good, commit it', 'can you simplify that?']));
    send([['Grep', { pattern: pick(['orders', 'limit', 'token', 'cache']), path: CWD }, 'x'.repeat(600)], look(3000), look(2500)], { use: use() });
    if (mcp && p === 0) t.call('mcp__docs__lookup', { topic: 'rate limits' }, 'x'.repeat(1200)); // a tool Petri doesn't know stays meta
    for (let s = 0; s < 6 + Math.floor(rnd() * 10); s++) {
      wait();
      const x = rnd();
      const specs: CallSpec[] = [];
      if (x < 0.25) specs.push(look(1500 + Math.floor(rnd() * 4000)));
      else if (x < 0.5) specs.push(edit());
      else if (x < 0.65) {
        const big = rnd() < 0.3 * sloppy, bad = rnd() < 0.35 * sloppy;
        specs.push(['Bash', { command: 'bun test' }, (bad ? 'Exit code 1\n(fail) orders > rejects the 101st request in a minute\n' : '') + 'x'.repeat(big ? 26_000 : 800), bad]);
      }
      else if (x < 0.75) specs.push(['Bash', { command: pick(['git status', 'git diff --stat', 'ls src']) }, 'x'.repeat(300)]);
      else if (x < 0.85) specs.push(['Grep', { pattern: pick(['TODO', 'accountId', 'retry']) }, 'x'.repeat(400)], ['Glob', { pattern: 'src/**/*.ts' }, 'x'.repeat(200)]);
      else if (x < 0.9) specs.push(['WebSearch', { query: 'token bucket rate limiter' }, 'x'.repeat(5000)]);
      else specs.push(['Write', { file_path: `${CWD}/src/new-${s}.ts` }, 'ok']);
      send(specs, { use: use() });
    }
    if (i % 3 === 1 && p === 0) {
      const tid = t.call('Agent', { description: 'review the diff' }, 'done', false, { use: use() });
      t.subagent(`demo${i}`, { toolUseId: tid, calls: 12 + i, errors: i % 2 });
    }
    if (i === 4 && p === 0) t.compact({ pre: 160_000, post: 18_000 });
    t.say('Done. The change is in place and the tests pass.', { use: use() });
  }
  return t;
}

const root = join(tmpdir(), 'petri-demo');
rmSync(root, { recursive: true, force: true });
const proj = join(root, '-demo-shop-api');
TASKS.forEach((_, i) => session(i).write(proj));
process.exitCode = main([proj, ...process.argv.slice(2)]);
