import type { Kind } from './types.ts';
import { collapse, cut, isRecord, pyJson, pyLen } from './util.ts';

/** Characters of tool result that count as an oversized ("fat") sample. */
export const FAT = 10_000;
export const DMG = { error: 3, reread: 2, fat: 1, retry: 2, molt: 5, thrash: 5 } as const;

export const KIND: Readonly<Record<string, Kind>> = {
  Read: 'sense', Glob: 'sense', Grep: 'sense', LSP: 'sense', WebFetch: 'sense',
  WebSearch: 'sense', ToolSearch: 'sense', ListAgents: 'sense', NotebookRead: 'sense',
  Edit: 'act', Write: 'act', MultiEdit: 'act', NotebookEdit: 'act',
  Agent: 'spawn', Task: 'spawn', SendMessage: 'spawn', TaskStop: 'spawn',
  AskUserQuestion: 'talk',
};
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const WEB_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

const SENSE_CMD = /^(cat|ls|head|tail|grep|rg|find|fd|wc|stat|file|du|tree|jq|which|type|pwd|echo|printf|diff|less|more|sed -n|awk|git (status|log|diff|show|branch|blame|ls-files|rev-parse|remote))\b/;
const ACT_CMD = /(sed -i|\btee\b|(?<![=-])>>?\s*[\w/.~$"']|\bmv\b|\bcp\b|\bmkdir\b|\brm\b|\btouch\b|\bchmod\b|\bln\b|git (add|commit|checkout|switch|push|pull|merge|rebase|stash|reset|init|clone)\b|(npm|bun) (install|i|add)\b|pip3? install|brew install)/;
const QUOTED = /'[^']*'|"[^"]*"/g;
const REDIRECT_NOISE = /\d?>&\d|\d?>\s*\/dev\/null/g;
const LEADING_CD = /^\s*cd\s+\S+\s*(;|&&)\s*/;

/**
 * Classify a shell command by what it does to the world.
 * Heuristic ceiling: a heredoc'd script that writes files still reads as "run".
 */
export function bashKind(cmd: string): Kind {
  const first = (cmd.trim().split('\n')[0] ?? '').replace(LEADING_CD, '');
  const bare = cmd.replace(QUOTED, "''").replace(REDIRECT_NOISE, ''); // '>' inside quotes or in => / -> is not a write
  if (ACT_CMD.test(bare)) return 'act';
  if (SENSE_CMD.test(first)) return 'sense';
  return 'run';
}

export function kindOf(tool: string, input: Record<string, unknown>): Kind {
  if (Object.hasOwn(KIND, tool)) return KIND[tool]!; // own keys only: a tool named "constructor" is not a kind
  return tool === 'Bash' ? bashKind(String(input.command ?? '')) : 'meta';
}

export function shortPath(p: string, cwd: string | null | undefined): string {
  if (cwd) {
    const root = cwd.replace(/\/+$/, '');
    if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  }
  return (p.match(/\//g)?.length ?? 0) > 2 ? p.split('/').slice(-2).join('/') : p;
}

const NAMED_FIELDS = ['pattern', 'description', 'url', 'query', 'skill', 'prompt'] as const;

/** One-line description of a tool call, for hints and hover. */
export function summarize(tool: string, input: unknown, cwd: string | null | undefined): string {
  if (!isRecord(input)) return cut(String(input), 90);
  if ('file_path' in input) return shortPath(String(input.file_path), cwd);
  if ('notebook_path' in input) return shortPath(String(input.notebook_path), cwd);
  if (tool === 'Bash') return cut(collapse(String(input.command ?? '')).replace(LEADING_CD, ''), 90);
  for (const k of NAMED_FIELDS) if (k in input) return cut(String(input[k]), 90);
  if (tool === 'AskUserQuestion') {
    const qs = Array.isArray(input.questions) && input.questions.length ? input.questions : [{}];
    const q = isRecord(qs[0]) ? qs[0].question : undefined;
    return cut(String(q ?? ''), 90);
  }
  return cut(pyJson(input), 90);
}

/** Text content of a message or tool result: a plain string, or the text blocks of a block list. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => isRecord(b) && b.type === 'text').map(b => String((b as Record<string, unknown>).text ?? '')).join('\n');
}

/** Size of a tool result in characters (code points). Non-text blocks count as zero. */
export function resultSize(content: unknown): number {
  if (typeof content === 'string') return pyLen(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((a: number, b) => a + (isRecord(b) ? pyLen(String(b.text ?? '')) : 0), 0);
}

/** ISO timestamp to epoch seconds, or null. */
export function ts(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}
