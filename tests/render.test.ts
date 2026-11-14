// Render the dish in headless Chrome and check what a person would see. Skipped without Chrome.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, it } from 'bun:test';
import { ROOT } from '../src/dish.ts';
import { tmpdir, Transcript } from './helpers.ts';

const which = (cmd: string) => { try { return execFileSync('which', [cmd], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const CHROME = [process.env.PETRI_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', which('google-chrome'), which('chromium'), which('chromium-browser')]
  .find(p => p && existsSync(p));
const NASTY = '<img src=x onerror=alert(1)> & </script>';

// Skipped when Chrome is missing; set PETRI_CHROME to point at a binary.
describe.skipIf(!CHROME)('dish in headless Chrome', () => {
  let dish = '';
  beforeAll(() => {
    const home = tmpdir(), proj = join(home, '.claude', 'projects', '-petri-nonexistent-proj');
    for (let i = 0; i < 3; i++) {
      const t = new Transcript({ sid: `run${i}0000-0000`, start: 1_790_000_000 + i * 86_400 }).prompt(i === 2 ? NASTY : `task ${i}`);
      t.calls([['Read', { file_path: '/w/a.py' }, 'x'.repeat(4000)], ['Grep', { pattern: 'foo' }]]);
      t.call('Edit', { file_path: '/w/a.py' }, '<tool_use_error>String to replace not found</tool_use_error>', true);
      const tid = t.call('Agent', { description: 'sub' });
      t.subagent(`sub${i}`, { toolUseId: tid, calls: 9, errors: 1 });
      t.compact();
      t.prompt('continue');
      t.call('Bash', { command: 'npm test' }, 'x'.repeat(30_000));
      t.say('done');
      t.write(proj);
    }
    dish = join(home, 'dish.html');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.PETRI_PROJECTS;
    const p = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), proj, '-o', dish, '--no-open'], { env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
  }, 60_000);
  const render = (frag = '#end') => {
    const p = spawnSync(CHROME!, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,900', '--virtual-time-budget=3000',
      '--enable-logging=stderr', '--v=0', '--dump-dom', pathToFileURL(dish).href + frag], { encoding: 'utf8', timeout: 120_000 });
    return { dom: p.stdout, log: p.stderr };
  };

  it('renders without script errors', () => {
    const { dom, log } = render();
    assert.doesNotMatch(log, /Uncaught|SyntaxError|TypeError|ReferenceError/);
    assert.ok(dom.includes('FITNESS') && dom.includes('MUTATIONS FOR NEXT RUN'));
    assert.equal(dom.match(/class="thumb/g)?.length, 3);
    assert.ok(dom.includes('class="thumb cur"'));
  }, 60_000);
  it('selects the latest run and escapes its title', () => {
    const { dom } = render();
    const title = /<div class="title" id="title">([\s\S]*?)<\/div>/.exec(dom)![1]!;
    assert.ok(title.includes('&lt;img src=x onerror=alert(1)&gt;'), title);
    assert.ok(!title.includes('<img'));
    assert.ok(!dom.split('id="lineage"')[0]!.includes('<img src='));
  }, 60_000);
  it('deep-links to the first run', () => {
    const { dom } = render('#run=1&end');
    assert.ok(dom.includes('RUN 1 / 3'));
    assert.ok(dom.includes('task 0'));
  }, 60_000);
  it('marks prompts and the molt on the timeline', () => {
    const { dom } = render();
    assert.equal(dom.split('class="tick molt"').length - 1, 1);
    assert.equal(dom.split('class="tick prompt"').length - 1, 2);
  }, 60_000);
});
