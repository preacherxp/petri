/** The dish in the browser: replay, hover, panel and lineage strip. Bundled into dist/app.js. */
import type { DishData, PetriEvent, ScoredRun } from '../types.ts';
import { C, clamp, colorOf, esc, fmtK, fmtT, grow, LABEL, mulberry32, R, TAU } from './grow.ts';
import type { ColorKey, Geometry, GrowNode } from './grow.ts';

declare global {
  interface Window { PETRI_DATA: DishData }
}

const DATA = window.PETRI_DATA;

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d context');
  return g;
}

// ---------- drawing primitives ----------
const sprites: Partial<Record<ColorKey, HTMLCanvasElement>> = {};
function sprite(key: ColorKey): HTMLCanvasElement {
  const have = sprites[key];
  if (have) return have;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = ctx2d(c), [r, gg, b] = C[key], grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`); grad.addColorStop(0.16, `rgba(${r},${gg},${b},.95)`);
  grad.addColorStop(0.38, `rgba(${r},${gg},${b},.28)`); grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return (sprites[key] = c);
}
function dot(c: CanvasRenderingContext2D, x: number, y: number, r: number, key: ColorKey, alpha: number) {
  const d = r * 4.4;
  c.globalAlpha = alpha; c.drawImage(sprite(key), x - d / 2, y - d / 2, d, d); c.globalAlpha = 1;
}
function seg(c: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, rgb: string, alpha: number, w: number, j: number) {
  const dx = bx - ax, dy = by - ay, k = (((j * 7919) % 13) / 13 - 0.5) * 0.5;
  c.beginPath(); c.moveTo(ax, ay); c.quadraticCurveTo((ax + bx) / 2 - dy * k, (ay + by) / 2 + dx * k, bx, by);
  for (const [mw, ma] of [[5, 0.05], [2.2, 0.16], [0.9, 0.8]] as const) { c.lineWidth = w * mw; c.strokeStyle = `rgba(${rgb},${ma * alpha})`; c.stroke(); }
}

// ---------- state ----------
const stage = $('#stage'), cv = $<HTMLCanvasElement>('#dish'), ctx = ctx2d(cv);
const cache = document.createElement('canvas'), cctx = ctx2d(cache);
let W = 0, H = 0, cx = 0, cy = 0, zoom = 1, nEv = 0;
let run: ScoredRun, geo: Geometry;
const S = {
  idx: DATA.runs.length - 1, progress: 0, playing: true, duration: 8, reveal: new Map<number, number>(), revealed: 0,
  hover: -1, last: performance.now(), cUpto: 0, cEpoch: 0, cNode: 1, cValid: false,
};
const sx = (n: { x: number }) => cx + n.x * zoom, sy = (n: { y: number }) => cy + n.y * zoom;

function drawNode(c: CanvasRenderingContext2D, n: GrowNode, alpha: number) {
  const key = colorOf(n), rgb = C[key].join(','), x = sx(n), y = sy(n);
  if (n.p >= 0) {
    const p = geo.nodes[n.p]!, bud = n.k === 'bud' ? 0.6 : 1;
    seg(c, sx(p), sy(p), x, y, n.k === 'prompt' ? '255,255,255' : rgb, alpha * bud * (n.k === 'prompt' ? 0.45 : 1), bud * zoom * 0.9, n.i + n.depth);
  }
  if (n.k === 'prompt') { dot(c, x, y, n.r * zoom, 'prompt', alpha * 0.9); return; }
  dot(c, x, y, n.r * zoom, key, alpha);
  if (n.ev?.err) { c.beginPath(); c.arc(x, y, (n.r + 2.6) * zoom, 0, TAU); c.lineWidth = 0.8 * zoom; c.strokeStyle = `rgba(${C.error},${0.65 * alpha})`; c.stroke(); }
}
/** Growth is drawn once into a cache canvas; a compaction redraws so older growth fades to shed skin. */
function fillCache(upto: number) {
  const epochNow = geo.molts.filter(i => i < upto).length;
  if (!S.cValid || upto < S.cUpto || epochNow !== S.cEpoch) {
    cctx.save(); cctx.setTransform(1, 0, 0, 1, 0, 0); cctx.clearRect(0, 0, cache.width, cache.height); cctx.restore();
    S.cNode = 1; S.cEpoch = epochNow; S.cValid = true;
  }
  cctx.globalCompositeOperation = 'lighter';
  const nodes = geo.nodes;
  let k = S.cNode;
  while (k < nodes.length && nodes[k]!.i < upto) { const n = nodes[k]!; drawNode(cctx, n, Math.max(0.14, Math.pow(0.38, epochNow - n.epoch))); k++; }
  S.cNode = k; S.cUpto = upto;
}
const motes = Array.from({ length: 70 }, (_, i) => {
  const r = mulberry32(i * 977);
  return { a: r() * TAU, d: Math.sqrt(r()) * 0.96, s: 0.6 + r() * 1.2, v: (r() - 0.5) * 0.02, ph: r() * TAU };
});
function drawMotes(t: number) {
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    const a = m.a + t * m.v, d = m.d + 0.015 * Math.sin(t * 0.3 + m.ph);
    dot(ctx, cx + Math.cos(a) * d * R * zoom, cy + Math.sin(a) * d * R * zoom, m.s * zoom, 'meta', 0.18 + 0.12 * Math.sin(t * 0.8 + m.ph));
  }
  ctx.globalCompositeOperation = 'source-over';
}
function drawDish() {
  const r = R * zoom, g = ctx.createRadialGradient(cx, cy - r * 0.15, r * 0.1, cx, cy, r);
  g.addColorStop(0, 'rgba(22,42,78,.38)'); g.addColorStop(0.75, 'rgba(10,18,36,.18)'); g.addColorStop(1, 'rgba(4,6,13,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(150,190,240,.11)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.025, 0, TAU); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(150,190,240,.04)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, -2.5, -1.3); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(200,230,255,.13)'; ctx.stroke();
}
const fitColor = (f: number) => `hsl(${Math.round(f * 1.4)},90%,62%)`;
function drawNucleus(t: number, upto: number) {
  const pulse = 1 + 0.08 * Math.sin(t * 2.2);
  dot(ctx, cx, cy, 11 * zoom * pulse, 'nucleus', 0.95);
  dot(ctx, cx, cy, 5 * zoom, 'prompt', 0.9);
  const f = run.fitness / 100, rr = 18 * zoom;
  ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.lineWidth = 1.5 * zoom; ctx.strokeStyle = 'rgba(160,190,230,.14)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + TAU * f); ctx.lineWidth = 2.2 * zoom; ctx.strokeStyle = fitColor(run.fitness); ctx.stroke();
  if (upto < nEv) { ctx.beginPath(); ctx.arc(cx, cy, rr + 4 * zoom, -Math.PI / 2, -Math.PI / 2 + TAU * upto / nEv); ctx.lineWidth = 1 * zoom; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.stroke(); }
}
function drawFlashes(now: number) {
  for (const [i, t0] of S.reveal) {
    const k = 1 - (now - t0) / 700;
    if (k <= 0) { S.reveal.delete(i); continue; }
    for (const ni of geo.byEvent.get(i) || []) { const n = geo.nodes[ni]!; dot(ctx, sx(n), sy(n), (n.r + 1) * zoom * (1 + 2.2 * k), colorOf(n), k * 0.9); }
  }
}
/** When growth is complete, impulses travel along each tendril. */
function drawImpulses(t: number) {
  geo.chains.forEach((ch, ci) => {
    if (ch.length < 3) return;
    const pos = ((t * 0.055 + ci * 0.37) % 1) * (ch.length - 1);
    for (let k = 0; k < 4; k++) {
      const p = Math.max(0, pos - k * 0.6), a = Math.floor(p), f = p - a, A = geo.nodes[ch[a]!]!, B = geo.nodes[ch[Math.min(a + 1, ch.length - 1)]!]!;
      dot(ctx, cx + (A.x + (B.x - A.x) * f) * zoom, cy + (A.y + (B.y - A.y) * f) * zoom, (2.6 - k * 0.5) * zoom, k ? colorOf(B) : 'prompt', 0.85 - k * 0.2);
    }
  });
}
function drawHover() {
  if (S.hover < 0) return;
  const n = geo.nodes[S.hover]!;
  ctx.beginPath(); ctx.arc(sx(n), sy(n), (n.r + 5) * zoom, 0, TAU); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.stroke();
  dot(ctx, sx(n), sy(n), (n.r + 2) * zoom, colorOf(n), 0.8);
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - S.last) / 1000);
  S.last = now;
  if (S.playing && S.progress < nEv) S.progress = Math.min(nEv, S.progress + nEv / S.duration * dt);
  const upto = Math.floor(S.progress);
  for (let i = S.revealed; i < upto; i++) S.reveal.set(i, now);
  S.revealed = Math.max(S.revealed, upto);
  if (nEv) fillCache(upto);
  ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, W, H);
  drawDish();
  const t = now / 1000;
  drawMotes(t);
  const s = 1 + 0.006 * Math.sin(t * 0.9), rot = 0.004 * Math.sin(t * 0.5); // the culture breathes
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.rotate(rot); ctx.translate(-cx, -cy);
  if (nEv) ctx.drawImage(cache, 0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  drawNucleus(t, upto);
  if (nEv) { drawFlashes(now); if (upto >= nEv) drawImpulses(t); drawHover(); }
  ctx.restore();
  updateBar(upto);
  requestAnimationFrame(frame);
}

// ---------- bar / hud / panel ----------
const fmtDate = (t: number | null) => (t ? new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?');
let lastBar = -1;
function updateBar(upto: number) {
  if (upto === lastBar && !S.playing) return;
  lastBar = upto;
  const p = nEv ? S.progress / nEv : 0;
  $('#track .fill').style.width = p * 100 + '%'; $('#track .knob').style.left = p * 100 + '%';
  $('#play').textContent = S.playing && upto < nEv ? '❚❚' : '▶';
  let ctxTok = 0, tEl = 0;
  for (let i = upto - 1; i >= 0; i--) {
    const e = run.events[i]!;
    if (!tEl && e.t) tEl = e.t;
    if (e.ctx) { ctxTok = e.ctx; break; }
  }
  $('#clock').textContent = fmtT(tEl);
  $('#energy i').style.width = 100 * ctxTok / Math.max(1, run.stats.peak_ctx) + '%';
  $('#energy b').textContent = fmtK(ctxTok);
}
function isBest(i: number) {
  const r = DATA.runs[i]!;
  return r.stats.calls >= 20 && DATA.runs.slice(0, i).every(o => o.stats.calls < 20 || o.fitness < r.fitness) && i > 0;
}
const BAD_TRAITS = new Set(['Glutton', 'Scarred', 'Molted']);
function renderPanel() {
  const st = run.stats, tk = run.tokens, lin = DATA.lineage;
  const kinds = Object.entries(st.by_kind || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const fc = fitColor(run.fitness);
  $('#panel').innerHTML = `
    <section><div class="fit"><div class="n" style="color:${fc};text-shadow:0 0 22px ${fc}66">${run.fitness}</div><div class="l">FITNESS</div>${isBest(S.idx) ? '<div class="best">★ NEW BEST</div>' : ''}</div>
      <div class="fitbar"><i style="width:${run.fitness}%;background:${fc};box-shadow:0 0 10px ${fc}"></i></div>
      <div class="dmgrate">damage ${run.damage_rate} / 100 actions · lineage median ${Math.round(lin.median)} · best ${lin.best}</div></section>
    <section><h2>RUN</h2><div class="grid">
      <div><span>prompts</span><b>${st.prompts}</b></div><div><span>turns</span><b>${st.turns}</b></div>
      <div><span>tool calls</span><b>${st.calls}</b></div><div><span>per turn</span><b>${st.calls_per_turn}</b></div>
      <div><span>errors</span><b>${st.errors}</b></div><div><span>agents</span><b>${st.agents}</b></div>
      <div><span>out tokens</span><b>${fmtK(tk.out)}</b></div><div><span>thinking</span><b>${Math.round(st.think_ratio * 100)}%</b></div>
      <div><span>cache hit</span><b>${Math.round(st.cache_ratio * 100)}%</b></div><div><span>peak ctx</span><b>${fmtK(st.peak_ctx)}</b></div>
      <div><span>duration</span><b>${fmtT(run.duration_s)}</b></div><div><span>compactions</span><b>${st.compactions}</b></div>
    </div><div class="dimtxt" style="margin-top:6px">${esc(kinds)}</div></section>
    <section><h2>DAMAGE TAKEN</h2>${run.damage.length ? run.damage.map(l => `<div class="led"><span>${l.kind} ×${l.n}</span><b>−${l.dmg}</b></div>`).join('') : '<div class="dimtxt">none — flawless</div>'}</section>
    <section><h2>TRAITS</h2><div class="pills">${run.traits.length ? run.traits.map(t => `<span class="pill ${BAD_TRAITS.has(t) ? 'bad' : 'good'}">${esc(t)}</span>`).join('') : '<span class="dimtxt">none unlocked</span>'}</div></section>
    <section><h2>MUTATIONS FOR NEXT RUN</h2>${run.hints.length ? `<ul class="hints">${run.hints.map(h => `<li>${esc(h).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul>` : '<div class="dimtxt">nothing to fix. go again.</div>'}</section>
    <section id="spec"><h2>SPECIMEN</h2><div id="specbody"></div></section>`;
  showLegend();
  $('#sub').textContent = `RUN ${S.idx + 1} / ${DATA.runs.length} · ${fmtDate(run.started)} · ${run.model || '?'} · ${fmtT(run.duration_s)} · ${(run.cwd || run.project || '').split('/').pop()}`;
  $('#title').textContent = run.title || '(no prompt)';
  $('#empty').style.display = nEv ? 'none' : 'grid';
  $('#empty').textContent = nEv ? '' : 'no event detail embedded for this run — regenerate with --runs N';
}
function showLegend() {
  const keys = Object.keys(LABEL) as (keyof typeof LABEL)[];
  $('#specbody').innerHTML = `<div class="legend">${keys.map(k => `<span style="color:rgb(${C[k]})"><i></i><span style="color:var(--dim)">${LABEL[k]}</span></span>`).join('')}<span style="color:rgb(${C.error})"><i></i><span style="color:var(--dim)">scar</span></span></div>
    <div class="dimtxt" style="margin-top:10px">hover a node · space play/pause · ← → runs · drag the bar</div>`;
}
function showNode(n: GrowNode) {
  const ev: PetriEvent | null | undefined = n.ev;
  if (!ev) { showLegend(); return; }
  const rows: string[] = [];
  const row = (k: string, v: unknown, cls = '') => { if (v !== undefined && v !== null && v !== '') rows.push(`<div class="row"><span>${k}</span><b class="${cls}">${esc(v)}</b></div>`); };
  row('kind', n.k === 'bud' ? 'subagent work' : ev.k + (ev.tool ? ' · ' + ev.tool : '') + (ev.as ? ` (as ${ev.as})` : ''));
  row('what', ev.s);
  row('at', fmtT(ev.t));
  if (ev.tool) {
    row('result', ev.res != null ? fmtK(ev.res) + ' chars' : '—');
    if (ev.out) row('out tok', fmtK(ev.out));
    if (ev.ctx) row('context', fmtK(ev.ctx));
    if (ev.par) row('batched', 'parallel with previous call');
  }
  if (ev.k === 'talk' && ev.out) row('out tok', fmtK(ev.out));
  if (ev.sub) row('subagent', `${ev.sub.calls} calls · ${ev.sub.errors} errors · ${fmtK(ev.sub.out)} out tok${ev.sub.model ? ' · ' + ev.sub.model : ''}`);
  if (ev.flags?.length) row('flags', ev.flags.join(', '), 'err');
  if (ev.d) row('damage', '−' + ev.d, 'err');
  if (ev.e) row('error', ev.e, 'err');
  $('#specbody').innerHTML = rows.join('');
}

// ---------- lineage strip ----------
function thumb(r: ScoredRun): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = ctx2d(c);
  g.globalCompositeOperation = 'lighter';
  const gg = grow(r), z = 64 / (R + 20) * 2, ox = 64, oy = 64, al = clamp(900 / gg.nodes.length, 0.22, 0.9);
  for (let k = 1; k < gg.nodes.length; k++) {
    const n = gg.nodes[k]!, key = colorOf(n), rgb = C[key].join(','), x = ox + n.x * z, y = oy + n.y * z;
    if (n.p >= 0) {
      const p = gg.nodes[n.p]!;
      g.beginPath(); g.moveTo(ox + p.x * z, oy + p.y * z); g.lineTo(x, y);
      g.lineWidth = n.k === 'bud' ? 0.6 : 1;
      g.strokeStyle = `rgba(${n.k === 'prompt' ? '255,255,255' : rgb},${(n.k === 'prompt' ? 0.3 : 0.6) * al})`; g.stroke();
    }
    if (n.k !== 'prompt') dot(g, x, y, Math.max(1.2, n.r * z * 1.4), key, al);
  }
  dot(g, ox, oy, 9, 'nucleus', 0.9);
  return c;
}
function buildLineage() {
  const L = $('#lineage');
  DATA.runs.forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'thumb' + (i === S.idx ? ' cur' : '');
    d.title = `${r.short} · ${fmtDate(r.started)} · ${r.stats.calls} calls`;
    d.appendChild(thumb(r));
    d.insertAdjacentHTML('beforeend', `<div class="f" style="color:${fitColor(r.fitness)}">${r.fitness}</div><div class="d">${r.stats.calls}c</div>`);
    d.onclick = () => select(i);
    L.appendChild(d);
  });
}

// ---------- control ----------
function select(i: number, replay = true) {
  S.idx = clamp(i, 0, DATA.runs.length - 1); run = DATA.runs[S.idx]!; geo = grow(run); nEv = run.events.length;
  S.progress = replay ? 0 : nEv; S.revealed = S.progress; S.reveal.clear(); S.playing = replay; S.cValid = false; S.hover = -1; lastBar = -1;
  S.duration = clamp(nEv / 35, 5, 16);
  $('#track .ticks').innerHTML = run.events.map((e, k) => (e.k === 'prompt' || e.k === 'molt' ? `<div class="tick ${e.k}" style="left:${100 * k / nEv}%"></div>` : '')).join('');
  document.querySelectorAll('.thumb').forEach((t, k) => { t.classList.toggle('cur', k === S.idx); if (k === S.idx) t.scrollIntoView({ inline: 'center', block: 'nearest' }); });
  renderPanel();
}
function fit() {
  const dpr = devicePixelRatio || 1;
  W = stage.clientWidth; H = stage.clientHeight;
  cv.width = cache.width = W * dpr; cv.height = cache.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx = W / 2; cy = H / 2 + 6; zoom = Math.min(W, H) * 0.455 / R; S.cValid = false;
}
function togglePlay() {
  if (S.progress >= nEv) { S.progress = 0; S.revealed = 0; S.cValid = false; }
  S.playing = !S.playing;
}

window.addEventListener('resize', fit);
$('#play').onclick = togglePlay;
const track = $('#track');
let drag = false;
const scrub = (e: PointerEvent) => {
  const b = track.getBoundingClientRect();
  S.progress = clamp((e.clientX - b.left) / b.width, 0, 1) * nEv; S.revealed = Math.floor(S.progress); S.reveal.clear(); lastBar = -1;
};
track.onpointerdown = e => { drag = true; S.playing = false; scrub(e); track.setPointerCapture(e.pointerId); };
track.onpointermove = e => { if (drag) scrub(e); };
track.onpointerup = () => { drag = false; };
stage.onmousemove = e => {
  if (!geo) return;
  const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top, upto = Math.floor(S.progress);
  let best = -1, bd = 1e9;
  for (let k = 1; k < geo.nodes.length; k++) {
    const n = geo.nodes[k]!;
    if (n.i >= upto) break;
    const d = Math.hypot(sx(n) - mx, sy(n) - my);
    if (d < bd) { bd = d; best = k; }
  }
  const hit = best >= 0 && bd < Math.max(9, geo.nodes[best]!.r * zoom + 5) ? best : -1;
  if (hit !== S.hover) { S.hover = hit; if (hit >= 0) showNode(geo.nodes[hit]!); else showLegend(); }
};
stage.onmouseleave = () => { S.hover = -1; showLegend(); };
window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') select(S.idx - 1);
  else if (e.key === 'ArrowRight') select(S.idx + 1);
  else if (e.key === 'Home') select(0);
  else if (e.key === 'End') select(DATA.runs.length - 1);
});

const hp = new URLSearchParams(location.hash.slice(1)); // #run=12&end deep-links a run, fully grown
const want = Number(hp.get('run') || NaN);
if (hp.has('run') && Number.isInteger(want)) S.idx = clamp(want - 1, 0, DATA.runs.length - 1); // a bad number keeps the latest run
fit();
buildLineage();
select(S.idx, !hp.has('end'));
requestAnimationFrame(frame);
