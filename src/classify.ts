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

/**
 * MCP tools (mcp__<server>__<tool>) by the built-in tool they act like, matched on the part after the server.
 * Names are compared lowercased without "_" and "-", so read_file, readFile and read-file are one entry.
 * To support another harness, add its tool names to the right line. Anything not listed stays meta,
 * unless its input has the shape of an edit, a shell command or a search (see byShape).
 */
const MCP_NAMES: Readonly<Record<string, readonly string[]>> = {
  Read: ['read', 'read_file', 'read_text_file', 'read_multiple_files'],
  Grep: ['grep', 'search_files', 'search_code', 'ripgrep'],
  Glob: ['glob', 'find_files', 'list_files', 'list_directory', 'directory_tree', 'ls'],
  Edit: ['edit', 'edit_file', 'str_replace', 'edit_block', 'replace'],
  MultiEdit: ['multi_edit', 'multiedit'],
  Write: ['write', 'write_file', 'create_file'],
  Bash: ['shell', 'bash', 'execute', 'exec', 'execute_command', 'run_command', 'run_shell_command', 'terminal'],
  WebFetch: ['webfetch', 'web_fetch', 'fetch', 'fetch_url'],
  WebSearch: ['websearch', 'web_search', 'search_web'],
  Agent: ['subagent', 'task', 'agent', 'spawn_agent'],
  AskUserQuestion: ['question', 'ask', 'ask_user', 'ask_user_question'],
};
const squash = (s: string) => s.toLowerCase().replace(/[-_]/g, '');
const MCP_TOOL = new Map(Object.entries(MCP_NAMES).flatMap(([as, names]) => names.map(n => [squash(n), as] as const)));

/** Input field spellings that mean the same thing, mapped to the built-in tool's name for it. */
const FILE_KEYS = ['file_path', 'path', 'filePath', 'filepath', 'file', 'notebook_path'];
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  old_string: ['oldString', 'old_str', 'old_text', 'oldText'],
  new_string: ['newString', 'new_str', 'new_text', 'newText'],
  replace_all: ['replaceAll'],
  command: ['cmd'],
};
const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const str = (i: Record<string, unknown>, k: string) => typeof i[k] === 'string' && i[k] !== '';

/** The built-in a tool looks like from its input alone: an edit, a shell command or a search. */
function byShape(i: Record<string, unknown>): string | undefined {
  if (FILE_KEYS.some(k => str(i, k)) && ['old_string', ...ALIASES.old_string!].some(k => str(i, k))) return 'Edit';
  if (['command', ...ALIASES.command!].some(k => str(i, k))) return 'Bash';
  if (str(i, 'pattern')) return 'Grep';
  return undefined;
}

/** The input renamed to the built-in's field names, so every check reads one spelling. */
function asBuiltInInput(as: string, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const [name, alts] of Object.entries(ALIASES)) {
    for (const a of alts) {
      if (a in out) {
        out[name] ??= out[a];
        delete out[a];
      }
    }
  }
  if (FILE_TOOLS.has(as) && !str(out, 'file_path')) {
    const k = FILE_KEYS.find(k => str(out, k));
    if (k) {
      out.file_path = out[k];
      delete out[k];
    }
  }
  return out;
}

export interface Call {
  kind: Kind;
  /** The built-in tool an MCP tool acts as; unset for built-ins and unrecognised tools. */
  as?: string;
  /** The input with the built-in's field names. */
  input: Record<string, unknown>;
}

/** What a tool call does. Built-ins by name; MCP tools by MCP_NAMES, then by the shape of their input. */
export function classifyCall(tool: string, input: Record<string, unknown>): Call {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!m) return { kind: kindOf(tool, input), input };
  const as = MCP_TOOL.get(squash(m[2]!)) ?? byShape(input);
  if (!as) return { kind: 'meta', input };
  const inp = asBuiltInInput(as, input);
  if (as === 'Bash' && !str(inp, 'command')) return { kind: 'run', input: inp }; // runs code, not a shell line
  return { kind: kindOf(as, inp), as, input: inp };
}

/** The built-in name an event's checks use: its MCP mapping, or the tool itself. */
export const baseTool = (e: { tool?: string; as?: string }): string | undefined => e.as ?? e.tool;

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

const OPEN_TAG = /\s*<([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/y;

/**
 * A user line without the XML-like blocks a harness puts in front of it (<system-reminder>…</system-reminder>,
 * <shell id="…">…</shell>, <skill_content>…</skill_content>). Only complete blocks at the very start go, so a
 * prompt that is nothing but such blocks becomes empty, and text the person typed after them is kept.
 */
export function stripWrappers(text: string): string {
  let i = 0;
  for (;;) {
    OPEN_TAG.lastIndex = i;
    const m = OPEN_TAG.exec(text);
    if (!m) break;
    if (m[2]) { i = OPEN_TAG.lastIndex; continue; }
    const close = text.indexOf(`</${m[1]}>`, OPEN_TAG.lastIndex);
    if (close < 0) break; // an unclosed tag is text, not a wrapper
    i = close + m[1]!.length + 3;
  }
  return text.slice(i).trim();
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
