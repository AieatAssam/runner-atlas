// Site fixtures for e2e and the audit: a synthetic survey per preset, a static build of the site over its rollups,
// and a `vite preview` of that build. Nothing here writes into data/ (SPEC 1, clean-repo rule).
//   node scripts/fixtures.ts serve <day-0|day-90|...> <port>   build the fixture, then serve it until killed
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSynthetic } from './synthetic/generate.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITE = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const SEED = 7;
const START = '2026-01-05';

// Synthetic rollups for a day preset, generated once into .tmp/synthetic (SPEC 1, 8).
export function syntheticRollups(days: number): string {
  if (!Number.isInteger(days) || days < 0) throw new Error(`unknown synthetic preset ${days}`);
  const fixture = join(REPO, '.tmp', 'synthetic', `day-${days}`);
  if (!existsSync(join(fixture, 'rollups', 'manifest.json'))) {
    writeSynthetic({ days, seed: SEED, start: START }, fixture);
  }
  return join(fixture, 'rollups');
}

// The committed Day-0 rollups for the default build, or the synthetic rollups of a named preset.
export function rollupsFor(name: string): string {
  if (name === 'day-0') return join(REPO, 'data', 'rollups');
  const match = /^day-(\d+)$/.exec(name);
  if (!match) throw new Error(`unknown fixture ${name}`);
  return syntheticRollups(Number(match[1]));
}

// Static build of the site over `rollupsDir`, written to `outDir`. Absolute paths only: vite resolves relative ones against site/.
export function buildFixture(rollupsDir: string, outDir: string): void {
  const res = spawnSync(process.execPath, [VITE, 'build', '--config', join(REPO, 'site', 'vite.config.ts'), '--outDir', outDir, '--emptyOutDir'], {
    cwd: REPO,
    env: { ...process.env, RUNNER_ATLAS_ROLLUPS_DIR: rollupsDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (res.status !== 0) throw new Error(`vite build failed for ${outDir}`);
}

// `vite preview` of a prebuilt dist on 127.0.0.1:port. The caller kills the returned child.
export function startPreview(outDir: string, port: number, stdio: 'inherit' | 'ignore' = 'ignore'): ChildProcess {
  return spawn(process.execPath, [VITE, 'preview', '--config', join(REPO, 'site', 'vite.config.ts'), '--outDir', outDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: REPO,
    stdio: ['ignore', stdio, stdio],
  });
}

// Build, then serve in the foreground. Forwards SIGTERM and SIGINT so Playwright's webServer shutdown reaches vite.
function serve(name: string, port: number): void {
  const outDir = join(REPO, '.tmp', 'e2e', name);
  buildFixture(rollupsFor(name), outDir);
  const child = startPreview(outDir, port, 'inherit');
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, name, port] = process.argv.slice(2);
  if (cmd !== 'serve' || !name || !port) {
    console.error('usage: node scripts/fixtures.ts serve <fixture> <port>');
    process.exit(2);
  }
  serve(name, Number(port));
}
