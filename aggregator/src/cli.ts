// Usage:
//   node aggregator/src/cli.ts ingest <sample.json|file.jsonl>... [--raw data/raw]
//   node aggregator/src/cli.ts rollup [--raw data/raw] [--out data/rollups]
//   node aggregator/src/cli.ts validate [--dir data/rollups]
// Writes into the repo's data/ only at data/raw (ingest) and data/rollups (rollup).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Manifest } from '../../shared/types/rollups.ts';
import type { RawSample } from '../../shared/types/sample.ts';
import { buildRollups, writeRollups } from './rollup.ts';
import { loadRaw, parseIncoming, writeRaw } from './ingest.ts';
import { rollupSchemaError, ROLLUP_FILES } from './validate.ts';
import type { Coord } from './regions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const DATA = join(REPO, 'data');
const DEFAULT_RAW = join(DATA, 'raw');
const DEFAULT_OUT = join(DATA, 'rollups');

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return resolve(v);
}

// Refuses any target under the repo's data/ other than the one the command is allowed to write.
function guardRepoData(target: string, allowed: string[]): void {
  const rel = relative(DATA, target);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) return;
  if (allowed.some((a) => resolve(a) === target)) return;
  throw new Error(`refusing to write under repo data/: ${target}`);
}

export function loadCoords(): Record<string, Coord> {
  return JSON.parse(readFileSync(join(HERE, '..', 'data', 'region-coords.json'), 'utf8')) as Record<string, Coord>;
}

// Quarantined samples are reported by file and reason only; they never reach the store.
function cmdIngest(args: string[]): void {
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--raw');
  if (files.length === 0) throw new Error('ingest needs at least one sample file');
  const raw = flag(args, '--raw', DEFAULT_RAW);
  guardRepoData(raw, [DEFAULT_RAW]);
  const accepted: RawSample[] = [];
  let quarantined = 0;
  for (const file of files.sort()) {
    const res = parseIncoming(readFileSync(resolve(file), 'utf8'), file);
    // D-004: the repo's data/raw holds only live measurements.
    for (const s of res.accepted) {
      if (raw === DEFAULT_RAW && s.src !== 'live') res.quarantined.push({ where: file, reason: `src ${s.src} is not allowed in data/raw` });
      else accepted.push(s);
    }
    for (const q of res.quarantined) console.log(`quarantined ${q.where}: ${q.reason}`);
    quarantined += res.quarantined.length;
  }
  const { added, duplicates } = writeRaw(raw, accepted);
  const slot = accepted.map((s) => s.timing.scheduledSlotIso ?? '').reduce((a, b) => (b > a ? b : a), '');
  console.log(`ingest: ${accepted.length} valid, ${added} added, ${duplicates} duplicates, ${quarantined} quarantined`);
  console.log(`result: added=${added} slot=${slot || 'unscheduled'}`);
}

function cmdRollup(args: string[]): void {
  const raw = flag(args, '--raw', DEFAULT_RAW);
  const out = flag(args, '--out', DEFAULT_OUT);
  guardRepoData(out, [DEFAULT_OUT]);
  const built = buildRollups(loadRaw(raw), loadCoords());
  const source = (built.values.manifest as Manifest).dataSource;
  if (out === DEFAULT_OUT && source === 'synthetic') throw new Error('refusing to write synthetic rollups to data/rollups (D-004)');
  writeRollups(out, built);
  const m = built.values.manifest as Manifest;
  console.log(`rollup: ${m.n.samples} samples, ${m.n.runs} runs, surveyDay ${m.surveyDay}, source ${m.dataSource} -> ${out}`);
}

function cmdValidate(args: string[]): void {
  const dir = flag(args, '--dir', DEFAULT_OUT);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const failures: string[] = [];
  for (const name of ROLLUP_FILES) {
    const text = readFileSync(join(dir, `${name}.json`), 'utf8');
    const reason = rollupSchemaError(name, JSON.parse(text));
    if (reason !== null) failures.push(`${name}: ${reason}`);
    const entry = manifest.files.find((f) => f.name === name);
    if (name !== 'manifest' && entry) {
      const sha = createHash('sha256').update(text).digest('hex');
      if (sha !== entry.sha256 || Buffer.byteLength(text) !== entry.bytes) failures.push(`${name}: manifest checksum mismatch`);
    }
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`validate: ${ROLLUP_FILES.length} files ok in ${dir}`);
}

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'ingest':
      return cmdIngest(rest);
    case 'rollup':
      return cmdRollup(rest);
    case 'validate':
      return cmdValidate(rest);
    default:
      throw new Error('usage: cli.ts ingest|rollup|validate [options]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
