import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseIncoming, writeRaw } from '../../aggregator/src/ingest.ts';
import { privacyScanError } from '../../aggregator/src/privacy.ts';
import { generate } from '../../scripts/synthetic/generate.ts';

const [sample] = generate({ days: 1, seed: 7, start: '2026-01-05' });

describe('privacy scan', () => {
  it('rejects bare addresses and host ranges wherever they hide', () => {
    for (const s of ['1.2.3.4', 'v1.2.3.4', '::1', 'fe80::1%eth0', '2001:db8::1', '10.0.0.0/32', '2001:db8::/128',
      '1%2E2%2E3%2E4', '１.２.３.４', 'host 192.168.0.10:443', '[2001:db8::2]:443', '::ffff:10.1.2.3',
      '1%252E2%252E3%252E4', '%EF%BC%91.%EF%BC%92.%EF%BC%93.%EF%BC%94', '100% load on 1%2E2%2E3%2E4']) {
      expect(privacyScanError({ a: { b: [s] } }), s).toMatch(/^\$\.a\.b\[0\] /);
      expect(privacyScanError({ a: { b: [s] } })).not.toContain(s);
    }
    expect(privacyScanError({ ['10.1.2.3']: 1 })).not.toBeNull();
  });

  it('passes published network ranges, versions and timestamps', () => {
    for (const s of ['20.42.0.0/16', '2001:db8::/32', '12:34:56', '6.8.0-1021-azure', '10.0.26100.1', '20261015.2',
      '2026-01-05T00:17:00Z', 'Darwin 24.6.0', '1.2.3.4.5']) {
      expect(privacyScanError({ s }), s).toBeNull();
    }
    expect(privacyScanError(sample)).toBeNull();
  });
});

describe('ingest', () => {
  it('accepts a pretty-printed sample.json and JSON lines alike', () => {
    expect(parseIncoming(JSON.stringify(sample, null, 2)).accepted).toHaveLength(1);
    expect(parseIncoming(`${JSON.stringify(sample)}\n\n${JSON.stringify(sample)}\n`).accepted).toHaveLength(2);
  });

  it('quarantines oversize, invalid, private and malformed samples without echoing them', () => {
    const big = { ...sample, pad: 'x'.repeat(2100) };
    const leaky = { ...sample, os: { ...sample.os, kernel: '6.8.0 on 10.1.2.3' } };
    const noField = { ...sample, extra: 1 };
    const text = [big, leaky, noField].map((s) => JSON.stringify(s)).join('\n') + '\n{"secret": 10.9.8.7\n';
    const res = parseIncoming(text, 'sample-x/sample.json');
    expect(res.accepted).toHaveLength(0);
    expect(res.quarantined.map((q) => q.where)).toEqual([1, 2, 3, 4].map((i) => `sample-x/sample.json:${i}`));
    expect(res.quarantined[0].reason).toMatch(/2048 bytes/);
    expect(res.quarantined[1].reason).toMatch(/^schema:/);
    expect(res.quarantined[2].reason).toMatch(/^schema:/);
    expect(res.quarantined[3].reason).toBe('not valid JSON');
    expect(JSON.stringify(res.quarantined)).not.toMatch(/10\.1\.2\.3|10\.9\.8\.7|secret/);
  });

  it('refuses to rewrite a day file that holds an invalid row instead of dropping it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    try {
      const file = join(dir, '2026', '01', '05.jsonl');
      mkdirSync(join(dir, '2026', '01'), { recursive: true });
      writeFileSync(file, '{"broken": true}\n');
      expect(() => writeRaw(dir, [sample])).toThrow();
      expect(readFileSync(file, 'utf8')).toBe('{"broken": true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
