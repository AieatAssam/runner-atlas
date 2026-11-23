import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../aggregator/src/fieldlog.ts';
import { buildRollups } from '../../aggregator/src/rollup.ts';
import { loadCoords } from '../../aggregator/src/cli.ts';
import { generate } from '../../scripts/synthetic/generate.ts';
import type { RawSample } from '../../shared/types/sample.ts';
import { cpuFamily } from '../../aggregator/src/hardware.ts';
import { regionKey, sortSamples } from '../../aggregator/src/common.ts';
import { buildRegions } from '../../aggregator/src/regions.ts';
import { makeCtx } from '../../aggregator/src/summary.ts';

const coords = loadCoords();
const DASH = /[–—]|\s--\s/;
const UNLOCK = /unlock/i;

describe('field log copy', () => {
  it('formats durations in plain words', () => {
    expect(formatDuration(41)).toBe('41 s');
    expect(formatDuration(190)).toBe('3 min 10 s');
    expect(formatDuration(0.4)).toBe('0 s');
  });

  it('keeps dashes and the banned word out of every sentence, and uses ISO dates', () => {
    const { values } = buildRollups(generate({ days: 7, seed: 3, start: '2026-09-01' }), coords);
    const log = (values.manifest as { fieldLog: Array<{ date: string; text: string }> }).fieldLog;
    expect(log.length).toBe(7);
    for (const entry of log) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.text).not.toMatch(DASH);
      expect(entry.text).not.toMatch(UNLOCK);
      expect(entry.text).toMatch(/^\d+ samples from \d+ runner labels in \d+ regions\./);
    }
  }, 60_000);

  it('marks only the last date as partial and lists newest first', () => {
    const { values } = buildRollups(generate({ days: 3, seed: 3, start: '2026-09-01' }), coords);
    const log = (values.manifest as { fieldLog: Array<{ date: string; partial: boolean }> }).fieldLog;
    expect(log[0].date).toBe('2026-09-03');
    expect(log[0].partial).toBe(true);
    expect(log.slice(1).every((e) => !e.partial)).toBe(true);
  }, 60_000);
});

describe('rollups on a fixture', () => {
  it('builds every file from a one-day fixture without throwing', () => {
    const { values, text } = buildRollups(generate({ days: 1, seed: 11, start: '2026-09-01' }), coords);
    for (const name of ['fleet', 'benchmarks', 'drift', 'neighbours', 'rollouts', 'seasonality', 'regions', 'manifest'] as const) {
      expect(values[name]).toBeTypeOf('object');
      expect(text[name].endsWith('\n')).toBe(true);
    }
    expect((values.manifest as { dataSource: string }).dataSource).toBe('synthetic');
    expect((values.manifest as { surveyDay: number }).surveyDay).toBe(1);
  }, 60_000);
});

describe('cpuFamily on 2026 live CPU models', () => {
  it.each([
    ['Intel(R) Xeon(R) 6975P-C', 'Intel Xeon 6975P-C'],
    ['Cobalt 100', 'Microsoft Cobalt 100'],
    ['AMD EPYC 9V45 96-Core Processor                ', 'AMD EPYC 9V45'],
    ['Neoverse-N2', 'Neoverse-N2'],
    ['Neoverse-V2', 'Neoverse-V2'],
    ['Apple M1 (Virtual)', 'Apple M1 (Virtual)'],
    ['Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz', 'Intel Core i7-8700b'],
  ])('maps %s to %s', (model, family) => {
    expect(cpuFamily(model)).toBe(family);
  });
});

// A valid synthetic sample with its region overridden; ids keep the sort stable.
function withRegion(base: RawSample, i: number, region: string | null, inferred: string | null = null): RawSample {
  const s = structuredClone(base);
  s.id = `region-test-${i}`;
  s.place = { ...s.place, region, inferredRegion: inferred };
  return s;
}

describe('regions from live IMDS names', () => {
  const base = generate({ days: 1, seed: 11, start: '2026-09-01' })[0];

  it('regionKey lowercases and trims mixed-case Azure names', () => {
    expect(regionKey(withRegion(base, 0, 'ChileCentral'))).toBe('chilecentral');
    expect(regionKey(withRegion(base, 1, 'WestUS3'))).toBe('westus3');
    expect(regionKey(withRegion(base, 2, 'westcentralus'))).toBe('westcentralus');
    expect(regionKey(withRegion(base, 3, null, ' US-West-1 '))).toBe('us-west-1');
    expect(regionKey(withRegion(base, 4, null, null))).toBe('unknown');
  });

  it('buildRegions resolves all six live IMDS regions with no unknown samples', () => {
    const live = ['centralus', 'eastus2', 'westus', 'westus3', 'westcentralus', 'chilecentral'];
    const samples = sortSamples(live.map((r, i) => withRegion(base, i, r.replace(/^./, (c) => c.toUpperCase()))));
    const rollup = buildRegions(makeCtx(samples), coords);
    expect(rollup.regions.map((r) => r.region).sort()).toEqual([...live].sort());
    expect(rollup.unknown.samples).toBe(0);
  });
});
