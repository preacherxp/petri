/** Tool kinds, as colored in the organism. */
export type Kind = 'sense' | 'act' | 'run' | 'spawn' | 'talk' | 'meta';
export type EventKind = Kind | 'prompt' | 'molt';
export type Flag = 'reread' | 'fat' | 'retry' | 'thrash';

export interface SubStats {
  calls: number;
  errors: number;
  out: number;
  model?: string | null;
}

/** One step of a run. Field names are kept short because every event is embedded in the dish. */
export interface PetriEvent {
  k: EventKind;
  /** Seconds since the run started. */
  t: number | null;
  /** One-line summary: prompt text, command, file, or answer. */
  s?: string;
  tool?: string;
  /** The built-in tool an MCP tool acts as, such as Read for mcp__fs__read_file. */
  as?: string;
  /** Turn index: calls from one assistant message share it. */
  g?: number;
  /** 1 when an earlier call came from the same assistant message. */
  par?: number;
  /** Output tokens of the message, on its first block only. */
  out?: number;
  /** Context size when the message was produced, on its first block only. */
  ctx?: number;
  /** Result size in characters. */
  res?: number;
  err?: 1;
  /** Error text. */
  e?: string;
  flags?: Flag[];
  /** Damage this event dealt. */
  d?: number;
  sub?: SubStats;
  pre?: number | null;
  post?: number | null;
  trig?: string | null;
}

export interface Tokens {
  in: number;
  cache_read: number;
  cache_create: number;
  out: number;
  think: number;
}

export interface Stats {
  prompts: number;
  turns: number;
  calls: number;
  errors: number;
  rereads: number;
  fat: number;
  retries: number;
  thrash: number;
  compactions: number;
  agents: number;
  web: number;
  reads: number;
  edits: number;
  edit_errors: number;
  calls_per_turn: number;
  peak_ctx: number;
  cache_ratio: number;
  think_ratio: number;
  by_kind: Partial<Record<Kind, number>>;
}

export interface LedgerLine {
  kind: 'error' | 'reread' | 'fat' | 'retry' | 'thrash' | 'molt';
  n: number;
  dmg: number;
}

export interface Run {
  id: string;
  short: string;
  file: string;
  events: PetriEvent[];
  cwd: string | null;
  model: string | null;
  started: number | null;
  ended: number | null;
  duration_s: number;
  title: string;
  tokens: Tokens;
  stats: Stats;
  project?: string;
  damage?: LedgerLine[];
  damage_rate?: number;
  fitness?: number;
  traits?: string[];
  hints?: string[];
}

export type ScoredRun = Run & Required<Pick<Run, 'damage' | 'damage_rate' | 'fitness' | 'traits' | 'hints'>>;

export interface Lineage {
  n: number;
  fitness: number[];
  median: number;
  best: number;
  last5: number[];
  trend: number | null;
  traits: Record<string, number>;
  calls: number;
  errors: number;
}

export interface DishData {
  generated: string;
  scope: string;
  runs: ScoredRun[];
  lineage: Lineage;
}
