import { describe, expect, it } from 'vitest';
import type { RawSample } from '../../shared/types/sample.ts';
import { addDays } from '../../aggregator/src/common.ts';
import { buildRollouts } from '../../aggregator/src/rollouts.ts';
import { makeCtx } from '../../aggregator/src/summary.ts';
import { generate } from '../../scripts/synthetic/generate.ts';

const [template] = generate({ days: 1, seed: 7, start: '2026-01-05' });

// 20 days x 40 samples of one label; singleCoreScore steps up 10% on day 12.
function series(): RawSample[] {
  const out: RawSample[] = [];
  for (let d = 0; d < 20; d++) {
    const date = addDays('2026-01-05', d);
    for (let i = 0; i < 40; i++) {
      const at = `${date}T${String(i % 24).padStart(2, '0')}:${String(20 + (i >> 1)).padStart(2, '0')}:00Z`;
      out.push({
        ...template,
        id: `${1000 + d * 40 + i}.1.${template.label}.1`,
        collectedAtIso: at,
        bench: { ...template.bench, singleCoreScore: (d >= 12 ? 110 : 100) + (i % 7) * 0.1 },
      });
    }
  }
  return out.sort((a, b) => a.collectedAtIso.localeCompare(b.collectedAtIso) || a.id.localeCompare(b.id));
}

describe('change points', () => {
  it('finds a strong step on its own day, not the earliest candidate whose p underflows', () => {
    const r = buildRollouts(makeCtx(series()));
    const cps = r.changePoints.filter((c) => c.label === template.label && c.metric === 'singleCoreScore');
    expect(cps.map((c) => c.date)).toEqual(['2026-01-17']);
    expect(cps[0].shiftPct).toBeCloseTo(10, 0);
    expect(cps[0].before.n).toBe(480);
    expect(cps[0].after.n).toBe(320);
  });
});
