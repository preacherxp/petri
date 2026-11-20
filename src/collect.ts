import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseRun } from './parse.ts';
import { score } from './score.ts';
import type { ScoredRun } from './types.ts';

/** Where Claude Code keeps session transcripts. PETRI_PROJECTS overrides it. */
export function projectsDir(): string {
  return process.env.PETRI_PROJECTS || join(homedir(), '.claude', 'projects');
}

export class NoTranscripts extends Error {}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const jsonlIn = (d: string) => (isDir(d) ? readdirSync(d).filter(f => f.endsWith('.jsonl') && statSync(join(d, f)).isFile()).map(f => join(d, f)) : []);

/** Sort paths component by component, so "a/x" comes before "a-b/x". */
function byParts(a: string, b: string): number {
  const pa = a.split('/'), pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return pa.length - pb.length;
}

/** Absolute path with symlinks resolved for the part that exists, like Python's Path.resolve(). */
function resolveLoose(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head) && head !== dirname(head)) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...tail);
}

/**
 * Transcript directory for a working directory. Sessions are keyed by the directory they started in,
 * so walk up the parents and take the nearest one that has sessions.
 */
export function slugFor(cwd: string, root = projectsDir()): string | null {
  let p = resolveLoose(cwd);
  for (;;) {
    for (const cand of [p.replaceAll('/', '-'), p.replace(/[^A-Za-z0-9-]/g, '-')]) {
      const dir = join(root, cand);
      if (jsonlIn(dir).length) return dir;
    }
    if (p === dirname(p)) return null;
    p = dirname(p);
  }
}

/**
 * Parse and score runs, oldest first.
 * target: a .jsonl file, a project transcript directory, or a working directory (default: cwd).
 */
export function collect(target: string | undefined, all: boolean, root = projectsDir()): ScoredRun[] {
  let files: string[], where: string;
  if (all) {
    files = (isDir(root) ? readdirSync(root) : []).flatMap(d => jsonlIn(join(root, d)));
    where = root;
    if (!files.length) throw new NoTranscripts(`no transcripts under ${root} (Claude Code writes them there; PETRI_PROJECTS points elsewhere)`);
  } else if (target && existsSync(target) && statSync(target).isFile()) {
    files = [target];
    where = target;
  } else if (target?.endsWith('.jsonl')) {
    throw new NoTranscripts(`no such transcript: ${target}`);
  } else {
    const d = target || process.cwd();
    const proj = jsonlIn(d).length ? d : slugFor(d, root);
    if (!proj) throw new NoTranscripts(`no transcripts for ${d} under ${root} (try --all or pass a .jsonl)`);
    files = jsonlIn(proj);
    where = proj;
  }
  const runs: ScoredRun[] = [];
  for (const f of files.sort(byParts)) {
    const r = parseRun(f);
    if (r.stats.prompts === 0 && r.stats.calls === 0) continue;
    r.project = basename(dirname(f));
    runs.push(score(r));
  }
  if (!runs.length) throw new NoTranscripts(`${files.length} transcript${files.length === 1 ? '' : 's'} in ${where}, but none has a prompt or a tool call (try --all)`);
  return runs.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
}
