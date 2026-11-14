import type { Lineage, ScoredRun } from './types.ts';
import { cut, median, pyFixed, pyFloat } from './util.ts';

export function lineage(runs: ScoredRun[]): Lineage {
  const fit = runs.map(r => r.fitness);
  const scored = runs.filter(r => r.stats.calls >= 20).map(r => r.fitness);
  const last5 = fit.slice(-5), prev5 = fit.slice(-10, -5);
  const tc = new Map<string, number>();
  for (const r of runs) for (const t of r.traits) tc.set(t, (tc.get(t) ?? 0) + 1);
  return {
    n: runs.length,
    fitness: fit,
    median: fit.length ? median(fit) : 0,
    best: scored.length ? Math.max(...scored) : fit.length ? Math.max(...fit) : 0,
    last5,
    trend: prev5.length ? median(last5) - median(prev5) : null,
    traits: Object.fromEntries([...tc.entries()].sort((a, b) => b[1] - a[1])),
    calls: runs.reduce((a, r) => a + r.stats.calls, 0),
    errors: runs.reduce((a, r) => a + r.stats.errors, 0),
  };
}

export function fmtK(n: number): string {
  return n >= 1000 ? `${pyFixed(n / 1000)}k` : String(n);
}

export function fmtTime(t: number | null | undefined): string {
  if (!t) return '?';
  const d = new Date(t * 1000), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Whether the last run beats every earlier run of at least 20 actions. Tiny runs can't be best. */
export function isNewBest(runs: ScoredRun[]): boolean {
  const r = runs[runs.length - 1];
  if (!r || runs.length < 2 || r.stats.calls < 20) return false;
  const prior = runs.slice(0, -1).filter(x => x.stats.calls >= 20).map(x => x.fitness);
  return r.fitness > (prior.length ? Math.max(...prior) : -1);
}

/** The text report agents read through /petri: the latest run, its damage, hints, and the lineage. */
export function report(runs: ScoredRun[], lin: Lineage, scope: string): string {
  const r = runs[runs.length - 1]!, st = r.stats, tk = r.tokens;
  const cpt = st.turns ? pyFloat(st.calls_per_turn) : '0';
  const lines = [
    `PETRI · ${scope} · ${lin.n} runs · median fitness ${pyFixed(lin.median)} · best ${lin.best}`,
    `run ${lin.n}/${lin.n}  ${r.short}  ${fmtTime(r.started)}  ${r.model || '?'}  ${Math.floor(r.duration_s / 60)}m`,
    `  ${cut(r.title, 100)}`,
    `  FITNESS ${r.fitness}` + (isNewBest(runs) ? '  ★ NEW BEST' : ''),
    `  prompts ${st.prompts} · turns ${st.turns} · calls ${st.calls} (${cpt}/turn) · errors ${st.errors} · agents ${st.agents} · compactions ${st.compactions}`,
    `  tokens out ${fmtK(tk.out)} (thinking ${pyFixed(st.think_ratio * 100)}%) · cache hit ${pyFixed(st.cache_ratio * 100)}% · peak context ${fmtK(st.peak_ctx)}`,
    `  damage ${pyFloat(r.damage_rate)}/100 actions: ` + (r.damage.map(l => `${l.kind} ×${l.n} −${l.dmg}`).join(' · ') || 'none'),
    `  traits: ${r.traits.join(' · ') || '—'}`,
  ];
  if (r.hints.length) {
    lines.push('  mutations for next run:');
    for (const h of r.hints) lines.push(`    - ${h}`);
  }
  if (lin.n > 1) {
    const trend = lin.trend !== null ? `, ${lin.trend >= 0 ? '+' : ''}${pyFixed(lin.trend)} vs previous 5` : '';
    const traits = Object.entries(lin.traits).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ');
    lines.push(`lineage: last ${lin.last5.length} fitness ${lin.last5.join(' ')}${trend} · traits ${traits}`);
  }
  return lines.join('\n');
}
