// Synthetic survey generator. Deterministic for a given seed: one run per hourly :17 slot, 11 jobs per run.
// Usage: node scripts/synthetic/generate.ts --days 90 --seed 7 --start 2026-01-05 --out .tmp/synthetic/day-90
// Never writes into the repo's data/ directory. Stays off the wall clock: all times derive from --start.
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DiskKind, RawSample, RunnerLabel } from '../../shared/types/sample.ts';
import { addDays, sortSamples, utcMs, weekdayOf } from '../../aggregator/src/common.ts';
import { uniformStream } from '../../aggregator/src/prng.ts';
import { writeRaw } from '../../aggregator/src/ingest.ts';
import { buildRollups, writeRollups } from '../../aggregator/src/rollup.ts';
import { loadCoords } from '../../aggregator/src/cli.ts';
import { sampleSchemaError } from '../../aggregator/src/validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REPO_DATA = join(REPO, 'data');

interface Cpu { model: string; vendor: string; flags: string[]; logical: number; weight: number; single: number; multi: number }
interface Config {
  label: RunnerLabel;
  replicas: number;
  linux: boolean;
  os: { name: string; version: string; kernel: string };
  imageOS: string;
  runnerOS: string;
  runnerArch: string;
  disk: DiskKind;
  fs: string;
  memGB: number;
  regions: Array<{ region: string; weight: number }>;
  cpus: Cpu[];
  write: number;
  read: number;
  mem: number;
  rollout: boolean;
}

const UBUNTU = { name: 'Ubuntu', version: '24.04.2 LTS', kernel: '6.8.0-1021-azure' };
const WIN = { name: 'Windows Server 2025', version: '10.0.26100', kernel: '10.0.26100.1' };
const MAC = { name: 'macOS', version: '15.6', kernel: 'Darwin 24.6.0' };

// 11 jobs per run, replicas as in the SPEC 2 runner matrix.
export const CONFIGS: Config[] = [
  {
    label: 'ubuntu-24.04', replicas: 3, linux: true, os: UBUNTU, imageOS: 'ubuntu24', runnerOS: 'Linux', runnerArch: 'X64',
    disk: 'ssd', fs: 'ext4', memGB: 16, rollout: true,
    regions: [{ region: 'eastus', weight: 3 }, { region: 'eastus2', weight: 2 }, { region: 'centralus', weight: 1 }],
    cpus: [
      { model: 'AMD EPYC 7763 64-Core Processor', vendor: 'AuthenticAMD', flags: ['avx', 'avx2', 'fma', 'aes', 'sse4_2'], logical: 4, weight: 0.6, single: 38.5, multi: 150 },
      { model: 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz', vendor: 'GenuineIntel', flags: ['avx', 'avx2', 'avx512f', 'fma', 'aes'], logical: 4, weight: 0.4, single: 34, multi: 140 },
    ],
    write: 1900, read: 2600, mem: 28,
  },
  {
    label: 'ubuntu-24.04-arm', replicas: 2, linux: true, os: UBUNTU, imageOS: 'ubuntu24', runnerOS: 'Linux', runnerArch: 'ARM64',
    disk: 'ssd', fs: 'ext4', memGB: 16, rollout: true,
    regions: [{ region: 'northcentralus', weight: 2 }, { region: 'canadacentral', weight: 1 }],
    cpus: [{ model: 'Neoverse-N2', vendor: 'ARM', flags: ['asimd', 'aes', 'sve', 'lse'], logical: 4, weight: 1, single: 30, multi: 120 }],
    write: 1600, read: 2300, mem: 24,
  },
  {
    label: 'windows-2025', replicas: 2, linux: false, os: WIN, imageOS: 'win25', runnerOS: 'Windows', runnerArch: 'X64',
    disk: 'ssd', fs: 'NTFS', memGB: 16, rollout: true,
    regions: [{ region: 'eastus', weight: 2 }, { region: 'eastus2', weight: 1 }, { region: 'westus2', weight: 1 }],
    cpus: [
      { model: 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz', vendor: 'GenuineIntel', flags: ['avx', 'avx2', 'avx512f', 'fma', 'aes'], logical: 4, weight: 0.5, single: 33, multi: 130 },
      { model: 'AMD EPYC 7763 64-Core Processor', vendor: 'AuthenticAMD', flags: ['avx', 'avx2', 'fma', 'aes', 'sse4_2'], logical: 4, weight: 0.5, single: 36, multi: 145 },
    ],
    write: 1400, read: 1900, mem: 26,
  },
  {
    label: 'windows-11-arm', replicas: 1, linux: false, os: { name: 'Windows 11', version: '10.0.26100', kernel: '10.0.26100.1' }, imageOS: 'win11', runnerOS: 'Windows', runnerArch: 'ARM64',
    disk: 'ssd', fs: 'NTFS', memGB: 8, rollout: true,
    regions: [{ region: 'northcentralus', weight: 1 }, { region: 'canadacentral', weight: 1 }],
    cpus: [{ model: 'Neoverse-N2', vendor: 'ARM', flags: ['asimd', 'aes', 'lse'], logical: 8, weight: 1, single: 28, multi: 100 }],
    write: 1200, read: 1500, mem: 18,
  },
  {
    label: 'macos-15', replicas: 2, linux: false, os: MAC, imageOS: 'macos15', runnerOS: 'macOS', runnerArch: 'ARM64',
    disk: 'virtual', fs: 'APFS', memGB: 7, rollout: true,
    regions: [{ region: 'eastus2', weight: 1 }, { region: 'centralus', weight: 1 }],
    cpus: [{ model: 'Apple M1 (Virtual)', vendor: 'Apple', flags: ['asimd', 'aes', 'lse'], logical: 3, weight: 1, single: 45, multi: 200 }],
    write: 2100, read: 2800, mem: 40,
  },
  {
    label: 'macos-15-intel', replicas: 1, linux: false, os: MAC, imageOS: 'macos15', runnerOS: 'macOS', runnerArch: 'X64',
    disk: 'virtual', fs: 'APFS', memGB: 14, rollout: false,
    regions: [{ region: 'westus2', weight: 1 }, { region: 'westus', weight: 1 }],
    cpus: [{ model: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', vendor: 'GenuineIntel', flags: ['avx', 'avx2', 'fma', 'aes', 'sse4_2'], logical: 3, weight: 1, single: 24, multi: 60 }],
    write: 1100, read: 1400, mem: 19,
  },
];

export interface GenOpts { days: number; seed: number; start: string }

const pad2 = (n: number) => String(n).padStart(2, '0');
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();

function gauss(u: () => number): number {
  const a = Math.max(u(), 1e-12);
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
}

function pickWeighted<T extends { weight: number }>(xs: T[], r: number): T {
  const total = xs.reduce((a, x) => a + x.weight, 0);
  let acc = 0;
  for (const x of xs) {
    acc += x.weight / total;
    if (r < acc) return x;
  }
  return xs[xs.length - 1];
}

interface RunCtx {
  seed: number;
  slotIso: string;
  slotMs: number;
  runId: number;
  weekday: number;
  hour: number;
  drift: number;
  peak: number;
  rolloutShare: number;
}

function sampleOf(cfg: Config, rep: number, run: RunCtx): RawSample {
  const id = `${run.runId}.1.${cfg.label}.${rep}`;
  const u = uniformStream(`${run.seed}|${id}`);
  const cpu = pickWeighted(cfg.cpus, u());
  const region = pickWeighted(cfg.regions, u()).region;
  const imds = u() > 0.08;
  const v2 = cfg.rollout && u() < run.rolloutShare;

  const queue = Math.max(0.5, 4 + 14 * run.peak + (run.weekday < 5 ? 3 : 0)) * (0.5 + u()) + (u() < 0.03 ? 60 + 120 * u() : 0);
  const createdMs = run.slotMs + Math.round(run.drift * 1000);
  const queuedMs = createdMs + 1000;
  const startedMs = queuedMs + Math.round(queue * 1000);

  // Steal is drawn first; benchmark scores fall with it, so z and steal correlate negatively on Linux.
  const steal = cfg.linux ? 0.3 + 2.5 * u() ** 3 + (u() < 0.02 ? 6 * u() : 0) : null;
  const stealFactor = 1 - 0.012 * (steal ?? 0);
  const imageFactor = v2 ? 1.06 : 1; // a newer runner image is measurably faster
  const truncDisk = u() < 0.004;
  const truncNet = u() < 0.002;
  const truncMulti = u() < 0.003;
  const benchMs = 9000 + Math.round(4000 * u());

  const single = cpu.single * (1 + 0.03 * gauss(u)) * stealFactor * imageFactor;
  const multi = cpu.multi * (1 + 0.04 * gauss(u)) * (1 - 0.01 * (steal ?? 0));
  const truncated: RawSample['bench']['truncated'] = [];
  if (truncDisk) truncated.push('disk');
  if (truncNet) truncated.push('net');
  if (truncMulti) truncated.push('multi');

  const place: RawSample['place'] = imds
    ? { imdsStatus: 'reachable', region, vmSize: 'Standard_D4ads_v5', inferredRegion: null, matchedCidr: null, method: 'imds' }
    : { imdsStatus: 'unreachable', region: null, vmSize: null, inferredRegion: region, matchedCidr: '20.42.0.0/16', method: 'cidr' };

  return {
    v: 1,
    id,
    src: 'synthetic',
    label: cfg.label,
    replica: rep,
    event: 'schedule',
    collectedAtIso: iso(startedMs + benchMs + 15_000),
    timing: {
      scheduledSlotIso: run.slotIso,
      runCreatedAtIso: iso(createdMs),
      jobQueuedAtIso: iso(queuedMs),
      jobStartedAtIso: iso(startedMs),
      cronDriftSec: r1((createdMs - run.slotMs) / 1000),
      queueTimeSec: r1((startedMs - queuedMs) / 1000),
      totalDelaySec: r1((startedMs - run.slotMs) / 1000),
    },
    env: {
      imageOS: cfg.imageOS,
      imageVersion: v2 ? '20261015.2' : '20260901.1',
      runnerOS: cfg.runnerOS,
      runnerArch: cfg.runnerArch,
      runnerEnvironment: 'github-hosted',
      agentVersion: '2.329.0',
    },
    os: cfg.os,
    cpu: {
      model: cpu.model,
      vendor: cpu.vendor,
      logical: cpu.logical,
      physical: Math.max(1, Math.floor(cpu.logical / 2)),
      // The schema requires an empty flags list for the Windows labels.
      flags: cfg.label.startsWith('windows') ? [] : cpu.flags.slice(0, 12),
    },
    memGB: cfg.memGB,
    disk: {
      totalGB: 256,
      freeGB: r1(40 + 60 * u()),
      kind: cfg.disk,
      fs: cfg.fs,
    },
    place,
    uptimeSec: Math.round(60 + 900 * u()),
    stealPct: steal === null ? null : r2(steal),
    bench: {
      benchmarkDurationMs: benchMs,
      singleCoreScore: r2(single),
      multiCoreScore: truncMulti ? null : r2(multi),
      seqWriteMBs: truncDisk ? null : r1(cfg.write * (1 + 0.05 * gauss(u))),
      seqReadMBs: truncDisk ? null : r1(cfg.read * (1 + 0.05 * gauss(u))),
      memBandwidthGBs: r2(cfg.mem * (1 + 0.03 * gauss(u))),
      netTtfbMs: truncNet ? null : r1(45 + 20 * -Math.log(Math.max(u(), 1e-9))),
      netMbps: truncNet ? null : r1(320 + 40 * gauss(u)),
      netProbe: truncNet ? null : 'repo',
      truncated,
    },
  };
}

// Pure: returns every synthetic sample for the window, sorted, each schema-checked.
export function generate(opts: GenOpts): RawSample[] {
  const { days, seed, start } = opts;
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error(`days must be an integer 0..365, got ${days}`);
  const out: RawSample[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const rolloutShare = clamp((d - 20) / 35, 0, 1);
    for (let h = 0; h < 24; h++) {
      const slotIso = `${date}T${pad2(h)}:17:00Z`;
      const slotMs = utcMs(slotIso);
      if (uniformStream(`${seed}|skip|${slotIso}`)() < 0.01) continue; // a dropped sweep
      const runId = 10_000 + d * 24 + h;
      const weekday = weekdayOf(slotIso);
      const ru = uniformStream(`${seed}|run|${runId}`);
      const diurnal = 0.5 + 0.5 * Math.sin((2 * Math.PI * (h - 9)) / 24);
      const drift = Math.max(0, 0.8 + 1.4 * diurnal + (weekday < 5 ? 0.4 : -0.3) + 0.5 * ru());
      const run: RunCtx = {
        seed, slotIso, slotMs, runId, weekday, hour: h, drift,
        peak: Math.exp(-((h - 15) ** 2) / 18), rolloutShare,
      };
      for (const cfg of CONFIGS) {
        for (let rep = 1; rep <= cfg.replicas; rep++) out.push(sampleOf(cfg, rep, run));
      }
    }
  }
  const sorted = sortSamples(out);
  for (const s of sorted) {
    const reason = sampleSchemaError(s);
    if (reason !== null) throw new Error(`generated sample ${s.id} fails its schema: ${reason}`);
  }
  return sorted;
}

// Writes raw/ and rollups/ under out. Refuses any target inside the repo's data/.
export function writeSynthetic(opts: GenOpts, out: string): { samples: number; days: number } {
  const target = resolve(out);
  const rel = relative(REPO_DATA, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`refusing to write under repo data/: ${target}`);
  const samples = generate(opts);
  writeRaw(join(target, 'raw'), samples);
  const built = buildRollups(samples, loadCoords(), 'synthetic');
  writeRollups(join(target, 'rollups'), built);
  return { samples: samples.length, days: opts.days };
}

function parseArgs(argv: string[]): { days: number; seed: number; start: string; out: string } {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const out = get('--out');
  if (!out) throw new Error('--out <dir> is required');
  return {
    days: Number(get('--days') ?? '0'),
    seed: Number(get('--seed') ?? '1'),
    start: get('--start') ?? '2026-09-01',
    out,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { out, ...opts } = parseArgs(process.argv.slice(2));
    const res = writeSynthetic(opts, out);
    console.log(`synthetic: ${res.samples} samples over ${res.days} days -> ${out}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
