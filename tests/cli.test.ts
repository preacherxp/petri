// Finding transcripts (collect, slugFor) and the command line, end to end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'bun:test';
import { collect, NoTranscripts, slugFor } from '../src/collect.ts';
import { ROOT } from '../src/dish.ts';
import type { DishData } from '../src/types.ts';
import { tmpdir, Transcript } from './helpers.ts';

const session = (sid: string, start: number, prompt = 'task', calls = 3) => {
  const t = new Transcript({ sid, start }).prompt(prompt);
  for (let i = 0; i < calls; i++) t.call('Bash', { command: `step ${i}` });
  return t;
};

describe('collect', () => {
  let root: string;
  beforeEach(() => { root = tmpdir(); });

  it('a single file', () => {
    const f = session('aaaa', 1000).write();
    const runs = collect(f, false, root);
    assert.deepEqual(runs.map(r => r.id), ['aaaa']);
    assert.ok(typeof runs[0]!.fitness === 'number');
  });
  it('a project dir, sorted by start time', () => {
    const d = join(root, '-x-proj');
    session('zzzz', 1000).write(d);
    session('aaaa', 5000).write(d);
    session('mmmm', 3000).write(d);
    assert.deepEqual(collect(d, false, root).map(r => r.id), ['zzzz', 'mmmm', 'aaaa']);
  });
  it('skips sessions with nothing in them', () => {
    const d = join(root, '-x-proj');
    session('real', 1000).write(d);
    new Transcript({ sid: 'noise' }).raw({ type: 'file-history-snapshot', snapshot: {} }).write(d);
    assert.deepEqual(collect(d, false, root).map(r => r.id), ['real']);
  });
  it('a working dir resolves to its slug, walking up', () => {
    session('s1', 1000).write(join(root, '-petri-nonexistent-proj'));
    assert.deepEqual(collect('/petri-nonexistent/proj/src/deep', false, root).map(r => r.id), ['s1']);
  });
  it('sanitized slugs', () => {
    session('s2', 1000).write(join(root, '-petri-nonexistent-my-app--hidden'));
    assert.equal(slugFor('/petri_nonexistent/my.app/.hidden', root), join(root, '-petri-nonexistent-my-app--hidden'));
  });
  it('the nearest project wins', () => {
    session('outer', 1000).write(join(root, '-petri-nonexistent'));
    session('inner', 2000).write(join(root, '-petri-nonexistent-proj'));
    assert.equal(slugFor('/petri-nonexistent/proj/x', root), join(root, '-petri-nonexistent-proj'));
  });
  it('a project dir without sessions is skipped', () => {
    mkdirSync(join(root, '-petri-nonexistent-proj'), { recursive: true });
    session('outer', 1000).write(join(root, '-petri-nonexistent'));
    assert.equal(slugFor('/petri-nonexistent/proj', root), join(root, '-petri-nonexistent'));
  });
  it('symlinked working dirs resolve to their real path', () => {
    const linked = tmpdir(), real = realpathSync(linked); // macOS: /var/folders is a link into /private
    const slug = real.replace(/[^A-Za-z0-9-]/g, '-');
    session('s3', 1000).write(join(root, slug));
    assert.equal(slugFor(join(linked, 'sub'), root), join(root, slug));
  });
  it('no project throws NoTranscripts', () => {
    assert.throws(() => collect('/petri-nonexistent/nothing', false, root), (e: unknown) => e instanceof NoTranscripts && /no transcripts/.test(e.message));
  });
  it('all projects', () => {
    session('a', 1000).write(join(root, '-p1'));
    session('b', 2000).write(join(root, '-p2'));
    assert.deepEqual(collect(undefined, true, root).map(r => [r.id, r.project]), [['a', '-p1'], ['b', '-p2']]);
  });
  it('subagent dirs are not runs', () => {
    const t = session('a', 1000);
    const tid = t.call('Agent', { description: 'x' });
    t.subagent('s', { toolUseId: tid, calls: 4 });
    t.write(join(root, '-p1'));
    assert.equal(collect(undefined, true, root).length, 1);
  });
});

describe('cli', () => {
  let home: string, proj: string;
  beforeEach(() => {
    home = tmpdir();
    proj = join(home, '.claude', 'projects', '-petri-nonexistent-proj');
    session('old00000-0000', 1_790_000_000, 'first task', 4).write(proj);
    session('new00000-0000', 1_790_100_000, '</script><script>alert(1)</script> <img src=x onerror=alert(2)>', 6).write(proj);
  });
  const cli = (args: string[], ok = true) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.PETRI_PROJECTS;
    const p = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
    if (ok) assert.equal(p.status, 0, p.stderr);
    return p;
  };

  it('--report', () => {
    const out = cli([proj, '--report']).stdout;
    assert.ok(out.startsWith('PETRI · -petri-nonexistent-proj · 2 runs'), out);
    assert.ok(out.includes('run 2/2  new00000'));
  });
  it('--report from a working dir', () => assert.ok(cli(['/petri-nonexistent/proj/sub', '--report']).stdout.includes('2 runs')));
  it('--all', () => assert.ok(cli(['--all', '--report']).stdout.includes('PETRI · all projects · 2 runs')));
  it('--json trims old events', () => {
    const data = JSON.parse(cli([proj, '--json', '--runs', '1']).stdout) as DishData;
    assert.deepEqual(data.runs.map(r => r.events.length > 0), [false, true]);
    assert.equal(data.lineage.n, 2);
    assert.equal(data.scope, '-petri-nonexistent-proj');
  });
  it('--runs 0 strips every event', () => {
    const data = JSON.parse(cli([proj, '--json', '--runs', '0']).stdout) as DishData;
    assert.ok(data.runs.every(r => r.events.length === 0));
  });
  it('the dish is written and safe from script injection', () => {
    const out = join(home, 'dish.html');
    const p = cli([proj, '-o', out, '--no-open']);
    assert.ok(p.stdout.includes(`dish → ${out}`));
    const html = readFileSync(out, 'utf8');
    assert.ok(!html.includes('/*__DATA__*/null') && !html.includes('/*__APP__*/'));
    assert.ok(!html.includes('</script><script>alert(1)'));
    const template = readFileSync(join(ROOT, 'src', 'render', 'dish.html'), 'utf8');
    assert.equal(html.split('</script>').length, template.split('</script>').length);
    const start = html.indexOf('window.PETRI_DATA = ') + 'window.PETRI_DATA = '.length;
    const data = JSON.parse(html.slice(start, html.indexOf(';</script>', start))) as DishData;
    assert.equal(data.runs.length, 2);
    assert.ok(data.runs[1]!.title.includes('<img src=x onerror=alert(2)>'));
  });
  it('no transcripts exits 1', () => {
    const p = cli(['/petri-nonexistent/elsewhere', '--report'], false);
    assert.equal(p.status, 1);
    assert.ok(p.stderr.includes('no transcripts'));
  });
  it('bad arguments exit 2', () => {
    assert.equal(cli(['--runs', 'many'], false).status, 2);
    assert.equal(cli(['--bogus'], false).status, 2);
    assert.equal(cli(['a', 'b'], false).status, 2);
  });
  it('--help', () => assert.ok(cli(['--help']).stdout.includes('--report')));
});
