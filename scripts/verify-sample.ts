// Smoke check for one collector sample (SPEC 8, collector smoke row). Run after `npm run collect:local`:
//   node scripts/verify-sample.ts [.tmp/sample.json]
// Reuses the publish validator (size, schema, privacy: aggregator/src/ingest.ts) and the collector's
// structural self-check (collector/src/selfcheck.ts), then adds the smoke asserts: <= 1600 bytes,
// benchmarkDurationMs <= 20000, no IP-like strings, netProbe is "meta" or null.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selfCheck } from '../collector/src/selfcheck.ts';
import { rejectReason } from '../aggregator/src/ingest.ts';
import type { RawSample } from '../shared/types/sample.ts';

const file = resolve(process.argv[2] ?? '.tmp/sample.json');
const text = readFileSync(file, 'utf8');
const failures: string[] = [];

let sample: RawSample;
try {
  sample = JSON.parse(text) as RawSample;
} catch {
  console.error(`verify-sample: ${file} is not JSON`);
  process.exit(1);
}

// Publish-side validation: byte limit, ajv schema (additionalProperties: false), privacy scan.
const publishReason = rejectReason(sample);
if (publishReason !== null) failures.push(`publish validator: ${publishReason}`);

// Collector-side structural check, including its own 1600-byte limit and privacy scan.
failures.push(...selfCheck(text).map((e) => `self-check: ${e}`));

if (sample.bench.benchmarkDurationMs > 20_000) failures.push(`benchmarkDurationMs ${sample.bench.benchmarkDurationMs} exceeds 20000`);
if (sample.bench.netProbe !== 'meta' && sample.bench.netProbe !== null) failures.push(`netProbe is ${String(sample.bench.netProbe)}, expected meta or null for a local sample`);

if (failures.length > 0) {
  console.error(`verify-sample: ${file} failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`verify-sample: ${file} ok (${Buffer.byteLength(text, 'utf8')} bytes, ${sample.label}, src ${sample.src}, benchmarkDurationMs ${sample.bench.benchmarkDurationMs})`);
