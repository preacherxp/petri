// Pure helpers: shell classification, summaries, sizes, timestamps, JSONL reading, number formatting.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { bashKind, kindOf, resultSize, shortPath, summarize, textOf, ts } from '../src/classify.ts';
import { iterJson } from '../src/jsonl.ts';
import { fmtK, fmtTime } from '../src/report.ts';
import { collapse, cut, pyFixed, pyJson, pyLen, pyRound, stableStringify } from '../src/util.ts';
import { knownGap, tmpdir } from './helpers.ts';

const SENSE = [
  'ls -la', 'cat f.txt', 'grep -rn foo .', 'rg foo src', 'git status', 'git log --oneline -5', 'git diff HEAD~1',
  'git show HEAD', 'git blame f.py', 'head -20 x', 'tail -f log', "find . -name '*.py'", 'wc -l a b', 'jq . f.json',
  'echo hello', 'pwd', 'diff a b', 'tree', "awk '{print $1}' f", "sed -n '1,20p' f", 'stat f', 'du -sh .',
  'cd /x && cat f', 'cd /x; ls', 'ls 2>/dev/null', 'grep x f 2>&1 | head', 'cat f > /dev/null',
  "awk 'NR>1' f | node -e 'a => a'", 'grep -n "rm -rf" setup.sh', "grep '>>' notes.md",
];
const ACT = [
  'echo hi > f.txt', 'cat a >> b', 'echo a>b', "sed -i 's/a/b/' f", 'mv a b', 'cp a b', 'mkdir -p x', 'rm -rf build',
  'touch f', 'chmod +x s', 'ln -s a b', 'git add .', 'git commit -m x', 'git checkout main', 'git switch dev',
  'git push', 'git pull', 'git merge x', 'git rebase main', 'git stash', 'git reset --hard', 'git init', 'git clone u',
  'npm install', 'npm i lodash', 'npm add x', 'bun install', 'bun add zod', 'bun i', 'pip install x', 'pip3 install x', 'brew install jq', 'ls | tee out.txt',
  'cd /x && rm f', 'echo $(date) > /tmp/x',
];
const RUN = [
  'npm test', 'python3 x.py', 'make', 'pytest -q', 'node script.js', 'cargo build 2>&1', 'docker ps', 'sleep 5',
  'python3 x.py >&2', 'npm test > /dev/null', 'lsblk', 'catalog', 'npx vite build', 'bun test', 'bun run build', 'bunx tsc',
  'node -e "[1, 2].map(x => x * 2)"', 'kotlinc a.kt -d out -> x',
];

describe('bashKind', () => {
  for (const [kind, cmds] of [['sense', SENSE], ['act', ACT], ['run', RUN]] as const) {
    it(`classifies ${kind} commands`, () => {
      for (const cmd of cmds) assert.equal(bashKind(cmd), kind, cmd);
    });
  }
  it('only the first line decides sense', () => assert.equal(bashKind('ls\nnpm test'), 'sense'));
  it('a write anywhere wins', () => assert.equal(bashKind('ls -la\ngit commit -m x'), 'act'));
  it('empty is run', () => assert.equal(bashKind(''), 'run'));
  it('heredoc script that writes files is act', knownGap('scripts are classified by their interpreter', () => {
    assert.equal(bashKind("python3 - <<'EOF'\nopen('f', 'w').write('x')\nEOF"), 'act');
  }));
});

describe('kindOf', () => {
  it('maps tools and falls back to meta', () => {
    assert.equal(kindOf('Read', {}), 'sense');
    assert.equal(kindOf('Edit', {}), 'act');
    assert.equal(kindOf('Agent', {}), 'spawn');
    assert.equal(kindOf('AskUserQuestion', {}), 'talk');
    assert.equal(kindOf('Bash', { command: 'rm x' }), 'act');
    assert.equal(kindOf('mcp__x__y', {}), 'meta');
  });
  it('ignores inherited object keys', () => {
    assert.equal(kindOf('constructor', {}), 'meta');
    assert.equal(kindOf('toString', {}), 'meta');
  });
});

describe('shortPath', () => {
  it('is relative inside cwd', () => assert.equal(shortPath('/w/src/a.py', '/w'), 'src/a.py'));
  it('handles a trailing slash on cwd', () => assert.equal(shortPath('/w/src/a.py', '/w/'), 'src/a.py'));
  it('a shared prefix is not containment', () => assert.equal(shortPath('/work/a/b.py', '/w'), 'a/b.py'));
  it('keeps the last two parts outside cwd', () => assert.equal(shortPath('/etc/nginx/sites/x.conf', '/w'), 'sites/x.conf'));
  it('leaves short paths alone', () => {
    assert.equal(shortPath('/a/b', '/w'), '/a/b');
    assert.equal(shortPath('rel.txt', null), 'rel.txt');
  });
});

describe('summarize', () => {
  it('file tools', () => {
    assert.equal(summarize('Read', { file_path: '/w/a.py' }, '/w'), 'a.py');
    assert.equal(summarize('NotebookEdit', { notebook_path: '/w/n.ipynb' }, '/w'), 'n.ipynb');
  });
  it('bash strips cd and whitespace', () => {
    assert.equal(summarize('Bash', { command: 'cd /w/x &&   npm\n test' }, '/w'), 'npm test');
    assert.equal(summarize('Bash', { command: 'cd /w; ls' }, '/w'), 'ls');
  });
  it('bash truncates to 90', () => assert.equal(summarize('Bash', { command: 'x'.repeat(500) }, '/w').length, 90));
  it('named fields', () => {
    const cases: [string, unknown, string][] = [['Grep', { pattern: 'foo' }, 'foo'], ['Agent', { description: 'review', prompt: 'long' }, 'review'],
      ['WebFetch', { url: 'https://x' }, 'https://x'], ['WebSearch', { query: 'q' }, 'q'], ['Skill', { skill: 'lavish' }, 'lavish']];
    for (const [tool, inp, want] of cases) assert.equal(summarize(tool, inp, '/w'), want, tool);
  });
  it('AskUserQuestion uses the first question', () => {
    assert.equal(summarize('AskUserQuestion', { questions: [{ question: 'Which?' }] }, '/w'), 'Which?');
    assert.equal(summarize('AskUserQuestion', { questions: [] }, '/w'), '');
  });
  it('unknown input prints as JSON', () => assert.equal(summarize('mcp__x__y', { a: 1, b: 'ż' }, '/w'), '{"a": 1, "b": "\\u017c"}'));
  it('non-object input prints as text', () => assert.equal(summarize('X', 'plain', '/w'), 'plain'));
});

describe('text and size', () => {
  it('textOf', () => {
    assert.equal(textOf('abc'), 'abc');
    assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }, 'junk']), 'a\nb');
    assert.equal(textOf(null), '');
  });
  it('resultSize counts code points of text only', () => {
    assert.equal(resultSize('abcd'), 4);
    assert.equal(resultSize('😀😀'), 2);
    assert.equal(resultSize([{ type: 'text', text: 'ab' }, { type: 'image' }, { type: 'text', text: 'c' }]), 3);
    assert.equal(resultSize(null), 0);
    assert.equal(resultSize({ weird: 1 }), 0);
  });
});

describe('timestamps', () => {
  it('parses Zulu and offsets', () => {
    const want = Date.UTC(2026, 9, 5, 0, 0, 1) / 1000;
    assert.equal(ts('2026-10-05T00:00:01.000Z'), want);
    assert.equal(ts('2026-10-05T02:00:01+02:00'), want);
  });
  it('rejects bad values', () => {
    for (const bad of ['', 'nope', '2026-13-40T00:00:00Z', undefined, 42]) assert.equal(ts(bad), null, String(bad));
  });
});

describe('iterJson', () => {
  it('skips garbage and replaces invalid UTF-8', () => {
    const f = join(tmpdir(), 'x.jsonl');
    writeFileSync(f, Buffer.concat([Buffer.from('{"a": 1}\nnot json\n{"broken": \n\n  {"indented": 1}\n{"b": "'), Buffer.from([0xff]), Buffer.from('"}\n[1, 2]\n')]));
    const rows = [...iterJson(f)];
    assert.deepEqual(rows[0], { a: 1 });
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.b, '�');
  });
  it('round-trips many lines and CRLF', () => {
    const f = join(tmpdir(), 'y.jsonl');
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => JSON.stringify({ i })).join('\r\n'));
    assert.deepEqual([...iterJson(f)].map(r => r.i), Array.from({ length: 100 }, (_, i) => i));
  });
});

describe('python-compatible numbers and text', () => {
  it('pyRound rounds half to even on the exact value', () => {
    assert.equal(pyRound(0.5), 0);
    assert.equal(pyRound(1.5), 2);
    assert.equal(pyRound(2.5), 2);
    assert.equal(pyRound(-2.5), -2);
    assert.equal(pyRound(12.25, 1), 12.2);
    assert.equal(pyRound(2.675, 2), 2.67);
    assert.equal(pyRound(0.15, 1), 0.1);
    assert.equal(pyRound(92.5), 92);
  });
  it('pyFixed', () => {
    assert.equal(pyFixed(84.5), '84');
    assert.equal(pyFixed(85.5), '86');
    assert.equal(pyFixed(0.125, 2), '0.12');
  });
  it('cut and pyLen count code points', () => {
    assert.equal(cut('😀ab', 2), '😀a');
    assert.equal(pyLen('😀ab'), 3);
  });
  it('collapse', () => assert.equal(collapse('  a\n\tb   c '), 'a b c'));
  it('stableStringify ignores key order at every level', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }), stableStringify({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
  });
  it('pyJson matches json.dumps', () => assert.equal(pyJson({ a: [1, 'x'], b: null, c: true }), '{"a": [1, "x"], "b": null, "c": true}'));
});

describe('report formatting', () => {
  it('fmtK', () => {
    assert.equal(fmtK(999), '999');
    assert.equal(fmtK(1000), '1k');
    assert.equal(fmtK(1499), '1k');
    assert.equal(fmtK(1500), '2k');
    assert.equal(fmtK(2500), '2k');
    assert.equal(fmtK(250_000), '250k');
  });
  it('fmtTime', () => {
    assert.equal(fmtTime(null), '?');
    assert.match(fmtTime(1_790_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
