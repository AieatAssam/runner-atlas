import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RawSample } from '../../shared/types/sample.ts';
import { buildRollups, writeRollups } from '../../aggregator/src/rollup.ts';

import { loadCoords } from '../../aggregator/src/cli.ts';
import { loadRaw } from '../../aggregator/src/ingest.ts';
import { rollupSchemaError, ROLLUP_FILES } from '../../aggregator/src/validate.ts';
import { generate, writeSynthetic } from '../../scripts/synthetic/generate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DAY0_DIR = join(REPO, 'data', 'rollups');
const RAW_DIR = join(REPO, 'data', 'raw');
const SEED = 7; // SPEC 1 preset
const START = '2026-01-05';
const PRESETS = [0, 1, 3, 7, 14, 30, 90] as const;
const TIMEOUT = 120_000;

const coords = loadCoords();
type Built = ReturnType<typeof buildRollups>;
const samples = new Map<number, RawSample[]>();
const built = new Map<number, Built>();

beforeAll(() => {
  for (const d of PRESETS) {
    const s = generate({ days: d, seed: SEED, start: START });
    samples.set(d, s);
    built.set(d, buildRollups(s, coords, 'synthetic'));
  }
}, TIMEOUT);

describe('synthetic presets', () => {
  it('validate against every rollup schema', () => {
    for (const d of PRESETS) {
      const b = built.get(d)!;
      for (const name of ROLLUP_FILES) {
        expect(rollupSchemaError(name, b.values[name]), `day ${d} ${name}`).toBeNull();
      }
    }
  }, TIMEOUT);

  it('reach the expected headline tier at each day count', () => {
    const expected: Record<number, string> = { 1: 'insufficient', 3: 'preliminary', 7: 'emerging', 30: 'established', 90: 'high' };
    for (const [d, tier] of Object.entries(expected)) {
      const m = built.get(Number(d))!.values.manifest as { headline: { tier: string } };
      expect(m.headline.tier, `day ${d}`).toBe(tier);
    }
  }, TIMEOUT);

  it('open tiers per SPEC 5 at each preset', () => {
    const open: Record<number, string[]> = {
      0: [],
      1: ['day1'],
      3: ['day1', 'day3'],
      7: ['day1', 'day3', 'day7'],
      14: ['day1', 'day3', 'day7', 'day14'],
      30: ['day1', 'day3', 'day7', 'day14', 'day30'],
      90: ['day1', 'day3', 'day7', 'day14', 'day30', 'day90'],
    };
    for (const d of PRESETS) {
      const m = built.get(d)!.values.manifest as { surveyDay: number; dataSource: string; tiers: Array<{ id: string; status: string }> };
      expect(m.surveyDay, `day ${d}`).toBe(d);
      expect(m.dataSource).toBe('synthetic');
      expect(m.tiers.filter((t) => t.status === 'open').map((t) => t.id), `day ${d}`).toEqual(open[d]);
    }
  }, TIMEOUT);

  it('day 90 benchmark change points fall inside the image rollout, not before it', () => {
    const r = built.get(90)!.values.rollouts as { changePoints: Array<{ metric: string; date: string }> };
    // The generator ramps the new image (+6% single core) from day 20 to day 55 after START.
    // totalDelaySec has no step but a weekly cycle, which MWU segmentation can flag; it is excluded here.
    const bench = r.changePoints.filter((c) => c.metric !== 'totalDelaySec');
    expect(bench.length).toBeGreaterThanOrEqual(1);
    for (const c of bench) expect(c.date >= '2026-01-25' && c.date <= '2026-03-01', c.date).toBe(true);
  }, TIMEOUT);

  it('writes byte-identical raw and rollup files on two runs', () => {
    const dirs = [mkdtempSync(join(tmpdir(), 'synth-a-')), mkdtempSync(join(tmpdir(), 'synth-b-'))];
    try {
      for (const dir of dirs) writeSynthetic({ days: 7, seed: SEED, start: START }, dir);
      const files = (dir: string) =>
        readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => relative(dir, join(e.parentPath, e.name)))
          .sort();
      expect(files(dirs[1])).toEqual(files(dirs[0]));
      expect(files(dirs[0]).length).toBe(7 + 8);
      for (const f of files(dirs[0])) expect(readFileSync(join(dirs[1], f)).equals(readFileSync(join(dirs[0], f))), f).toBe(true);
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('day 90 shows at least one image event and at least one change point', () => {
    const r = built.get(90)!.values.rollouts as {
      byLabel: Array<{ events: unknown[] }>;
      changePoints: unknown[];
    };
    expect(r.byLabel.some((l) => l.events.length > 0)).toBe(true);
    expect(r.changePoints.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('is deterministic: the same seed gives the same samples', () => {
    const again = generate({ days: 3, seed: SEED, start: START });
    expect(JSON.stringify(again)).toBe(JSON.stringify(samples.get(3)));
  }, TIMEOUT);

  it('rebuilds byte-for-byte from the same samples', () => {
    const again = buildRollups(samples.get(30)!, coords, 'synthetic');
    expect(again.text).toEqual(built.get(30)!.text);
  }, TIMEOUT);

  it('refuses to write under the repo data directory', () => {
    expect(() => writeSynthetic({ days: 0, seed: SEED, start: START }, join(REPO, 'data', 'rollups'))).toThrow(/refusing/);
  });
});

describe('Day-0 rollups in data/rollups', () => {
  it('the raw store holds no samples and only the placeholder file', () => {
    expect(loadRaw(RAW_DIR)).toEqual([]);
    expect(readFileSync(join(RAW_DIR, '.gitkeep'), 'utf8')).toBe('');
  });

  it('match a fresh build from an empty store, byte for byte', () => {
    const fresh = buildRollups([], coords, 'empty');
    for (const name of [...ROLLUP_FILES]) {
      const onDisk = readFileSync(join(DAY0_DIR, `${name}.json`), 'utf8');
      expect(onDisk, name).toBe(fresh.text[name]);
    }
  }, TIMEOUT);

  it('writing a Day-0 build reproduces the committed files', () => {
    // Writes to a fresh OS temp directory, removed afterwards; never into data/ or the repo.
    const dir = mkdtempSync(join(tmpdir(), 'day0-'));
    try {
      writeRollups(dir, buildRollups([], coords, 'empty'));
      for (const name of ROLLUP_FILES) {
        expect(readFileSync(join(dir, `${name}.json`), 'utf8')).toBe(readFileSync(join(DAY0_DIR, `${name}.json`), 'utf8'));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
