import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DishData } from './types.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = join(ROOT, 'src', 'render', 'dish.html');
const RENDER_SRC = join(ROOT, 'src', 'render');
export const APP_BUNDLE = join(ROOT, 'dist', 'app.js');

export class MissingBundle extends Error {}

/** True when a renderer source file changed after the last build. */
export function bundleIsStale(): boolean {
  if (!existsSync(APP_BUNDLE)) return true;
  const built = statSync(APP_BUNDLE).mtimeMs;
  return readdirSync(RENDER_SRC).some(f => f.endsWith('.ts') && statSync(join(RENDER_SRC, f)).mtimeMs > built);
}

/**
 * One self-contained HTML file: the template, the bundled renderer, and the data.
 * "</" is escaped in both inlined scripts so no transcript text can close the script tag.
 */
export function renderDish(data: DishData): string {
  if (!existsSync(APP_BUNDLE)) throw new MissingBundle(`renderer not built: run "bun run build" in ${ROOT}`);
  if (!existsSync(TEMPLATE)) throw new MissingBundle(`dish template missing: ${TEMPLATE} (restore it with git checkout)`);
  const payload = JSON.stringify(data).replaceAll('</', '<\\/');
  const app = readFileSync(APP_BUNDLE, 'utf8').replace(/<\/script/gi, '<\\/script');
  return readFileSync(TEMPLATE, 'utf8')
    .replace('/*__DATA__*/null', () => payload)
    .replace('/*__APP__*/', () => app);
}
