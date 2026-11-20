// Tools reached through MCP (mcp__<server>__<tool>): classified by name, then by input shape, and checked like built-ins.
import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { classifyCall, DMG } from '../src/classify.ts';
import { dmg, first, flags, tools, Transcript } from './helpers.ts';

const cls = (tool: string, input: Record<string, unknown> = {}) => {
  const c = classifyCall(tool, input);
  return [c.kind, c.as] as const;
};

describe('classifyCall', () => {
  it('maps each category by tool name, whatever the server', () => {
    const CASES: [string, Record<string, unknown>, string, string | undefined][] = [
      ['mcp__harness__read', { path: '/w/a' }, 'sense', 'Read'],
      ['mcp__filesystem__read_text_file', { path: '/w/a' }, 'sense', 'Read'],
      ['mcp__my-server__readFile', { path: '/w/a' }, 'sense', 'Read'],
      ['mcp__harness__grep', { pattern: 'x', path: '/w' }, 'sense', 'Grep'],
      ['mcp__harness__glob', { pattern: '*.ts' }, 'sense', 'Glob'],
      ['mcp__filesystem__list_directory', { path: '/w' }, 'sense', 'Glob'],
      ['mcp__harness__edit', { path: '/w/a', oldString: 'a', newString: 'b' }, 'act', 'Edit'],
      ['mcp__filesystem__edit_file', { path: '/w/a', edits: [] }, 'act', 'Edit'],
      ['mcp__harness__write', { path: '/w/a', content: 'x' }, 'act', 'Write'],
      ['mcp__harness__shell', { command: 'ls -la' }, 'sense', 'Bash'],
      ['mcp__harness__bash', { command: 'rm -rf build' }, 'act', 'Bash'],
      ['mcp__desktop__execute_command', { command: 'npm test' }, 'run', 'Bash'],
      ['mcp__harness__webfetch', { url: 'https://example.com' }, 'sense', 'WebFetch'],
      ['mcp__harness__web_search', { query: 'q' }, 'sense', 'WebSearch'],
      ['mcp__harness__subagent', { description: 'review', prompt: 'p' }, 'spawn', 'Agent'],
      ['mcp__harness__task', { description: 'review' }, 'spawn', 'Agent'],
      ['mcp__harness__question', { questions: [] }, 'talk', 'AskUserQuestion'],
      ['mcp__claude_ai_x__ask_user', { question: 'which?' }, 'talk', 'AskUserQuestion'],
    ];
    for (const [tool, input, kind, as] of CASES) assert.deepEqual(cls(tool, input), [kind, as], tool);
  });
  it('falls back to the shape of the input', () => {
    assert.deepEqual(cls('mcp__ide__apply_patch', { file_path: '/w/a', old_string: 'a', new_string: 'b' }), ['act', 'Edit']);
    assert.deepEqual(cls('mcp__ide__change', { filePath: '/w/a', oldText: 'a', newText: 'b' }), ['act', 'Edit']);
    assert.deepEqual(cls('mcp__box__sandbox_run', { command: 'git status' }), ['sense', 'Bash']);
    assert.deepEqual(cls('mcp__box__sandbox_run', { cmd: 'make' }), ['run', 'Bash']);
    assert.deepEqual(cls('mcp__code__find_symbol', { pattern: 'foo' }), ['sense', 'Grep']);
  });
  it('a shell-named tool that runs code, not a command line, is run', () => {
    assert.deepEqual(cls('mcp__harness__execute', { code: 'const a = b > c;' }), ['run', undefined]);
  });
  it('unknown MCP tools stay meta', () => {
    for (const [tool, input] of [['mcp__notes__save_note', { title: 't', body: 'b' }], ['mcp__kb__search', { query: 'q' }],
      ['mcp__browser__browser_navigate', { url: 'https://example.com' }], ['mcp__images__generate', { prompt: 'p', path: '/w/x.png' }],
      ['mcp__x__constructor', {}], ['mcp__weird', {}]] as const) {
      assert.deepEqual(cls(tool, input), ['meta', undefined], tool);
    }
  });
  it('built-in tools are untouched', () => {
    assert.deepEqual(cls('Read', { file_path: '/w/a' }), ['sense', undefined]);
    assert.deepEqual(cls('Bash', { command: 'rm x' }), ['act', undefined]);
    assert.deepEqual(cls('read', { path: '/w/a' }), ['meta', undefined]);
  });
  it('renames input fields to the built-in spelling', () => {
    assert.deepEqual(classifyCall('mcp__h__edit', { path: '/w/a', oldString: 'a', newString: 'b', replaceAll: true }).input,
      { file_path: '/w/a', old_string: 'a', new_string: 'b', replace_all: true });
    assert.deepEqual(classifyCall('mcp__h__grep', { pattern: 'x', path: '/w' }).input, { pattern: 'x', path: '/w' }, 'a search path is not a file');
    assert.deepEqual(classifyCall('mcp__h__shell', { cmd: 'ls' }).input, { command: 'ls' });
  });
});

const A = { path: '/w/src/a.py' };

describe('checks on MCP calls', () => {
  it('an event keeps its real name and records what it acts as', () => {
    const t = new Transcript().prompt('q');
    t.call('mcp__harness__read', A);
    const e = first(t.run());
    assert.deepEqual([e.tool, e.as, e.k, e.s], ['mcp__harness__read', 'Read', 'sense', 'src/a.py']);
  });
  it('rereads, with the hint naming the file', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 3; i++) t.call('mcp__harness__read', A);
    const r = t.run();
    assert.deepEqual(flags(r), [[], ['reread'], ['reread']]);
    assert.equal(r.stats.reads, 3);
    assert.ok(r.hints[0]!.startsWith('Re-read unchanged files: src/a.py 3×'), r.hints[0]);
  });
  it('an MCP edit resets the reread check, with either field spelling', () => {
    for (const edit of [{ path: A.path, oldString: 'a', newString: 'b' }, { file_path: A.path, old_string: 'a', new_string: 'b' }]) {
      const t = new Transcript().prompt('q');
      t.call('mcp__harness__read', A);
      t.call('mcp__harness__edit', edit);
      t.call('mcp__harness__read', A);
      const r = t.run();
      assert.equal(r.stats.rereads, 0, JSON.stringify(edit));
      assert.equal(r.stats.edits, 1);
    }
  });
  it('built-in and MCP reads share one cache', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: A.path });
    t.call('mcp__harness__read', A);
    t.call('mcp__other__write_file', { path: A.path, content: 'x' });
    t.call('Read', { file_path: A.path });
    assert.deepEqual(flags(t.run()), [[], ['reread'], [], []]);
  });
  it('different ranges, in a harness\'s own field names, are different reads', () => {
    const t = new Transcript().prompt('q');
    t.call('mcp__h__read', { ...A, offset: 1, limit: 50 });
    t.call('mcp__h__read', { ...A, offset: 51, limit: 50 });
    t.call('mcp__fs__read_file', { ...A, head: 20 });
    t.call('mcp__fs__read_file', { ...A, head: 20 });
    assert.deepEqual(flags(t.run()), [[], [], [], ['reread']]);
  });
  it('errors, the error streak and the hint name the real tool', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 3; i++) t.call('mcp__harness__shell', { command: `npm test ${i}` }, 'Exit code 1\nboom', true);
    const r = t.run();
    assert.deepEqual([r.stats.errors, r.stats.thrash], [3, 1]);
    assert.deepEqual(dmg(r), [DMG.error, DMG.error, DMG.error + DMG.thrash]);
    assert.ok(r.hints[0]!.startsWith('3 errors (mcp__harness__shell ×3). First: `npm test 0` → "boom"'), r.hints[0]);
  });
  it('oversized output names the tool and file', () => {
    const t = new Transcript().prompt('q');
    t.call('mcp__harness__read', { path: '/w/huge.json' }, 'x'.repeat(40_000));
    const r = t.run();
    assert.deepEqual(flags(r), [['fat']]);
    assert.ok(r.hints[0]!.includes('largest: mcp__harness__read `huge.json` 40k'), r.hints[0]);
  });
  it('a verbatim retry, even with the command field spelled cmd', () => {
    const t = new Transcript().prompt('q');
    t.call('mcp__box__run_command', { cmd: 'make' }, 'Exit code 2', true);
    t.call('mcp__box__run_command', { cmd: 'make' });
    assert.deepEqual(flags(t.run()), [[], ['retry']]);
  });
  it('parallel MCP calls fan from one turn', () => {
    const t = new Transcript().prompt('q');
    t.calls([['mcp__h__read', A], ['mcp__h__grep', { pattern: 'x' }], ['mcp__h__glob', { pattern: '*' }]]);
    assert.deepEqual(tools(t.run()).map(e => [e.g, e.par]), [[0, 0], [0, 1], [0, 1]]);
  });
  it('web, subagents and questions count towards stats and traits', () => {
    const t = new Transcript().prompt('q');
    t.call('mcp__h__webfetch', { url: 'https://example.com' });
    t.call('mcp__h__websearch', { query: 'q' });
    t.call('mcp__h__subagent', { description: 'a' });
    t.call('mcp__h__subagent', { description: 'b' });
    t.call('mcp__h__question', { questions: [{ question: 'Which one?' }] });
    const r = t.run();
    assert.deepEqual([r.stats.web, r.stats.agents], [2, 2]);
    assert.deepEqual(r.stats.by_kind, { sense: 2, spawn: 2, talk: 1 });
    assert.ok(r.traits.includes('Forager') && r.traits.includes('Delegator'), r.traits.join());
    assert.deepEqual(tools(r)[2]!.sub, { calls: 0, errors: 0, out: 0 });
    assert.equal(tools(r)[4]!.s, 'Which one?');
  });
  it('an unknown MCP tool stays meta and is not checked for rereads', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 2; i++) t.call('mcp__kb__get_section', { path: '/w/doc.md', lines: '1-20' });
    const r = t.run();
    assert.deepEqual([r.stats.by_kind, r.stats.reads, r.stats.rereads], [{ meta: 2 }, 0, 0]);
    assert.equal(first(r).as, undefined);
  });
});
