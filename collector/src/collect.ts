// Passive runner collector (SPEC 1, 3). Run: node collector/src/collect.ts --label <l> --replica <n> --out <path> [--local]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform, release, tmpdir, uptime, availableParallelism, totalmem, cpus, version as osVersion, arch as hostArch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { RawSample } from '../../shared/types/sample.ts';
import { runBenchmarks } from './benchmarks.ts';
import {
  diskSpace, flagsFromSysctl, linuxDiskKind, parseCpuinfo, parseDiskutil, parseLscpu, parseOsRelease, parseProcStat,
  parseSwVers, parseSysctlKv, parseWinDisk, readAgentVersion, readOrNull, run, stealPct, blockDeviceOf, vendorFromBrand,
} from './hardware.ts';
import { readPlacement } from './region.ts';
import { selfCheck } from './selfcheck.ts';
import { NULL_TIMING, fetchTiming } from './timing.ts';

export type Matrix = Array<{ label: RawSample['label']; replicas: number; optional: boolean; os: string; arch: string }>;

export function readMatrix(): Matrix {
  return JSON.parse(readFileSync(new URL('../matrix.json', import.meta.url), 'utf8')) as Matrix;
}

// The matrix is the single source of truth: the local label is the entry matching this host.
export function labelForHost(matrix: Matrix, os: string, cpuArch: string): RawSample['label'] | null {
  return matrix.find((m) => m.os === os && m.arch === cpuArch)?.label ?? null;
}

// Only the five allowlisted variables are ever read or kept (SPEC 3.1).
export function pickEnv(env: NodeJS.ProcessEnv): Pick<RawSample['env'], 'imageOS' | 'imageVersion' | 'runnerOS' | 'runnerArch' | 'runnerEnvironment'> {
  const pick = (k: string) => env[k] ?? null;
  return {
    imageOS: pick('ImageOS'), imageVersion: pick('ImageVersion'), runnerOS: pick('RUNNER_OS'),
    runnerArch: pick('RUNNER_ARCH'), runnerEnvironment: pick('RUNNER_ENVIRONMENT'),
  };
}

// Local smoke runs always exercise the meta fallback even inside GitHub Actions CI (SPEC 3.6, 8).
export function benchEnvFor(env: NodeJS.ProcessEnv, local: boolean): NodeJS.ProcessEnv {
  return local ? { ...env, GITHUB_REPOSITORY: undefined, GITHUB_SHA: undefined } : env;
}

// Fits free-text fields to the schema's maxLength: env values that do not fit become null, other text is cut.
export function assembleSample(parts: Omit<RawSample, 'v'>): RawSample {
  const cut = (s: string, max: number) => s.slice(0, max);
  const fit = (s: string | null, max: number) => (s !== null && s.length <= max ? s : null);
  const { env: e, os, cpu, disk } = parts;
  return {
    v: 1,
    ...parts,
    env: {
      imageOS: fit(e.imageOS, 64), imageVersion: fit(e.imageVersion, 64), runnerOS: fit(e.runnerOS, 32),
      runnerArch: fit(e.runnerArch, 32), runnerEnvironment: fit(e.runnerEnvironment, 32), agentVersion: fit(e.agentVersion, 32),
    },
    os: { name: cut(os.name, 128), version: cut(os.version, 64), kernel: cut(os.kernel, 128) },
    cpu: { ...cpu, model: cut(cpu.model, 128), vendor: cut(cpu.vendor, 64) },
    disk: { ...disk, fs: disk.fs === null ? null : cut(disk.fs, 32) },
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

// Linux /proc/stat read, or null on other platforms.
function readProcStat(): { steal: number; total: number } | null {
  return platform() === 'linux' ? parseProcStat(readOrNull('/proc/stat') ?? '') : null;
}

async function cpuFacts(): Promise<RawSample['cpu']> {
  const logical = availableParallelism();
  const host = platform();
  if (host === 'linux') {
    const info = parseCpuinfo(readOrNull('/proc/cpuinfo') ?? '');
    const lscpu = parseLscpu((await run('lscpu', [])) ?? '');
    return {
      model: info.model ?? lscpu.model ?? 'unknown',
      vendor: info.vendor !== 'unknown' ? info.vendor : vendorFromBrand(lscpu.vendorId),
      logical,
      physical: lscpu.physical,
      flags: info.flags,
    };
  }
  if (host === 'darwin') {
    const brand = (await run('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim() ?? null;
    const physical = Number((await run('sysctl', ['-n', 'hw.physicalcpu'])) ?? '');
    const optional = parseSysctlKv((await run('sysctl', ['hw.optional'])) ?? '');
    return {
      model: brand ?? 'unknown', vendor: vendorFromBrand(brand), logical,
      physical: Number.isInteger(physical) && physical > 0 ? physical : null, flags: flagsFromSysctl(optional),
    };
  }
  // Windows: os.cpus() model only; no flags (SPEC 3.3).
  const model = cpus()[0]?.model ?? 'unknown';
  return { model, vendor: vendorFromBrand(model), logical, physical: null, flags: [] };
}

async function diskFacts(): Promise<RawSample['disk']> {
  const space = diskSpace();
  const host = platform();
  if (host === 'linux') {
    const source = (await run('findmnt', ['-no', 'SOURCE', '--target', tmpdir()]))?.trim() ?? '';
    const fs = (await run('findmnt', ['-no', 'FSTYPE', '--target', tmpdir()]))?.trim() || null;
    const device = blockDeviceOf(source);
    if (!device) return { ...space, kind: 'unknown', fs };
    const rotational = readOrNull(`/sys/block/${device}/queue/rotational`)?.trim() ?? null;
    const model = readOrNull(`/sys/block/${device}/device/model`)?.trim() ?? null;
    return { ...space, kind: linuxDiskKind(device, rotational, model), fs };
  }
  if (host === 'darwin') {
    const info = parseDiskutil((await run('diskutil', ['info', '/'])) ?? '');
    return { ...space, ...info };
  }
  const disk = parseWinDisk(
    (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-PhysicalDisk | Select-Object MediaType,BusType,FriendlyName | ConvertTo-Json -Compress'])) ?? '',
  );
  const fs = (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Volume -DriveLetter (Get-Item -LiteralPath $env:TEMP).PSDrive.Name).FileSystemType']))?.trim() || null;
  return { ...space, kind: disk.kind, fs };
}

async function osFacts(): Promise<RawSample['os']> {
  const host = platform();
  if (host === 'linux') {
    return { name: 'Linux', version: parseOsRelease(readOrNull('/etc/os-release') ?? '') ?? 'unknown', kernel: release() };
  }
  if (host === 'darwin') {
    return { name: 'macOS', version: parseSwVers((await run('sw_vers', ['-productVersion'])) ?? '') ?? 'unknown', kernel: release() };
  }
  return { name: 'Windows', version: osVersion() || 'unknown', kernel: release() };
}

export async function collect(opts: {
  label: RawSample['label']; replica: number; local: boolean; env: NodeJS.ProcessEnv;
}): Promise<RawSample> {
  const { env, local } = opts;
  const token = env.GITHUB_TOKEN || undefined;
  const runId = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
  const collectedAtIso = new Date().toISOString();
  const uptimeSec = Math.round(uptime());

  let id: string;
  let event: RawSample['event'];
  let src: RawSample['src'];
  if (local) {
    id = `local.${Date.now()}.${opts.label}.1`;
    event = 'local';
    src = 'local';
  } else {
    if (!runId || !attempt || !env.GITHUB_REPOSITORY) throw new Error('live run needs GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_REPOSITORY');
    if (env.GITHUB_EVENT_NAME !== 'schedule' && env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('unsupported event');
    id = `${runId}.${attempt}.${opts.label}.${opts.replica}`;
    event = env.GITHUB_EVENT_NAME;
    src = 'live';
  }

  const timing = local
    ? NULL_TIMING
    : await fetchTiming({
      repo: env.GITHUB_REPOSITORY as string, runId, attempt, jobName: `collect ${opts.label} r${opts.replica}`,
      event: event as 'schedule' | 'workflow_dispatch', token,
    });

  const osInfo = await osFacts();
  const cpu = await cpuFacts();
  const disk = await diskFacts();
  const place = await readPlacement({ token });
  const agentVersion = await readAgentVersion({ home: homedir(), runnerTemp: env.RUNNER_TEMP, platform: platform() });

  const before = readProcStat();
  const bench = await runBenchmarks({ env: benchEnvFor(env, local), tmpDir: tmpdir() });
  const after = readProcStat();

  return assembleSample({
    id, src, label: opts.label, replica: opts.replica, event, collectedAtIso, timing,
    env: { ...pickEnv(env), agentVersion },
    os: osInfo,
    cpu,
    memGB: round1(totalmem() / 2 ** 30),
    disk,
    place,
    uptimeSec,
    stealPct: platform() === 'linux' ? stealPct(before, after) : null,
    bench,
  });
}

export function parseCliArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: 'string' },
      replica: { type: 'string' },
      out: { type: 'string' },
      local: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return values;
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseCliArgs(argv);
  if (!args.out) throw new Error('--out is required');
  const local = args.local === true || env.GITHUB_ACTIONS !== 'true';
  const matrix = readMatrix();

  const label = (args.label ?? (local ? labelForHost(matrix, platform(), hostArch()) : null)) as RawSample['label'] | null;
  const entry = matrix.find((m) => m.label === label);
  if (!label || !entry) throw new Error(`unknown or missing --label (host default: ${labelForHost(matrix, platform(), hostArch()) ?? 'none'})`);

  const replica = Number(args.replica ?? '1');
  if (!Number.isInteger(replica) || replica < 1 || replica > entry.replicas) throw new Error(`--replica must be 1..${entry.replicas}`);
  if (local && replica !== 1) throw new Error('--local runs use replica 1');

  const sample = await collect({ label, replica, local, env });
  const token = env.GITHUB_TOKEN;
  const text = JSON.stringify(sample);
  const errors = selfCheck(text, { secrets: token ? [token] : [], homeDir: homedir() });
  if (errors.length > 0) throw new Error(`self-check failed: ${errors.join(', ')}`);

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, text);
  console.log(`wrote ${args.out} (${Buffer.byteLength(text)} bytes, benchmark ${sample.bench.benchmarkDurationMs} ms)`);
}

const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    console.error(`collect failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
