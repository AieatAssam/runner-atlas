// Hardware, OS, disk and agent facts (SPEC 3.3, 3.5). Parsers are pure; readers wrap fixed-argv subprocesses.
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, statfsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RawSample } from '../../shared/types/sample.ts';

export type CpuFlag = RawSample['cpu']['flags'][number];
export type DiskKind = RawSample['disk']['kind'];

export const SUBPROCESS_TIMEOUT_MS = 3000;

// Fixed argv only, no shell. Resolves to stdout, or null on error, timeout or non-zero exit.
export function run(file: string, args: string[], timeoutMs = SUBPROCESS_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

const FLAG_ALLOWLIST: readonly string[] = [
  'avx', 'avx2', 'avx512f', 'avx512bw', 'avx512vnni', 'amx_tile', 'fma', 'bmi2', 'aes', 'sha_ni', 'sse4_2',
  'asimd', 'sve', 'sve2', 'lse',
];

// Keeps only allowlisted flags, sorted, unique, at most 12.
export function normalizeFlags(tokens: string[]): CpuFlag[] {
  // Linux spells two allowlisted flags differently: x86 `avx512_vnni`, arm64 `atomics` (LSE).
  const alias: Record<string, string> = { avx512_vnni: 'avx512vnni', atomics: 'lse' };
  const names = tokens.map((t) => alias[t] ?? t);
  const kept = [...new Set(names.filter((t) => FLAG_ALLOWLIST.includes(t)))].sort();
  return kept.slice(0, 12) as CpuFlag[];
}

export function vendorFromBrand(brand: string | null | undefined): string {
  if (!brand) return 'unknown';
  const table: Array<[RegExp, string]> = [
    [/Intel/i, 'Intel'], [/AMD/i, 'AMD'], [/Apple/i, 'Apple'], [/Ampere/i, 'Ampere'], [/\bArm\b|Neoverse|Cortex/i, 'Arm'],
    [/Cobalt/i, 'Microsoft'],
  ];
  for (const [re, name] of table) if (re.test(brand)) return name;
  return 'unknown';
}

function field(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// /proc/cpuinfo: first processor block. x86 uses `flags`, arm64 uses `Features` and `CPU implementer`.
export function parseCpuinfo(text: string): { model: string | null; vendor: string; flags: CpuFlag[] } {
  const model = field(text, 'model name');
  const vendorId = field(text, 'vendor_id');
  const implementer = field(text, 'CPU implementer');
  const vendor = vendorId === 'GenuineIntel' ? 'Intel'
    : vendorId === 'AuthenticAMD' ? 'AMD'
      : implementer === '0x41' ? 'Arm'
        : implementer === '0xc0' ? 'Ampere'
          : vendorFromBrand(model);
  const flagLine = field(text, 'flags') ?? field(text, 'Features') ?? '';
  return { model, vendor, flags: normalizeFlags(flagLine.split(/\s+/).filter(Boolean)) };
}

// `lscpu` fallback (arm64 has no model name in cpuinfo). Physical cores = cores per socket x sockets.
export function parseLscpu(text: string): { model: string | null; vendorId: string | null; physical: number | null } {
  const num = (name: string): number | null => {
    const v = field(text, name);
    return v && /^\d+$/.test(v) ? Number(v) : null;
  };
  const perSocket = num('Core\\(s\\) per socket');
  const sockets = num('Socket\\(s\\)');
  return {
    model: field(text, 'Model name'),
    vendorId: field(text, 'Vendor ID'),
    physical: perSocket && sockets ? perSocket * sockets : null,
  };
}

// /proc/stat aggregate line. stealPct = 100 * d(steal) / d(user+nice+system+idle+iowait+irq+softirq+steal).
export function parseProcStat(text: string): { steal: number; total: number } | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 8 || f.some((n) => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = f;
  return { steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

export function stealPct(before: { steal: number; total: number } | null, after: { steal: number; total: number } | null): number | null {
  if (!before || !after) return null;
  const dTotal = after.total - before.total;
  if (dTotal <= 0) return null;
  const pct = Math.round((10000 * (after.steal - before.steal)) / dTotal) / 100;
  return Math.min(100, Math.max(0, pct));
}

export function parseSysctlKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:\s]+)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// `sysctl hw.optional` on macOS, mapped to the flag allowlist.
const SYSCTL_FLAGS: Record<string, CpuFlag> = {
  'hw.optional.avx1_0': 'avx', 'hw.optional.avx2_0': 'avx2', 'hw.optional.FMA': 'fma', 'hw.optional.bmi2': 'bmi2',
  'hw.optional.aes': 'aes', 'hw.optional.sse4_2': 'sse4_2', 'hw.optional.arm.FEAT_LSE': 'lse', 'hw.optional.arm.AdvSIMD': 'asimd',
  'hw.optional.arm.FEAT_AES': 'aes',
};

export function flagsFromSysctl(kv: Record<string, string>): CpuFlag[] {
  const tokens = Object.entries(kv)
    .filter(([key, value]) => value === '1' && key in SYSCTL_FLAGS)
    .map(([key]) => SYSCTL_FLAGS[key]);
  return normalizeFlags(tokens);
}

// `diskutil info /` on macOS.
export function parseDiskutil(text: string): { kind: DiskKind; fs: string | null } {
  const get = (name: string) => field(text, name);
  const media = `${get('Device / Media Name') ?? ''} ${get('Device Node') ?? ''}`;
  const solid = get('Solid State');
  const protocol = get('Protocol') ?? '';
  const fs = get('Type \\(Bundle\\)');
  let kind: DiskKind = 'unknown';
  if (/virtual/i.test(media) || /virtual/i.test(protocol)) kind = 'virtual';
  else if (solid === 'Yes') kind = /PCI|Fabric|NVM/i.test(protocol) ? 'nvme' : 'ssd';
  else if (solid === 'No') kind = 'hdd';
  return { kind, fs: fs ? fs.toLowerCase() : null };
}

export function parseSwVers(text: string): string | null {
  const v = text.trim();
  return /^\d+(\.\d+){0,2}$/.test(v) ? v : null;
}

export function parseOsRelease(text: string): string | null {
  const m = text.match(/^PRETTY_NAME=(.+)$/m);
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

// Reduces a findmnt SOURCE (`/dev/nvme0n1p2`, `/dev/sda1`) to its block device name, or null.
export function blockDeviceOf(source: string): string | null {
  const raw = source.trim();
  if (!raw.startsWith('/dev/')) return null;
  const name = raw.slice('/dev/'.length);
  const nvme = name.match(/^(nvme\d+n\d+)/);
  if (nvme) return nvme[1];
  const plain = name.match(/^([a-z]+)\d*$/);
  return plain ? plain[1] : null;
}

// Linux: /sys/block/<dev>/queue/rotational plus the device model.
export function linuxDiskKind(device: string, rotational: string | null, model: string | null): DiskKind {
  if (model && /virtual|msft|qemu|google/i.test(model)) return 'virtual';
  if (rotational === '1') return 'hdd';
  if (rotational === '0') return device.startsWith('nvme') ? 'nvme' : 'ssd';
  return 'unknown';
}

// Windows: Get-PhysicalDisk JSON (object or array).
export function parseWinDisk(json: string): { kind: DiskKind } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'unknown' };
  }
  const disk = (Array.isArray(parsed) ? parsed[0] : parsed) as { MediaType?: string; BusType?: string; FriendlyName?: string } | undefined;
  if (!disk) return { kind: 'unknown' };
  const bus = disk.BusType ?? '';
  if (/virtual|msft/i.test(bus) || /virtual|msft/i.test(disk.FriendlyName ?? '')) return { kind: 'virtual' };
  if (disk.MediaType === 'HDD') return { kind: 'hdd' };
  if (disk.MediaType === 'SSD') return { kind: /nvme/i.test(bus) ? 'nvme' : 'ssd' };
  return { kind: 'unknown' };
}

// Agent version (best effort, each attempt <= 2000 ms). Returns a bare semver or null. Runner paths are read in memory only.
const SEMVER = /^\d+\.\d+\.\d+$/;
const AGENT_ATTEMPT_MS = 2000;
const RUNNER_BIN = /^Runner\.(Worker|Listener)(?:\.dll)?$/;

export function compareSemver(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

// Pulls a `<semver>` segment out of an executable path, e.g. `.../2.338.2/bin/Runner.Worker` or `.../bin.2.338.2/...`.
export function semverFromPath(p: string): string | null {
  const m = p.match(/(?:^|[\\/])(?:bin\.|externals\.)?(\d+\.\d+\.\d+)(?:[\\/]|$)/);
  return m && SEMVER.test(m[1]) ? m[1] : null;
}

// /proc/<pid>/stat: the ppid is field 1 after the `)` that closes the command name.
export function parseProcStatPpid(statText: string): number | null {
  const close = statText.lastIndexOf(')');
  if (close < 0) return null;
  const ppid = statText.slice(close + 1).trim().split(/\s+/)[1];
  return ppid !== undefined && /^\d+$/.test(ppid) && Number(ppid) > 0 ? Number(ppid) : null;
}

// `ps -p <pid> -o ppid=,command=` output.
export function parsePsParentLine(line: string): { ppid: number; command: string } | null {
  const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
  return m ? { ppid: Number(m[1]), command: m[2] } : null;
}

function subdirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// Versions from `<root>/bin.<semver>` directories.
function binVersions(root: string): string[] {
  return subdirNames(root).map((n) => n.match(/^bin\.(\d+\.\d+\.\d+)$/)?.[1]).filter((v): v is string => v !== undefined);
}

// Version from the executable's own path, else from `<sibling> --version`.
async function versionFromExecutable(exePath: string, exeName: string): Promise<string | null> {
  const fromPath = semverFromPath(exePath);
  if (fromPath) return fromPath;
  const out = await run(join(dirname(exePath), exeName), ['--version'], AGENT_ATTEMPT_MS);
  const v = out?.trim().split('\n')[0]?.trim() ?? '';
  return SEMVER.test(v) ? v : null;
}

export async function readAgentVersion(opts: { home: string; runnerTemp: string | undefined; platform: NodeJS.Platform; ppid?: number; skipSystemPaths?: boolean }): Promise<string | null> {
  const { home, runnerTemp, platform } = opts;
  const exeName = platform === 'win32' ? 'Runner.Listener.exe' : 'Runner.Listener';
  const newest = (vs: string[]): string => vs.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));

  // 1a. Home-scoped scan first. A hit returns here, so host-global paths are never read.
  const homeScanned = [
    ...[join(home, 'runners'), join(home, 'agents')].flatMap(subdirNames),
    ...[join(home, 'actions-runner'), ...(runnerTemp ? [dirname(runnerTemp), dirname(dirname(runnerTemp))] : [])].flatMap(binVersions),
  ].filter((v) => SEMVER.test(v));
  if (homeScanned.length > 0) return newest(homeScanned);

  // 1b. Host-global system dirs, unless the caller opts out (tests on hosted CI).
  if (!opts.skipSystemPaths) {
    const systemScanned = [
      ...(platform === 'win32' ? ['C:\\agents', 'D:\\agents'] : ['/home/runner/runners', '/Users/runner/runners', '/opt/runner']).flatMap(subdirNames),
      ...(platform === 'win32' ? ['C:\\actions-runner'] : ['/home/runner/actions-runner', '/Users/runner/actions-runner', '/opt/actions-runner']).flatMap(binVersions),
    ].filter((v) => SEMVER.test(v));
    if (systemScanned.length > 0) return newest(systemScanned);
  }

  // 2. Active ancestor: a running Runner.Worker or Runner.Listener names its own install. Walk up at most 8 parents.
  let pid = opts.ppid ?? process.ppid;
  if (platform === 'linux') {
    for (let i = 0; i < 8 && pid > 1; i++) {
      const args = readOrNull(`/proc/${pid}/cmdline`)?.split('\0') ?? [];
      const hit = [readlinkOrNull(`/proc/${pid}/exe`), ...args].find((c): c is string => c !== null && RUNNER_BIN.test(basename(c)));
      if (hit) {
        const v = await versionFromExecutable(hit, 'Runner.Listener');
        if (v) return v;
      }
      const next = parseProcStatPpid(readOrNull(`/proc/${pid}/stat`) ?? '');
      if (next === null) break;
      pid = next;
    }
  } else if (platform === 'darwin') {
    for (let i = 0; i < 8 && pid > 1; i++) {
      const parsed = parsePsParentLine((await run('ps', ['-p', String(pid), '-o', 'ppid=,command='], 1000)) ?? '');
      if (!parsed) break;
      const m = parsed.command.match(/(?:^|\s)(\/\S*?\/Runner\.(?:Worker|Listener))(?:\s|$)/);
      if (m) {
        const v = await versionFromExecutable(m[1], 'Runner.Listener');
        if (v) return v;
      }
      pid = parsed.ppid;
    }
  } else if (platform === 'win32' && !opts.skipSystemPaths) {
    const exePath = (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='Runner.Worker.exe' OR Name='Runner.Listener.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath"], AGENT_ATTEMPT_MS))?.trim() ?? '';
    if (exePath) {
      const v = await versionFromExecutable(exePath, 'Runner.Listener.exe');
      if (v) return v;
    }
  }

  // 3. Direct `Runner.Listener --version` on the candidate roots.
  const systemRoot = platform === 'win32' ? 'C:\\actions-runner' : '/opt/actions-runner';
  const roots = [...new Set([runnerTemp ? dirname(runnerTemp) : null, runnerTemp ? dirname(dirname(runnerTemp)) : null, join(home, 'actions-runner'), ...(opts.skipSystemPaths ? [] : [systemRoot])].filter((r): r is string => r !== null))];
  for (const root of roots) {
    const out = await run(join(root, 'bin', exeName), ['--version'], AGENT_ATTEMPT_MS);
    const v = out?.trim().split('\n')[0]?.trim() ?? '';
    if (SEMVER.test(v)) return v;
  }
  return null;
}

function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

// Reads a whole file, or null when absent or unreadable.
export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Disk totals for the temp directory, in GB at one decimal.
export function diskSpace(): { totalGB: number; freeGB: number } {
  const s = statfsSync(tmpdir());
  const gb = (blocks: number | bigint) => Math.round((Number(blocks) * Number(s.bsize)) / 2 ** 30 * 10) / 10;
  return { totalGB: gb(s.blocks), freeGB: gb(s.bavail) };
}
