import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FIXTURE = new URL('../../collector/fixtures/probe-1mib.bin', import.meta.url);
const SHA256 = '02ececd12c1b7e2b0cac1f19153df75d578a5917e1568cc3f4a81b50c245dabf';

describe('probe fixture', () => {
  it('is exactly 1 MiB', () => {
    expect(statSync(FIXTURE).size).toBe(1_048_576);
  });

  it('matches the pinned SHA-256', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
    expect(digest).toBe(SHA256);
  });
});
