#!/usr/bin/env bun
/**
 * petri: grow a roguelite organism from Claude Code session transcripts.
 * Each session is a run. Each tool call grows the organism. Mistakes leave scars.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { collect, NoTranscripts } from './collect.ts';
import { bundleIsStale, MissingBundle, renderDish, ROOT } from './dish.ts';
import { lineage, report } from './report.ts';
import type { DishData } from './types.ts';

const USAGE = `usage: petri [target] [--all] [--report] [--json] [--runs N] [-o FILE] [--no-open]

Grow a roguelite organism from Claude Code session transcripts.

positional arguments:
  target        a .jsonl transcript, a project dir, or a working dir (default: cwd)

options:
  -h, --help    show this help message and exit
  --all         every project under ~/.claude/projects
  --report      text report only (for agents)
  --json        JSON to stdout
  --runs N      embed full events for the N most recent runs (default 40)
  -o, --out     where to write the dish (default: dish.html in the petri directory)
  --no-open     don't open the dish in a browser`;

export function main(argv: string[]): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: 'boolean', default: false },
        report: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        runs: { type: 'string', default: '40' },
        out: { type: 'string', short: 'o', default: join(ROOT, 'dish.html') },
        'no-open': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`${USAGE}\n\npetri: error: ${(e as Error).message}\n`);
    return 2;
  }
  const a = args.values;
  if (a.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (args.positionals.length > 1) {
    process.stderr.write(`${USAGE}\n\npetri: error: unrecognized arguments: ${args.positionals.slice(1).join(' ')}\n`);
    return 2;
  }
  const keep = Number(a.runs);
  if (!Number.isInteger(keep) || keep < 0) {
    process.stderr.write(`${USAGE}\n\npetri: error: --runs must be a non-negative integer, got "${a.runs}"\n`);
    return 2;
  }

  let runs;
  try {
    runs = collect(args.positionals[0], a.all);
  } catch (e) {
    if (e instanceof NoTranscripts) {
      process.stderr.write(e.message + '\n');
      return 1;
    }
    throw e;
  }
  const scope = a.all ? 'all projects' : runs[runs.length - 1]!.project!;
  const lin = lineage(runs);
  if (a.report) {
    process.stdout.write(report(runs, lin, scope) + '\n');
    return 0;
  }
  for (const r of keep ? runs.slice(0, Math.max(0, runs.length - keep)) : runs) r.events = []; // lineage-only runs stay light
  const data: DishData = { generated: localIso(), scope, runs, lineage: lin };
  if (a.json) {
    process.stdout.write(JSON.stringify(data));
    return 0;
  }
  let html;
  try {
    if (bundleIsStale()) process.stderr.write('petri: the renderer changed since the last build; run "bun run build" for the latest dish\n');
    html = renderDish(data);
  } catch (e) {
    if (e instanceof MissingBundle) {
      process.stderr.write(e.message + '\n');
      return 1;
    }
    throw e;
  }
  writeFileSync(a.out, html);
  process.stdout.write(report(runs, lin, scope) + `\n\ndish → ${a.out}\n`);
  if (!a['no-open']) openInBrowser(pathToFileURL(resolve(a.out)).href);
  return 0;
}

function localIso(): string {
  const d = new Date(), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openInBrowser(url: string): void {
  const [cmd, ...rest] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
  spawn(cmd!, [...rest, url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
