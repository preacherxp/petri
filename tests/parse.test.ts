// parseRun: transcript lines into events, usage, timing and subagent stats.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { parseRun, subStats } from '../src/parse.ts';
import { score } from '../src/score.ts';
import { first, kinds, tmpdir, tools, Transcript, usage } from './helpers.ts';

describe('prompts', () => {
  it('a prompt becomes an event and the title', () => {
    const r = new Transcript().prompt('fix the bug').run();
    assert.deepEqual(r.events[0], { k: 'prompt', t: 0, s: 'fix the bug' });
    assert.equal(r.title, 'fix the bug');
    assert.equal(r.stats.prompts, 1);
  });
  it('collapses whitespace and truncates to 120', () => {
    const s = new Transcript().prompt('a\n\n  b   c ' + 'x'.repeat(300)).run().events[0]!.s!;
    assert.ok(s.startsWith('a b c x'));
    assert.equal(s.length, 120);
  });
  it('reads block-list prompts', () => {
    const t = new Transcript();
    t.raw(t.base('user', 1, { message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] } }));
    assert.equal(t.run().events[0]!.s, 'hello');
  });
  it('harness noise is not a prompt', () => {
    const t = new Transcript();
    for (const text of ['<command-name>/model</command-name>', '<local-command-stdout>ok</local-command-stdout>',
      '<local-command-caveat>x</local-command-caveat>', '<system-reminder>x</system-reminder>',
      '<agent-message from="a">x</agent-message>', '[Request interrupted by user]', '   ', '']) t.prompt(text);
    t.prompt('real', { isMeta: true });
    t.prompt(null);
    const r = t.run();
    assert.equal(r.stats.prompts, 0);
    assert.equal(r.title, '');
  });
  it('title is the first prompt', () => {
    const r = new Transcript().prompt('first').prompt('second').run();
    assert.equal(r.title, 'first');
    assert.equal(r.stats.prompts, 2);
  });
});

describe('assistant turns', () => {
  it('a text-only turn is talk', () => {
    const talk = new Transcript().prompt('q').say('All  done.\nBye').run().events.at(-1)!;
    assert.deepEqual([talk.k, talk.s, talk.out], ['talk', 'All done. Bye', 100]);
  });
  it('text next to a tool call is not talk', () => {
    const t = new Transcript().prompt('q');
    t.assistant([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '/w/a' } }]);
    t.results([['toolu_x', 'ok', false]]);
    assert.deepEqual(kinds(t.run()), ['prompt', 'sense']);
  });
  it('blank text is not talk', () => assert.deepEqual(kinds(new Transcript().prompt('q').say('   ').run()), ['prompt']));
  it('a thinking-only message is silent but counted', () => {
    const t = new Transcript().prompt('q');
    t.assistant([{ type: 'thinking', thinking: '', signature: 's' }]);
    const r = t.run();
    assert.deepEqual(kinds(r), ['prompt']);
    assert.equal(r.tokens.out, 100);
  });
  it('API error messages are ignored', () => {
    const t = new Transcript().prompt('q');
    t.assistant([{ type: 'text', text: 'API Error: overloaded' }], { extra: { isApiErrorMessage: true } });
    const r = t.run();
    assert.deepEqual(kinds(r), ['prompt']);
    assert.equal(r.model, null);
  });
  it('model and cwd', () => {
    const t = new Transcript({ cwd: '/proj', model: 'claude-x' }).prompt('q');
    t.call('Read', { file_path: '/proj/a.py' });
    const r = t.run();
    assert.equal(r.model, 'claude-x');
    assert.equal(r.cwd, '/proj');
    assert.equal(first(r).s, 'a.py');
  });
});

describe('usage accounting', () => {
  it('a split message counts usage once', () => {
    const t = new Transcript().prompt('q');
    t.calls([['Read', { file_path: '/w/a' }], ['Read', { file_path: '/w/b' }]], { thinking: true });
    assert.deepEqual(t.run().tokens, { in: 5, cache_read: 1000, cache_create: 0, out: 100, think: 80 });
  });
  it('usage lands on the first tool of a message', () => {
    const t = new Transcript().prompt('q');
    t.calls([['Read', { file_path: '/w/a' }], ['Read', { file_path: '/w/b' }]], { use: usage({ out: 40, cacheRead: 2000 }) });
    const [a, b] = tools(t.run());
    assert.deepEqual([a!.out, a!.ctx], [40, 2005]);
    assert.deepEqual([b!.out, b!.ctx], [0, 0]);
  });
  it('tokens sum across messages', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 3; i++) t.call('Read', { file_path: `/w/${i}` }, 'ok', false, { use: usage({ out: 10 * (i + 1), think: 5, inp: 1, cacheRead: 100 * (i + 1), cacheCreate: 7 }) });
    const r = t.run();
    assert.deepEqual(r.tokens, { in: 3, cache_read: 600, cache_create: 21, out: 60, think: 15 });
    assert.equal(r.stats.peak_ctx, 1 + 300 + 7);
  });
  it('missing usage is zero', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: '/w/a' }, 'ok', false, { use: null });
    const r = t.run();
    assert.equal(r.tokens.out, 0);
    assert.equal(first(r).ctx, 0);
  });
  it('a repeated message id is not double counted', () => {
    const t = new Transcript().prompt('q');
    t.assistant([{ type: 'text', text: 'a' }], { mid: 'msg_same' });
    t.prompt('again');
    t.assistant([{ type: 'text', text: 'b' }], { mid: 'msg_same' });
    assert.equal(t.run().tokens.out, 100);
  });
});

describe('tool pairing', () => {
  it('results attach by id', () => {
    const t = new Transcript().prompt('q');
    t.calls([['Read', { file_path: '/w/a' }, 'x'.repeat(30)], ['Grep', { pattern: 'p' }, [{ type: 'text', text: 'y'.repeat(7) }]]]);
    assert.deepEqual(tools(t.run()).map(e => e.res), [30, 7]);
  });
  it('results can arrive in any order', () => {
    const t = new Transcript().prompt('q');
    const ids = t.calls([['Read', { file_path: '/w/a' }], ['Read', { file_path: '/w/b' }]], { results: false });
    t.results([[ids[1]!, 'bb', false]]).results([[ids[0]!, 'a', true]]);
    const [a, b] = tools(t.run());
    assert.deepEqual([a!.res, a!.err], [1, 1]);
    assert.deepEqual([b!.res, b!.err], [2, undefined]);
  });
  it('an unanswered call has no result', () => {
    const t = new Transcript().prompt('q');
    t.call('Bash', { command: 'sleep 99' }, 'ok', false, { results: false });
    const e = first(t.run());
    assert.equal(e.res, 0);
    assert.equal(e.err, undefined);
    assert.equal(e.flags, undefined);
  });
  it('an orphan result is ignored', () => {
    const r = new Transcript().prompt('q').results([['toolu_ghost', 'boo', true]]).run();
    assert.deepEqual([r.stats.calls, r.stats.errors], [0, 0]);
  });
  it('captures error text', () => {
    const t = new Transcript().prompt('q');
    t.call('Edit', { file_path: '/w/a' }, [{ type: 'text', text: '<tool_use_error>File has not\nbeen read yet</tool_use_error>' + 'z'.repeat(300) }], true);
    const e = first(t.run());
    assert.equal(e.err, 1);
    assert.ok(e.e!.startsWith('<tool_use_error>File has not been read yet'));
    assert.equal(e.e!.length, 160);
  });
  it('strips internal bookkeeping', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: '/w/a' });
    const e = first(t.run()) as unknown as Record<string, unknown>;
    assert.ok(!('sig' in e) && !('id' in e));
  });
});

describe('turns', () => {
  it('parallel calls share a turn', () => {
    const t = new Transcript().prompt('q');
    t.calls([['Read', { file_path: '/w/a' }], ['Read', { file_path: '/w/b' }], ['Grep', { pattern: 'x' }]]);
    const es = tools(t.run());
    assert.deepEqual(es.map(e => e.g), [0, 0, 0]);
    assert.deepEqual(es.map(e => e.par), [0, 1, 1]);
  });
  it('sequential calls are separate turns', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: '/w/a' });
    t.call('Read', { file_path: '/w/b' });
    const es = tools(t.run());
    assert.deepEqual(es.map(e => e.g), [0, 1]);
    assert.deepEqual(es.map(e => e.par), [0, 0]);
  });
  it('talk does not open a turn', () => {
    const t = new Transcript().prompt('q');
    t.call('Read', { file_path: '/w/a' });
    t.say('thinking out loud');
    t.call('Read', { file_path: '/w/b' });
    const r = t.run();
    assert.equal(r.stats.turns, 2);
    assert.deepEqual(kinds(r), ['prompt', 'sense', 'talk', 'sense']);
  });
});

describe('kinds', () => {
  it('maps every tool type', () => {
    const t = new Transcript().prompt('q');
    for (const [name, inp] of [['Read', { file_path: '/w/a' }], ['Glob', { pattern: '*' }], ['Edit', { file_path: '/w/a' }],
      ['Write', { file_path: '/w/b' }], ['Agent', { description: 'd' }], ['AskUserQuestion', { questions: [] }],
      ['Skill', { skill: 's' }], ['mcp__x__y', {}], ['Bash', { command: 'ls' }], ['Bash', { command: 'rm x' }],
      ['Bash', { command: 'npm test' }], ['WebFetch', { url: 'u' }]] as const) t.call(name, inp);
    assert.deepEqual(tools(t.run()).map(e => e.k), ['sense', 'sense', 'act', 'act', 'spawn', 'talk', 'meta', 'meta', 'sense', 'act', 'run', 'sense']);
  });
  it('a nameless tool is meta', () => {
    const t = new Transcript().prompt('q');
    t.assistant([{ type: 'tool_use', id: 'toolu_n', input: {} }]);
    const e = first(t.run());
    assert.deepEqual([e.tool, e.k], ['?', 'meta']);
  });
});

describe('compaction', () => {
  it('a boundary plus its summary make one molt', () => {
    const r = new Transcript().prompt('q').compact({ pre: 500_000, post: 20_000, trigger: 'manual' }).run();
    const molts = r.events.filter(e => e.k === 'molt');
    assert.equal(molts.length, 1);
    assert.deepEqual([molts[0]!.pre, molts[0]!.post, molts[0]!.trig], [500_000, 20_000, 'manual']);
    assert.equal(r.stats.prompts, 1);
    assert.equal(r.stats.compactions, 1);
  });
  it('a summary without a boundary still molts', () => {
    assert.deepEqual(kinds(new Transcript().prompt('q').prompt('continued', { isCompactSummary: true }).run()), ['prompt', 'molt']);
  });
  it('two compactions', () => {
    assert.deepEqual(kinds(new Transcript().prompt('q').compact().prompt('more').compact({ summary: false }).run()), ['prompt', 'molt', 'prompt', 'molt']);
  });
});

describe('timing', () => {
  it('relative times and duration', () => {
    const t = new Transcript({ start: 1000 }).prompt('q');
    t.call('Read', { file_path: '/w/a' });
    t.say('done', { dt: 60 });
    const r = t.run();
    assert.equal(r.started, 1001);
    assert.equal(r.duration_s, 62);
    assert.deepEqual(r.events.map(e => e.t), [0, 1, 62]);
  });
  it('lines without timestamps', () => {
    const t = new Transcript().prompt('q');
    const line = t.base('user', 1, { message: { role: 'user', content: 'no clock' } });
    delete line.timestamp;
    t.raw(line);
    const r = t.run();
    assert.equal(r.stats.prompts, 2);
    assert.equal(r.events[1]!.t, null);
  });
  it('an empty transcript', () => {
    const f = join(tmpdir(), 'empty.jsonl');
    writeFileSync(f, '');
    const r = parseRun(f);
    assert.deepEqual(r.events, []);
    assert.deepEqual([r.started, r.duration_s, r.title, r.stats.calls], [null, 0, '', 0]);
  });
});

describe('noise lines', () => {
  it('sidechain lines are skipped', () => {
    const t = new Transcript().prompt('q');
    const side = new Transcript({ sidechain: true });
    side.call('Bash', { command: 'rm -rf /' }, 'x', true);
    t.lines.push(...side.lines);
    assert.equal(t.run().stats.calls, 0);
  });
  it('metadata lines are ignored', () => {
    const t = new Transcript().prompt('q');
    for (const d of [{ type: 'file-history-snapshot', snapshot: {} }, { type: 'last-prompt', lastPrompt: 'x' },
      { type: 'attachment', attachment: { type: 'hook_success' } }, { type: 'user', message: 'string message' },
      { type: 'assistant', message: null }, { type: 'system', subtype: 'away_summary', content: 'x' }]) t.raw(d);
    assert.deepEqual(kinds(t.run()), ['prompt']);
  });
});

describe('subagents', () => {
  const spawn = (meta: true | string | null, useAgentId: boolean) => {
    const t = new Transcript().prompt('q');
    const tid = t.call('Agent', { description: 'review' }, 'launched', false, { toolUseResult: useAgentId ? { agentId: 'abc123', status: 'async_launched' } : undefined });
    t.subagent('abc123', { toolUseId: tid, calls: 5, errors: 2, meta, out: 30 });
    return first(t.run());
  };
  it('linked by meta.json', () => assert.deepEqual(spawn(true, false).sub, { calls: 5, errors: 2, out: 150, model: 'claude-sub' }));
  it('linked by agentId without meta', () => assert.equal(spawn(null, true).sub!.calls, 5));
  it('a broken meta falls back to agentId', () => assert.equal(spawn('{not json', true).sub!.calls, 5));
  it('a meta that is not an object falls back to agentId', () => assert.equal(spawn('[1, 2]', true).sub!.calls, 5));
  it('an unlinkable subagent leaves zero stats', () => assert.deepEqual(spawn(null, false).sub, { calls: 0, errors: 0, out: 0 }));
  it('an Agent without a transcript', () => {
    const t = new Transcript().prompt('q');
    t.call('Agent', { description: 'x' });
    assert.deepEqual(first(t.run()).sub, { calls: 0, errors: 0, out: 0 });
  });
  it('subagent lines never count as parent calls', () => {
    const t = new Transcript().prompt('q');
    const tid = t.call('Agent', { description: 'x' });
    t.subagent('s1', { toolUseId: tid, calls: 50 });
    assert.equal(t.run().stats.calls, 1);
  });
  it('subStats counts usage once per message', () => {
    const sub = new Transcript({ sidechain: true });
    sub.calls([['Read', { file_path: '/a' }], ['Read', { file_path: '/b' }]], { use: usage({ out: 70 }) });
    assert.deepEqual(subStats(sub.write()), { calls: 2, errors: 0, out: 70, model: 'claude-test' });
  });
});

describe('determinism', () => {
  it('the same file gives the same result', () => {
    const t = new Transcript().prompt('q');
    for (let i = 0; i < 20; i++) t.call('Read', { file_path: `/w/${i % 4}` }, 'x'.repeat(i * 1000), i % 7 === 0);
    const f = t.write();
    assert.equal(JSON.stringify(score(parseRun(f))), JSON.stringify(score(parseRun(f))));
  });
});
