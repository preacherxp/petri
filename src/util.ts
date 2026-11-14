/** Small text and number helpers. Rounding and slicing match Python, which Petri's scores were defined in. */

/** Round half to even on the exact binary value, like Python's round(x, nd). */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const wide = Math.abs(x).toFixed(Math.min(100, nd + 30));
  const dot = wide.indexOf('.');
  const tail = wide.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {
    const kept = Number(nd ? wide.slice(0, dot + 1 + nd) : wide.slice(0, dot));
    const lastDigit = Number((nd ? wide.slice(dot + nd, dot + 1 + nd) : wide.slice(dot - 1, dot)));
    const unit = 10 ** -nd;
    const mag = lastDigit % 2 === 0 ? kept : kept + unit;
    return Math.sign(x) * Number(mag.toFixed(nd)) || 0;
  }
  return Number(x.toFixed(nd)) || 0;
}

/** Python's "{:.0f}" and similar fixed formats. */
export function pyFixed(x: number, nd = 0): string {
  return pyRound(x, nd).toFixed(nd);
}

/** A float the way Python prints it: integral values keep ".0". */
export function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** First n code points, like Python's s[:n]. */
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = '', i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

/** Length in code points, like Python's len(s). */
export function pyLen(s: string): number {
  let surrogates = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) surrogates++;
  }
  return s.length - surrogates;
}

/** Collapse whitespace runs to single spaces and trim, like " ".join(s.split()). */
export function collapse(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/** JSON with sorted keys at every level; used to compare tool inputs. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** JSON the way Python's json.dumps prints it: ", " and ": " separators, non-ASCII escaped. */
export function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyJson(k)}: ${pyJson(x)}`).join(', ')}}`;
  }
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return JSON.stringify(v) ?? 'null';
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
