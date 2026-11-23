// Builds every rollup from raw samples, validates each, and writes JSON (manifest last).
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawSample } from '../../shared/types/sample.ts';
import type { Manifest, RollupName } from '../../shared/types/rollups.ts';
import { LABELS, sortSamples } from './common.ts';
import { evaluateTiers } from './tiers.ts';
import { buildFleet } from './fleet.ts';
import { buildBenchmarks } from './benchmarks.ts';
import { buildDrift, headlineFor, scheduleRuns, scheduleSamples, slotCoverage } from './drift.ts';
import { buildNeighbours } from './neighbours.ts';
import { buildRollouts } from './rollouts.ts';
import { buildSeasonality } from './seasonality.ts';
import { buildRegions, type Coord } from './regions.ts';
import { buildFieldLog } from './fieldlog.ts';
import { makeCtx, headOf, type Ctx } from './summary.ts';
import { rollupSchemaError } from './validate.ts';

export type DataSource = Manifest['dataSource'];
export const NAMES: readonly RollupName[] = ['fleet', 'benchmarks', 'drift', 'neighbours', 'rollouts', 'seasonality', 'regions'];

export interface Built {
  values: Record<RollupName | 'manifest', unknown>;
  text: Record<RollupName | 'manifest', string>;
}

export function dedupeById(samples: RawSample[]): RawSample[] {
  const seen = new Map<string, RawSample>();
  for (const s of samples) if (!seen.has(s.id)) seen.set(s.id, s);
  return [...seen.values()];
}

export function dataSourceOf(samples: RawSample[]): DataSource {
  if (samples.length === 0) return 'empty';
  return samples.every((s) => s.src === 'synthetic') ? 'synthetic' : 'live';
}

// JSON with trailing newline; throws on any non-finite number (NaN and Infinity cannot serialise).
export function serialize(value: unknown): string {
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`non-finite number at ${path}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(value, '$');
  return JSON.stringify(value) + '\n';
}

export function buildRollups(
  input: RawSample[],
  coords: Record<string, Coord>,
  dataSource: DataSource = dataSourceOf(input),
): Built {
  const samples = sortSamples(dedupeById(input));
  const ctx: Ctx = makeCtx(samples);
  const surveyDay = ctx.days.length;

  const drift = buildDrift(ctx);
  const benchmarks = buildBenchmarks(ctx);
  const fleet = buildFleet(ctx);
  const neighbours = buildNeighbours(ctx);
  const rollouts = buildRollouts(ctx);
  const seasonality = buildSeasonality(ctx);
  const regions = buildRegions(ctx, coords);

  const schedule = scheduleSamples(samples);
  const cov = slotCoverage(schedule);
  const fieldLog = buildFieldLog(ctx, cov, scheduleRuns(schedule), rollouts);

  const tiers = evaluateTiers(samples.length, surveyDay, ctx.range?.from ?? null);
  const manifest: Omit<Manifest, 'files'> & { files: Manifest['files'] } = {
    ...headOf('manifest', ctx),
    dataSource,
    firstSampleIso: samples[0]?.collectedAtIso ?? null,
    lastSampleIso: samples[samples.length - 1]?.collectedAtIso ?? null,
    surveyDay,
    labelsActive: LABELS.filter((l) => samples.some((s) => s.label === l)),
    slotsExpected: cov.expected,
    slotsObserved: cov.observed,
    coverage: cov.expected > 0 ? cov.observed / cov.expected : null,
    tiers,
    headline: headlineFor(ctx, drift, surveyDay),
    fieldLog,
    files: [],
  };

  const values = { fleet, benchmarks, drift, neighbours, rollouts, seasonality, regions, manifest } as Built['values'];
  const text = {} as Built['text'];
  for (const name of NAMES) {
    const reason = rollupSchemaError(name, values[name]);
    if (reason !== null) throw new Error(`${name}.json fails its schema: ${reason}`);
    text[name] = serialize(values[name]);
  }
  manifest.files = NAMES.map((name) => ({
    name,
    path: `${name}.json`,
    bytes: Buffer.byteLength(text[name]),
    sha256: createHash('sha256').update(text[name]).digest('hex'),
  }));
  const mReason = rollupSchemaError('manifest', manifest);
  if (mReason !== null) throw new Error(`manifest.json fails its schema: ${mReason}`);
  text.manifest = serialize(manifest);
  return { values, text };
}

// Writes each file via a temp file and rename; the manifest goes last so a reader never sees a manifest without its files.
export function writeRollups(dir: string, built: Built): void {
  mkdirSync(dir, { recursive: true });
  for (const name of [...NAMES, 'manifest'] as const) {
    const target = join(dir, `${name}.json`);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, built.text[name], 'utf8');
    renameSync(tmp, target);
  }
}
