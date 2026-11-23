import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../aggregator/src/fieldlog.ts';
import { buildRollups } from '../../aggregator/src/rollup.ts';
import { loadCoords } from '../../aggregator/src/cli.ts';
import { generate } from '../../scripts/synthetic/generate.ts';

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
