import { describe, expect, it } from 'vitest';
import { evaluateTiers } from '../../aggregator/src/tiers.ts';

describe('evaluateTiers', () => {
  it('starts every tier charting with the full requirement when the survey is empty', () => {
    const rows = evaluateTiers(0, 0, null);
    expect(rows.map((r) => r.id)).toEqual(['day1', 'day3', 'day7', 'day14', 'day30', 'day90']);
    for (const r of rows) {
      expect(r.status).toBe('charting');
      expect(r.samplesNeeded).toBe(r.minSamples);
      expect(r.daysNeeded).toBe(r.minDays);
      expect(r.opensOn).toBeNull();
    }
  });

  it('opens tiers whose samples and days are both met', () => {
    const rows = evaluateTiers(5000, 30, '2026-09-01');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.day1.status).toBe('open');
    expect(byId.day30.status).toBe('open');
    expect(byId.day90.status).toBe('charting');
    expect(byId.day90.samplesNeeded).toBe(4000);
    expect(byId.day90.daysNeeded).toBe(60);
  });

  it('forecasts a date only when samples are enough and only days are short', () => {
    const rows = evaluateTiers(9000, 10, '2026-09-01');
    const day90 = rows.find((r) => r.id === 'day90')!;
    expect(day90.samplesNeeded).toBe(0);
    expect(day90.daysNeeded).toBe(80);
    // First sample 2026-09-01 plus 89 days is 2026-11-29.
    expect(day90.opensOn).toBe('2026-11-29');
  });

  it('gives no forecast when samples are still short', () => {
    const day90 = evaluateTiers(100, 10, '2026-09-01').find((r) => r.id === 'day90')!;
    expect(day90.opensOn).toBeNull();
  });
});
