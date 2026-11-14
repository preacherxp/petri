import { readFileSync } from 'node:fs';

/**
 * Parsed JSON objects from a JSONL file. Lines that don't start with "{" or don't parse are skipped,
 * and invalid UTF-8 becomes U+FFFD, so one damaged line never loses a session.
 */
export function* iterJson(path: string): Generator<Record<string, unknown>> {
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.startsWith('{')) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d && typeof d === 'object' && !Array.isArray(d)) yield d as Record<string, unknown>;
  }
}
