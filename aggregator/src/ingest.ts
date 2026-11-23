// Raw store: JSON lines under <raw>/YYYY/MM/DD.jsonl by UTC date of collectedAtIso. Deduped by id, schema-checked.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { RawSample } from '../../shared/types/sample.ts';
import { sortSamples, utcDate } from './common.ts';
import { dedupeById } from './rollup.ts';
import { privacyScanError } from './privacy.ts';
import { sampleSchemaError } from './validate.ts';

export const MAX_SAMPLE_BYTES = 2048; // SPEC 3.2 hard limit, measured on the compact JSON that the store keeps

export interface ParseResult {
  accepted: RawSample[];
  // One entry per rejected sample. Reasons never carry sample content (V8 parse errors quote the source, so they are dropped).
  quarantined: Array<{ where: string; reason: string }>;
}

// Why one parsed value cannot enter the store, or null when it can.
export function rejectReason(value: unknown): string | null {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SAMPLE_BYTES) return `larger than ${MAX_SAMPLE_BYTES} bytes`;
  const schema = sampleSchemaError(value);
  if (schema !== null) return `schema: ${schema}`;
  return privacyScanError(value);
}

// Accepts one JSON document (a collector's sample.json, compact or pretty) or JSON lines.
export function parseIncoming(text: string, source = 'input'): ParseResult {
  let values: Array<{ where: string; value: unknown; malformed?: true }> | null = null;
  try {
    const whole: unknown = JSON.parse(text);
    if (whole !== null && typeof whole === 'object' && !Array.isArray(whole)) values = [{ where: source, value: whole }];
  } catch {
    // not one document; read as JSON lines
  }
  if (values === null) {
    values = [];
    text.split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      const where = `${source}:${i + 1}`;
      try {
        values!.push({ where, value: JSON.parse(line) });
      } catch {
        values!.push({ where, value: null, malformed: true });
      }
    });
  }
  const accepted: RawSample[] = [];
  const quarantined: ParseResult['quarantined'] = [];
  for (const { where, value, malformed } of values) {
    const reason = malformed ? 'not valid JSON' : rejectReason(value);
    if (reason === null) accepted.push(value as RawSample);
    else quarantined.push({ where, reason });
  }
  return { accepted, quarantined };
}

function pathFor(rawDir: string, date: string): string {
  const [y, m, d] = date.split('-');
  return join(rawDir, y, m, `${d}.jsonl`);
}

// Strict like loadRaw: a bad stored row stops the write instead of being dropped when the day file is rewritten.
function readDay(file: string): RawSample[] {
  if (!existsSync(file)) return [];
  const { accepted, quarantined } = parseIncoming(readFileSync(file, 'utf8'), file);
  if (quarantined.length > 0) throw new Error(`${quarantined[0].where} ${quarantined[0].reason}`);
  return accepted;
}

// Adds new samples to the store. Existing ids are kept as they are.
export function writeRaw(rawDir: string, incoming: RawSample[]): { added: number; duplicates: number } {
  const byDate = new Map<string, RawSample[]>();
  for (const s of dedupeById(incoming)) {
    const d = utcDate(s.collectedAtIso);
    const g = byDate.get(d);
    if (g) g.push(s);
    else byDate.set(d, [s]);
  }
  let added = 0;
  let duplicates = incoming.length;
  for (const [date, batch] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const file = pathFor(rawDir, date);
    const existing = readDay(file);
    const have = new Set(existing.map((s) => s.id));
    const fresh = batch.filter((s) => !have.has(s.id));
    duplicates -= fresh.length;
    if (fresh.length === 0) continue;
    added += fresh.length;
    mkdirSync(dirname(file), { recursive: true });
    const merged = sortSamples([...existing, ...fresh]);
    writeFileSync(file, merged.map((s) => JSON.stringify(s) + '\n').join(''), 'utf8');
  }
  return { added, duplicates: Math.max(0, duplicates) };
}

// Reads every day file. Throws on a sample that fails the schema, since the store must hold only valid rows.
export function loadRaw(rawDir: string): RawSample[] {
  if (!existsSync(rawDir)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(rawDir);
  const out: RawSample[] = [];
  for (const f of files) {
    const rel = relative(rawDir, f).split(sep).join('/');
    if (!/^\d{4}\/\d{2}\/\d{2}\.jsonl$/.test(rel)) throw new Error(`unexpected file in raw store: ${rel}`);
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const value: unknown = JSON.parse(line);
      const reason = sampleSchemaError(value);
      if (reason !== null) throw new Error(`${rel}:${i + 1} ${reason}`);
      out.push(value as RawSample);
    });
  }
  return dedupeById(out);
}
