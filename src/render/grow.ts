/** Deterministic organism growth and display helpers. Pure: no DOM, so tests and the browser share it. */
import type { PetriEvent } from '../types.ts';

export const TAU = Math.PI * 2, GOLDEN = 2.399963229728653, R = 330, R0 = 24;

export type ColorKey = 'sense' | 'act' | 'run' | 'spawn' | 'bud' | 'talk' | 'meta' | 'error' | 'prompt' | 'nucleus';
export const C: Record<ColorKey, [number, number, number]> = {
  sense: [62, 230, 255], act: [255, 91, 214], run: [255, 179, 71], spawn: [168, 107, 255], bud: [168, 107, 255],
  talk: [200, 255, 212], meta: [141, 162, 192], error: [255, 61, 90], prompt: [255, 255, 255], nucleus: [225, 247, 255],
};
export const LABEL = { sense: 'sense', act: 'act', run: 'run', spawn: 'spawn', talk: 'talk', meta: 'meta' } as const;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function lerpAngle(a: number, b: number, w: number): number {
  const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * w;
}

/** Roughly the tokens a step moved: its result plus what the model wrote. */
const weight = (ev: PetriEvent) => (ev.res || 0) / 4 + (ev.out || 0);
export const stepOf = (ev: PetriEvent) => clamp(7 + 2.6 * Math.log2(1 + weight(ev) / 500), 7, 20);
export const radiusOf = (ev: PetriEvent) =>
  ev.k === 'talk' ? 5 : ev.k === 'spawn' ? 4.5 : clamp(2.2 + 1.3 * Math.log2(1 + weight(ev) / 300), 2.2, 7.5) + (ev.err ? 0.8 : 0);

export interface GrowNode {
  x: number;
  y: number;
  r: number;
  k: string;
  /** Parent node index, -1 for the nucleus. */
  p: number;
  /** Event index, -1 for the nucleus. */
  i: number;
  depth: number;
  epoch: number;
  lobe: number;
  h?: number;
  ev?: PetriEvent | null;
  err?: boolean;
}

export interface Geometry {
  nodes: GrowNode[];
  /** Node indices along each prompt's main tendril. */
  chains: number[][];
  /** Event indices of compactions. */
  molts: number[];
  byEvent: Map<number, number[]>;
}

/**
 * Grow the organism for a run. Every prompt sprouts a tendril from the nucleus, every call adds a node,
 * parallel calls fan from one joint, errors kink the path, and tendrils curl back before the dish wall.
 * Seeded by the run id, so a run always grows the same shape.
 */
export function grow(run: { id: string; events?: PetriEvent[] }): Geometry {
  const evs = run.events || [], rnd = mulberry32(hash(run.id));
  const nodes: GrowNode[] = [{ x: 0, y: 0, r: 0, k: 'nucleus', p: -1, i: -1, depth: 0, epoch: 0, lobe: -1 }];
  const chains: number[][] = [], molts: number[] = [];
  const lens: number[] = [];
  let L = 0;
  for (const ev of evs) {
    if (ev.k === 'prompt') { lens.push(L); L = 0; } else if (ev.k !== 'molt' && !ev.par) L += stepOf(ev);
  }
  lens.push(L);
  const scale = clamp(R * 2.4 / Math.max(1, ...lens), 0.28, 1.5);
  const a0 = rnd() * TAU;
  let li = -1, heading = 0, curl = 0, x = 0, y = 0, cursor = 0, epoch = 0, lastG: number | undefined = -1;
  let chain: number[] = [];
  const newLobe = (ev: PetriEvent | null, i: number) => {
    li++;
    heading = a0 + li * GOLDEN + (rnd() - 0.5) * 0.5;
    curl = (li % 2 ? -1 : 1) * (0.03 + rnd() * 0.04);
    x = Math.cos(heading) * R0; y = Math.sin(heading) * R0;
    nodes.push({ x, y, r: 2, k: 'prompt', ev, i, p: 0, lobe: li, depth: 0, epoch, h: heading });
    cursor = nodes.length - 1; chain = [cursor]; chains.push(chain);
  };
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]!;
    if (ev.k === 'molt') { epoch++; molts.push(i); continue; }
    if (ev.k === 'prompt') { newLobe(ev, i); continue; }
    if (li < 0) newLobe(null, i);
    const par = !!ev.par && ev.g === lastG && nodes[cursor]!.p > 0;
    let parent: number, px: number, py: number, ph: number;
    if (par) {
      parent = nodes[cursor]!.p; px = nodes[parent]!.x; py = nodes[parent]!.y;
      ph = nodes[cursor]!.h! + (rnd() < 0.5 ? -1 : 1) * (0.55 + rnd() * 0.6);
    } else {
      parent = cursor; px = x; py = y; ph = heading;
    }
    let h = ph + curl + (rnd() - 0.5) * 0.3;
    const d = Math.hypot(px, py) / R;
    if (d > 0.55) { // steer along the wall instead of through it
      const toC = Math.atan2(-py, -px), tgt = toC + Math.sign(curl) * (Math.PI / 2 - 0.6), w = clamp((d - 0.55) / 0.4, 0, 1);
      h = lerpAngle(h, tgt, w * w * 0.75);
    }
    const len = stepOf(ev) * scale * (par ? 0.8 : 1);
    const n: GrowNode = { x: px + Math.cos(h) * len, y: py + Math.sin(h) * len, h, r: radiusOf(ev) * Math.sqrt(scale), k: ev.k, ev, i, p: parent, lobe: li, depth: nodes[parent]!.depth + 1, epoch };
    nodes.push(n);
    const ni = nodes.length - 1;
    if (!par) { x = n.x; y = n.y; heading = h + (ev.err ? (rnd() - 0.5) * 1.3 : 0); cursor = ni; chain.push(ni); }
    if (ev.tool) lastG = ev.g;
    if (ev.k === 'spawn' && ev.sub && ev.sub.calls) { // delegated work buds off as a tight curl
      const m = clamp(Math.round(Math.sqrt(ev.sub.calls) * 2), 3, 14);
      const every = ev.sub.errors ? Math.max(1, Math.round(ev.sub.calls / ev.sub.errors)) : 0;
      let bh = h + (li % 2 ? 1 : -1) * Math.PI / 2, bx = n.x, by = n.y, bp = ni;
      for (let b = 0; b < m; b++) {
        bh += 0.5; bx += Math.cos(bh) * 4.2 * Math.sqrt(scale); by += Math.sin(bh) * 4.2 * Math.sqrt(scale);
        nodes.push({ x: bx, y: by, h: bh, r: 1.5 * Math.sqrt(scale), k: 'bud', err: every > 0 && (b + 1) % every === 0, i, p: bp, lobe: li, depth: n.depth + 1 + b, epoch });
        bp = nodes.length - 1;
      }
    }
  }
  const byEvent = new Map<number, number[]>();
  nodes.forEach((n, idx) => {
    if (n.i < 0) return;
    const list = byEvent.get(n.i);
    if (list) list.push(idx); else byEvent.set(n.i, [idx]);
  });
  return { nodes, chains, molts, byEvent };
}

export const colorOf = (n: GrowNode): ColorKey => (n.err || n.ev?.err ? 'error' : n.k as ColorKey);

/** Compact token counts for the dish: 999, 2k, 2.5M. */
export const fmtK = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));

/** Seconds as m:ss or h:mm:ss. */
export const fmtT = (s: number | null | undefined) => {
  const v = Math.max(0, Math.round(s || 0));
  const h = Math.floor(v / 3600), m = Math.floor(v % 3600 / 60), ss = v % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ESC[c]!);
