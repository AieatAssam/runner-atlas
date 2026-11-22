// Writes collector/fixtures/probe-1mib.bin (SPEC 3.6): exactly 1 MiB of mulberry32(fnv1a32("probe")) output.
// Run: node scripts/make-probe.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 1_048_576;

function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ byte, 0x01000193);
  }
  return h >>> 0;
}

// Reference mulberry32 (bryc), returning the raw 32-bit state instead of a float in [0, 1).
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const next = mulberry32(fnv1a32('probe'));
const out = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i += 4) out.writeUInt32LE(next(), i);

const dir = new URL('../collector/fixtures/', import.meta.url);
const file = new URL('probe-1mib.bin', dir);
mkdirSync(dir, { recursive: true });
writeFileSync(file, out);
console.log(`${out.length} bytes sha256=${createHash('sha256').update(out).digest('hex')}`);
