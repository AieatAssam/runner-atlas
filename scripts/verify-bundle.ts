// Bundle budget check (SPEC 7, 8 bundle row). Run after `npm run build`:
//   node scripts/verify-bundle.ts
// 1. `three` must not appear in the entry chunk's static import graph (dynamic imports are allowed).
// 2. Entry JS (entry chunk plus its static imports) must gzip to at most 90 KB (90,000 bytes, decimal KB).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

interface ManifestEntry {
  file: string;
  src?: string;
  name?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

const DIST = resolve('site/dist');
const BUDGET_BYTES = 90_000;
const THREE = /(^|[/\\])three([/\\.]|$)|node_modules[/\\]three/;

const manifestPath = resolve(DIST, '.vite/manifest.json');
let manifest: Record<string, ManifestEntry>;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestEntry>;
} catch {
  console.error(`verify-bundle: cannot read ${manifestPath}; run npm run build first`);
  process.exit(1);
}

const entryKey = Object.keys(manifest).find((k) => manifest[k]?.isEntry);
if (!entryKey) {
  console.error('verify-bundle: no entry chunk in manifest');
  process.exit(1);
}

// Walk static imports only: the entry chunk and everything it pulls in at load time.
const seen = new Set<string>();
const stack = [entryKey];
while (stack.length > 0) {
  const key = stack.pop()!;
  if (seen.has(key)) continue;
  seen.add(key);
  for (const next of manifest[key]?.imports ?? []) stack.push(next);
}

const failures: string[] = [];
for (const key of seen) {
  const entry = manifest[key];
  if (!entry) continue;
  if (THREE.test(key) || THREE.test(entry.src ?? '') || THREE.test(entry.file)) failures.push(`three found in the static graph: ${key} -> ${entry.file}`);
}

let gzipTotal = 0;
const parts: string[] = [];
for (const key of seen) {
  const entry = manifest[key];
  if (!entry || !entry.file.endsWith('.js')) continue;
  const size = gzipSync(readFileSync(resolve(DIST, entry.file)), { level: 9 }).length;
  gzipTotal += size;
  parts.push(`${entry.file} ${size}`);
}

console.log(`verify-bundle: entry JS gzip ${gzipTotal} bytes (budget ${BUDGET_BYTES})`);
for (const p of parts) console.log(`  ${p}`);
if (gzipTotal > BUDGET_BYTES) failures.push(`entry JS gzip ${gzipTotal} bytes exceeds ${BUDGET_BYTES}`);

if (failures.length > 0) {
  console.error('verify-bundle: failed');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('verify-bundle: ok');
