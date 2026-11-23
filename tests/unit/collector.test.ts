import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { RawSample } from '../../shared/types/sample.ts';
import { assembleSample, benchEnvFor, labelForHost, pickEnv, readMatrix } from '../../collector/src/collect.ts';
import { Deadline, MIN_STEP_MS, netStep } from '../../collector/src/benchmarks.ts';
import {
  blockDeviceOf, flagsFromSysctl, linuxDiskKind, normalizeFlags, parseCpuinfo, parseDiskutil, parseLscpu, parseOsRelease,
  parseProcStat, parseSwVers, parseSysctlKv, parseWinDisk, stealPct, vendorFromBrand,
} from '../../collector/src/hardware.ts';
import { scanForLeaks } from '../../collector/src/privacy.ts';
import { cidrContains, fetchImds, inferFromEgress, longestMatch, parseCidr, parseIp, parseTraceIp, readPlacement } from '../../collector/src/region.ts';
import { selfCheck } from '../../collector/src/selfcheck.ts';
import { NULL_TIMING, buildTiming, cronDriftSec, scheduledSlotIso, totalDelaySec } from '../../collector/src/timing.ts';

type FetchFn = typeof fetch;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Linux parsers', () => {
  it('reads an x86 /proc/cpuinfo block with allowlisted, sorted flags', () => {
    const text = [
      'processor\t: 0', 'vendor_id\t: GenuineIntel', 'model name\t: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz',
      'flags\t\t: fpu sse4_2 avx avx2 avx512f avx512_vnni bmi2 fma aes sha_ni nosuchflag',
    ].join('\n');
    const info = parseCpuinfo(text);
    expect(info.model).toBe('Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz');
    expect(info.vendor).toBe('Intel');
    expect(info.flags).toEqual(['aes', 'avx', 'avx2', 'avx512f', 'avx512vnni', 'bmi2', 'fma', 'sha_ni', 'sse4_2']);
  });

  it('reads an arm64 (Neoverse) cpuinfo block via Features and CPU implementer', () => {
    const text = [
      'processor\t: 0', 'BogoMIPS\t: 2000.00',
      'Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 sve asimdfhm dit uscat ilrcpc flagm ssbs sb paca pacg dcpodp sve2 sveaes svepmull svebitperm svesha3 svesm4 flagm2 frint svei8mm svebf16 i8mm bf16 dgh rng bti',
      'CPU implementer\t: 0x41', 'CPU architecture: 8', 'CPU variant\t: 0x0', 'CPU part\t: 0xd4f', 'CPU revision\t: 1',
    ].join('\n');
    const info = parseCpuinfo(text);
    expect(info.model).toBeNull();
    expect(info.vendor).toBe('Arm');
    // Linux reports LSE as `atomics`.
    expect(info.flags).toEqual(['aes', 'asimd', 'lse', 'sve', 'sve2']);
  });

  it('caps flags at 12', () => {
    expect(normalizeFlags(Array.from({ length: 20 }, (_, i) => ['avx', 'avx2', 'fma', 'aes', 'lse', 'sve', 'sve2', 'asimd', 'bmi2', 'avx512f', 'sse4_2', 'sha_ni', 'amx_tile', 'avx512bw'][i % 14]))).toHaveLength(12);
  });

  it('falls back to lscpu for the model and physical core count', () => {
    const text = 'Architecture: aarch64\nVendor ID: ARM\nModel name: Neoverse-N1\nSocket(s): 1\nCore(s) per socket: 4\n';
    expect(parseLscpu(text)).toEqual({ model: 'Neoverse-N1', vendorId: 'ARM', physical: 4 });
    expect(parseLscpu('Model name: x\n').physical).toBeNull();
  });

  it('computes CPU steal from the /proc/stat delta', () => {
    const before = parseProcStat('cpu  100 0 50 800 0 0 0 10 0 0\ncpu0 1 1 1 1\n');
    const after = parseProcStat('cpu  200 0 100 1500 0 0 0 40 0 0\n');
    expect(before).toEqual({ steal: 10, total: 960 });
    expect(stealPct(before, after)).toBe(3.41);
    expect(stealPct(after, after)).toBeNull();
    expect(stealPct(null, after)).toBeNull();
  });

  it('parses os-release, linux disks and block device names', () => {
    expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n')).toBe('Ubuntu 24.04.3 LTS');
    expect(blockDeviceOf('/dev/nvme0n1p2')).toBe('nvme0n1');
    expect(blockDeviceOf('/dev/sda1')).toBe('sda');
    expect(blockDeviceOf('overlay')).toBeNull();
    expect(linuxDiskKind('nvme0n1', '0', 'Samsung SSD')).toBe('nvme');
    expect(linuxDiskKind('sda', '1', 'ST4000')).toBe('hdd');
    expect(linuxDiskKind('sda', '0', 'Virtual Disk')).toBe('virtual');
  });
});

describe('macOS parsers', () => {
  it('reads sysctl brand, physical cores and hw.optional flags', () => {
    // Lines from `sysctl hw.optional` on Apple silicon (M-series), plus one disabled x86 key.
    const kv = parseSysctlKv([
      'hw.optional.arm.FEAT_CRC32: 1', 'hw.optional.arm.FEAT_SHA3: 1', 'hw.optional.arm.FEAT_LSE: 1', 'hw.optional.arm.FEAT_SHA256: 1',
      'hw.optional.arm.FEAT_AES: 1', 'hw.optional.arm.FEAT_LSE2: 1', 'hw.optional.arm.AdvSIMD: 1', 'hw.optional.arm.FEAT_SME: 1',
      'hw.optional.neon: 1', 'hw.optional.armv8_1_atomics: 1', 'hw.optional.bmi2: 0', 'hw.physicalcpu: 10',
    ].join('\n'));
    expect(kv['hw.physicalcpu']).toBe('10');
    expect(flagsFromSysctl(kv)).toEqual(['aes', 'asimd', 'lse']);
    expect(vendorFromBrand('Apple M2 Pro')).toBe('Apple');
  });

  it('reads diskutil SSD, HDD and virtual disks', () => {
    const apple = '   Device Node:  /dev/disk3s1s1\n   Type (Bundle):  apfs\n   Protocol:  Apple Fabric\n   Solid State:  Yes\n';
    expect(parseDiskutil(apple)).toEqual({ kind: 'nvme', fs: 'apfs' });
    expect(parseDiskutil('   Protocol:  SATA\n   Solid State:  No\n   Type (Bundle):  HFS\n')).toEqual({ kind: 'hdd', fs: 'hfs' });
    expect(parseDiskutil('   Device / Media Name:  Apple Virtual Disk\n   Solid State:  Yes\n').kind).toBe('virtual');
  });

  it('reads sw_vers and rejects other text', () => {
    expect(parseSwVers('15.6.1\n')).toBe('15.6.1');
    expect(parseSwVers('<html>oops</html>')).toBeNull();
  });
});

describe('Windows parsers', () => {
  it('reads Get-PhysicalDisk JSON as object or array', () => {
    expect(parseWinDisk('[{"MediaType":"SSD","BusType":"NVMe","FriendlyName":"x"}]')).toEqual({ kind: 'nvme' });
    expect(parseWinDisk('{"MediaType":"HDD","BusType":"SATA"}')).toEqual({ kind: 'hdd' });
    expect(parseWinDisk('{"MediaType":"SSD","BusType":"Virtual"}')).toEqual({ kind: 'virtual' });
    expect(parseWinDisk('not json')).toEqual({ kind: 'unknown' });
  });
});

describe('CIDR matching and IP parsing', () => {
  const table = [
    { cidr: '20.0.0.0/8', region: 'azure-generic' },
    { cidr: '20.42.0.0/16', region: 'eastus' },
    { cidr: '20.42.7.0/24', region: 'eastus2' },
    { cidr: '20.42.7.9/32', region: 'bogus' },
    { cidr: '2603:1030::/32', region: 'v6' },
  ];

  it('picks the longest prefix', () => {
    expect(longestMatch('20.42.7.100', table)).toEqual({ cidr: '20.42.7.0/24', region: 'eastus2' });
    expect(longestMatch('20.42.9.1', table)).toEqual({ cidr: '20.42.0.0/16', region: 'eastus' });
    expect(longestMatch('20.1.1.1', table)).toEqual({ cidr: '20.0.0.0/8', region: 'azure-generic' });
    expect(longestMatch('2603:1030:1::5', table)?.region).toBe('v6');
  });

  it('rejects /32 and /128 ranges and never matches them', () => {
    expect(parseCidr('20.42.7.9/32')).toBeNull();
    expect(parseCidr('2001:db8::1/128')).toBeNull();
    expect(longestMatch('20.42.7.9', [{ cidr: '20.42.7.9/32', region: 'bogus' }])).toBeNull();
  });

  it('treats IPv4 and IPv6 as separate families and rejects non-IPs without echoing them', () => {
    expect(cidrContains(parseIp('10.0.0.1')!, parseCidr('10.0.0.0/8')!)).toBe(true);
    expect(cidrContains(parseIp('::ffff:10.0.0.1')!, parseCidr('10.0.0.0/8')!)).toBe(false);
    expect(parseIp('999.1.1.1')).toBeNull();
    expect(parseIp('not-an-ip')).toBeNull();
    expect(parseTraceIp('fl=1\nip=20.42.7.100\nts=1\n')).toBe('20.42.7.100');
    expect(parseTraceIp('fl=1\nip=garbage\n')).toBeNull();
  });
});

describe('IMDS and egress placement', () => {
  it('times out IMDS as unreachable', async () => {
    const hangs: FetchFn = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const started = Date.now();
    const result = await fetchImds(hangs, 50);
    expect(result).toEqual({ imdsStatus: 'unreachable', region: null, vmSize: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads location and vmSize from IMDS and sends the Metadata header', async () => {
    let seen: Headers | undefined;
    const ok: FetchFn = async (_url, init) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ compute: { location: 'eastus', vmSize: 'Standard_D2ads_v5', name: 'dropped' } });
    };
    const place = await readPlacement({ fetchFn: ok });
    expect(seen?.get('Metadata')).toBe('true');
    expect(place).toEqual({ imdsStatus: 'reachable', region: 'eastus', vmSize: 'Standard_D2ads_v5', inferredRegion: null, matchedCidr: null, method: 'imds' });
  });

  it('infers a region from the egress IP only when IMDS fails', async () => {
    const fake: FetchFn = async (url) => {
      const u = String(url);
      if (u.includes('169.254.169.254')) throw new Error('unreachable');
      if (u.includes('1.1.1.1')) return new Response('fl=1\nip=20.42.7.100\n');
      return jsonResponse({ actions: ['4.148.0.0/16'], actions_macos: [] });
    };
    const table = [{ cidr: '20.42.0.0/16', region: 'eastus' }];
    const place = await readPlacement({ fetchFn: fake });
    expect(place).toMatchObject({ imdsStatus: 'unreachable', region: null, vmSize: null, method: 'cidr' });
    expect(place.matchedCidr).toMatch(/\/\d+$/);
    const direct = await inferFromEgress({ fetchFn: fake, table });
    expect(direct).toEqual({ method: 'cidr', matchedCidr: '20.42.0.0/16', inferredRegion: 'eastus' });
  });

  it('reports none when the egress IP matches nothing', async () => {
    const fake: FetchFn = async (url) => (String(url).includes('1.1.1.1')
      ? new Response('ip=192.0.2.9\n')
      : jsonResponse({ actions: ['4.148.0.0/16'] }));
    expect(await inferFromEgress({ fetchFn: fake, table: [{ cidr: '20.0.0.0/8', region: 'x' }] })).toEqual({ method: 'none', matchedCidr: null, inferredRegion: null });
  });
});

describe('Deadline', () => {
  it('caps each step and keeps a 250 ms reserve', () => {
    const d = new Deadline(0, 20_000);
    expect(d.budget(2500, 0)).toBe(2500);
    expect(d.budget(6000, 0)).toBe(6000);
    expect(d.budget(2500, 19_600)).toBe(150);
    expect(d.budget(2500, 19_600) < MIN_STEP_MS).toBe(true);
  });

  it('shrinks the last steps as the ceiling nears', () => {
    const d = new Deadline(1_000, 20_000);
    expect(d.budget(3500, 15_000)).toBe(3500);
    expect(d.budget(3500, 19_000)).toBe(1750);
  });
});

describe('timing math', () => {
  it('finds the latest HH:17 slot at or before run creation', () => {
    expect(scheduledSlotIso('2026-11-22T16:18:05Z')).toBe('2026-11-22T16:17:00.000Z');
    expect(scheduledSlotIso('2026-11-22T17:02:30Z')).toBe('2026-11-22T16:17:00.000Z');
    expect(scheduledSlotIso('2026-11-22T16:17:00Z')).toBe('2026-11-22T16:17:00.000Z');
    expect(scheduledSlotIso('2026-11-22T00:05:00Z')).toBe('2026-11-21T23:17:00.000Z');
  });

  it('computes drift, queue and total delay', () => {
    const slot = scheduledSlotIso('2026-11-22T16:18:05Z');
    expect(cronDriftSec('2026-11-22T16:18:05Z', slot)).toBe(65);
    expect(totalDelaySec('2026-11-22T16:18:30Z', slot)).toBe(90);
    const t = buildTiming({
      event: 'schedule', runCreatedIso: '2026-11-22T16:18:05Z', jobQueuedIso: '2026-11-22T16:18:10Z', jobStartedIso: '2026-11-22T16:18:30Z',
    });
    expect(t).toMatchObject({ scheduledSlotIso: slot, cronDriftSec: 65, queueTimeSec: 20, totalDelaySec: 90 });
  });

  it('keeps slot, drift and total delay null for dispatch runs', () => {
    const t = buildTiming({
      event: 'workflow_dispatch', runCreatedIso: '2026-11-22T16:18:05Z', jobQueuedIso: '2026-11-22T16:18:10Z', jobStartedIso: '2026-11-22T16:18:30Z',
    });
    expect(t.scheduledSlotIso).toBeNull();
    expect(t.cronDriftSec).toBeNull();
    expect(t.totalDelaySec).toBeNull();
    expect(t.queueTimeSec).toBe(20);
  });
});

describe('network probe', () => {
  it('takes the repo probe on exact 1 MiB, and falls back to meta on content-encoding', async () => {
    const repoBody = Buffer.alloc(1_048_576, 7);
    const calls: string[] = [];
    const repoOk: FetchFn = async (url) => {
      calls.push(String(url));
      if (String(url).includes('raw.githubusercontent.com')) return new Response(repoBody, { status: 200 });
      return new Response('zen', { status: 200 });
    };
    const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'abc123', GITHUB_TOKEN: 'tok' };
    const ok = await netStep({ budgetMs: 4000, env, fetchFn: repoOk });
    expect(ok.netProbe).toBe('repo');
    expect(ok.netMbps).toBeGreaterThan(0);
    expect(ok.netTtfbMs).not.toBeNull();

    const gz: FetchFn = async (url) => {
      if (String(url).includes('raw.githubusercontent.com')) return new Response(repoBody, { status: 200, headers: { 'content-encoding': 'gzip' } });
      if (String(url).includes('/meta')) return new Response('x'.repeat(1000), { status: 200 });
      return new Response('zen', { status: 200 });
    };
    const fallback = await netStep({ budgetMs: 4000, env, fetchFn: gz });
    expect(fallback.netProbe).toBe('meta');
  });

  it('benchEnvFor strips GITHUB_REPOSITORY and GITHUB_SHA only for local runs', () => {
    const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc', GITHUB_TOKEN: 'tok' };
    const local = benchEnvFor(env, true);
    expect(local.GITHUB_REPOSITORY).toBeUndefined();
    expect(local.GITHUB_SHA).toBeUndefined();
    expect(local.GITHUB_TOKEN).toBe('tok');
    const live = benchEnvFor(env, false);
    expect(live).toEqual(env);
    expect(live).toBe(env);
  });

  it('local netStep takes the meta probe even when GITHUB_REPOSITORY and GITHUB_SHA are set', async () => {
    const urls: string[] = [];
    const fake: FetchFn = async (url) => {
      urls.push(String(url));
      if (String(url).includes('/meta')) return new Response('x'.repeat(1000), { status: 200 });
      return new Response('zen', { status: 200 });
    };
    const net = await netStep({ budgetMs: 4000, env: benchEnvFor({ GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc' }, true), fetchFn: fake });
    expect(net.netProbe).toBe('meta');
    expect(urls.some((u) => u.includes('raw.githubusercontent.com'))).toBe(false);
  });
});

describe('privacy scanner and self-check', () => {
  const sampleParts = (): Omit<RawSample, 'v'> => ({
    id: '12345.1.ubuntu-24.04.1',
    src: 'live',
    label: 'ubuntu-24.04',
    replica: 1,
    event: 'schedule',
    collectedAtIso: '2026-11-22T16:18:40.123Z',
    timing: buildTiming({
      event: 'schedule', runCreatedIso: '2026-11-22T16:18:05Z', jobQueuedIso: '2026-11-22T16:18:10Z', jobStartedIso: '2026-11-22T16:18:30Z',
    }),
    env: { ...pickEnv({ ImageOS: 'ubuntu24', ImageVersion: '20260101.1', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', RUNNER_ENVIRONMENT: 'github-hosted' }), agentVersion: '2.329.0' },
    os: { name: 'Linux', version: 'Ubuntu 24.04.3 LTS', kernel: '6.11.0-1018-azure' },
    cpu: { model: 'AMD EPYC 7763 64-Core Processor', vendor: 'AMD', logical: 4, physical: 2, flags: ['avx', 'avx2'] },
    memGB: 15.6,
    disk: { totalGB: 72, freeGB: 60.1, kind: 'nvme', fs: 'ext4' },
    place: { imdsStatus: 'reachable', region: 'eastus', vmSize: 'Standard_D4ads_v5', inferredRegion: null, matchedCidr: null, method: 'imds' },
    uptimeSec: 120,
    stealPct: 0.42,
    bench: {
      benchmarkDurationMs: 14_000, singleCoreScore: 812.4, multiCoreScore: 3100.5, seqWriteMBs: 900.1, seqReadMBs: 2100.6,
      memBandwidthGBs: 18.25, netTtfbMs: 24.5, netMbps: 80.3, netProbe: 'repo', truncated: [],
    },
  });

  it('a complete legitimate sample has zero findings and passes schema validation', () => {
    const sample = assembleSample(sampleParts());
    expect(scanForLeaks(sample)).toEqual([]);
    const text = JSON.stringify(sample);
    expect(selfCheck(text)).toEqual([]);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1600);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const schema = JSON.parse(readFileSync(new URL('../../schemas/raw-sample.schema.json', import.meta.url), 'utf8'));
    const validate = ajv.compile(schema);
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
  });

  it('flags IP literals, secrets and home paths but not timestamps', () => {
    expect(scanForLeaks({ os: { version: '10.0.0.1' } })).toEqual(['ip-literal:os.version']);
    expect(scanForLeaks({ cpu: { vendor: 'fe80::1' } })).toEqual(['ip-literal:cpu.vendor']);
    expect(scanForLeaks({ x: 'token=ghs_SECRETVALUE' }, { secrets: ['ghs_SECRETVALUE'] })).toEqual(['secret:x']);
    expect(scanForLeaks({ os: { kernel: '/Users/alice/work' } }, { homeDir: '/Users/alice' })).toEqual(['home-path:os.kernel']);
    expect(scanForLeaks({ collectedAtIso: '2026-11-22T16:18:40Z' })).toEqual([]);
  });

  it('self-check rejects extra keys, oversize output and over-budget benchmarks', () => {
    const base = JSON.parse(JSON.stringify(assembleSample(sampleParts())));
    expect(selfCheck(JSON.stringify({ ...base, extra: 1 }))).toContain('extra:.extra');
    expect(selfCheck(JSON.stringify({ ...base, os: { ...base.os, kernel: 'k'.repeat(2100) } }))).toEqual(expect.arrayContaining([expect.stringMatching(/^too-large/)]));
    base.bench.benchmarkDurationMs = 20_001;
    expect(selfCheck(JSON.stringify(base))).toContain('bad:bench.benchmarkDurationMs');
  });
});

describe('parsers on missing or odd input', () => {
  it('never throw on empty or garbage text', () => {
    for (const text of ['', 'garbage\n\x00:::\n', ':\n=\n{']) {
      expect(() => {
        parseCpuinfo(text); parseLscpu(text); parseProcStat(text); parseSysctlKv(text); flagsFromSysctl(parseSysctlKv(text));
        parseDiskutil(text); parseSwVers(text); parseOsRelease(text); blockDeviceOf(text); parseWinDisk(text);
      }).not.toThrow();
    }
    expect(parseCpuinfo('')).toEqual({ model: null, vendor: 'unknown', flags: [] });
    expect(parseProcStat('cpu  1 2 3\n')).toBeNull();
    expect(parseWinDisk('null')).toEqual({ kind: 'unknown' });
    expect(parseWinDisk('[]')).toEqual({ kind: 'unknown' });
  });

  it('clamps stealPct to 0..100 when counters move oddly', () => {
    expect(stealPct({ steal: 50, total: 100 }, { steal: 40, total: 200 })).toBe(0);
  });
});

describe('every path is schema-valid', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/raw-sample.schema.json', import.meta.url), 'utf8')));
  const fails: FetchFn = async () => { throw new Error('offline'); };
  const base = (): Omit<RawSample, 'v'> => ({
    id: '9.1.windows-2025.2', src: 'live', label: 'windows-2025', replica: 2, event: 'workflow_dispatch',
    collectedAtIso: '2026-11-22T16:18:40.123Z',
    timing: buildTiming({ event: 'workflow_dispatch', runCreatedIso: '2026-11-22T16:18:05Z', jobQueuedIso: '2026-11-22T16:18:10Z', jobStartedIso: '2026-11-22T16:18:30Z' }),
    env: { ...pickEnv({}), agentVersion: null },
    os: { name: 'Windows', version: 'Windows Server 2025 Datacenter', kernel: '10.0.26100' },
    cpu: { model: 'AMD EPYC 7763 64-Core Processor', vendor: 'AMD', logical: 4, physical: null, flags: [] },
    memGB: 16, disk: { totalGB: 150, freeGB: 90, kind: 'unknown', fs: null },
    place: { imdsStatus: 'unreachable', region: null, vmSize: null, inferredRegion: null, matchedCidr: null, method: 'none' },
    uptimeSec: 0, stealPct: null,
    bench: {
      benchmarkDurationMs: 20_000, singleCoreScore: null, multiCoreScore: null, seqWriteMBs: null, seqReadMBs: null,
      memBandwidthGBs: null, netTtfbMs: null, netMbps: null, netProbe: null, truncated: ['single', 'multi', 'disk', 'mem', 'net'],
    },
  });
  const agree = (sample: RawSample) => {
    const text = JSON.stringify(sample);
    expect(validate(JSON.parse(text)), JSON.stringify(validate.errors)).toBe(true);
    expect(selfCheck(text)).toEqual([]);
  };

  it('all probes failed: placement none, net null, every step truncated', async () => {
    const place = await readPlacement({ fetchFn: fails });
    const net = await netStep({ budgetMs: 300, env: { GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc' }, fetchFn: fails });
    expect(net).toMatchObject({ netTtfbMs: null, netMbps: null, netProbe: null });
    agree(assembleSample({ ...base(), place }));
  });

  it('a /meta-only cidr hit carries no region', async () => {
    const fake: FetchFn = async (url) => (String(url).includes('1.1.1.1')
      ? new Response('ip=4.148.1.2\n')
      : String(url).includes('169.254') ? Promise.reject(new Error('x')) : jsonResponse({ actions: ['4.148.0.0/16', '4.148.1.2/32'] }));
    const place = await readPlacement({ fetchFn: fake, table: [] });
    expect(place).toMatchObject({ method: 'cidr', matchedCidr: '4.148.0.0/16', inferredRegion: null });
    agree(assembleSample({ ...base(), place }));
  });

  it('local run and over-long free text are clamped to the schema', () => {
    const sample = assembleSample({
      ...base(), id: 'local.1795390988680.windows-2025.1', src: 'local', event: 'local', replica: 1, timing: NULL_TIMING,
      env: { imageOS: 'x'.repeat(65), imageVersion: '20260101.1', runnerOS: 'Windows', runnerArch: 'X64', runnerEnvironment: 'github-hosted', agentVersion: '2.329.0' },
      os: { name: 'Windows', version: 'v'.repeat(200), kernel: 'k'.repeat(200) },
      cpu: { model: 'm'.repeat(200), vendor: 'AMD', logical: 4, physical: null, flags: [] },
      disk: { totalGB: 150, freeGB: 90, kind: 'virtual', fs: 'f'.repeat(40) },
    });
    expect(sample.env.imageOS).toBeNull();
    expect(sample.os.version).toHaveLength(64);
    agree(sample);
  });

  it('self-check fails above 1600 bytes (SPEC 2)', () => {
    const sample = assembleSample(base());
    const pad = 1601 - Buffer.byteLength(JSON.stringify(sample)) + sample.os.version.length;
    const big = JSON.stringify({ ...sample, os: { ...sample.os, version: 'v'.repeat(Math.min(64, pad)), name: 'n'.repeat(Math.max(1, pad - 64 + 7)) } });
    expect(Buffer.byteLength(big)).toBeGreaterThan(1600);
    expect(selfCheck(big)).toEqual(expect.arrayContaining([expect.stringMatching(/^too-large/)]));
  });

  it('self-check rejects a /32 matchedCidr like the schema does', () => {
    const sample = assembleSample({ ...base(), place: { imdsStatus: 'unreachable', region: null, vmSize: null, inferredRegion: null, matchedCidr: '4.148.1.2/32', method: 'cidr' } });
    expect(validate(sample)).toBe(false);
    expect(selfCheck(JSON.stringify(sample))).toContain('bad:place.matchedCidr');
  });
});

describe('guardrails', () => {
  const srcFiles = readdirSync(new URL('../../collector/src/', import.meta.url))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, text: readFileSync(new URL(`../../collector/src/${f}`, import.meta.url), 'utf8') }));

  it('never calls os.hostname(), never uses a shell, and imports only node built-ins or shared types', () => {
    for (const { name, text } of srcFiles) {
      expect(text, name).not.toMatch(/hostname\(/);
      expect(text, name).not.toMatch(/shell:\s*true/);
      expect(text, name).not.toMatch(/from ['"](?!node:|\.\.?\/)[^'"]+['"]/);
    }
  });

  it('reads only allowlisted or pipeline environment variables', () => {
    const allowed = new Set(['ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'RUNNER_TEMP', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_EVENT_NAME', 'GITHUB_ACTIONS']);
    for (const { name, text } of srcFiles) {
      for (const m of text.matchAll(/env\.([A-Za-z_]+)|env\[['"]([A-Za-z_]+)['"]\]|env\.\w+\s*\?\?\s*null/g)) {
        const key = m[1] ?? m[2];
        if (key) expect(allowed.has(key), `${name} reads ${key}`).toBe(true);
      }
    }
  });

  it('pickEnv keeps only the five allowlisted variables', () => {
    const picked = pickEnv({ ImageOS: 'ubuntu24', SECRET_THING: 'nope', HOME: '/Users/x', GITHUB_TOKEN: 'nope' });
    expect(Object.keys(picked).sort()).toEqual(['imageOS', 'imageVersion', 'runnerArch', 'runnerEnvironment', 'runnerOS']);
    expect(picked.imageOS).toBe('ubuntu24');
    expect(picked.imageVersion).toBeNull();
  });

  it('matrix maps this host to a label and covers the six runner labels', () => {
    const matrix = readMatrix();
    expect(labelForHost(matrix, 'darwin', 'arm64')).toBe('macos-15');
    expect(labelForHost(matrix, 'linux', 'x64')).toBe('ubuntu-24.04');
    expect(labelForHost(matrix, 'darwin', 'x64')).toBe('macos-15-intel');
    expect(matrix.map((m) => m.label)).toHaveLength(6);
    expect(matrix.reduce((n, m) => n + m.replicas, 0)).toBe(11);
  });

  it('vendor and version helpers', () => {
    expect(vendorFromBrand('Intel(R) Xeon(R)')).toBe('Intel');
    expect(vendorFromBrand('Cobalt 100')).toBe('Microsoft');
    expect(vendorFromBrand('Mystery CPU')).toBe('unknown');
    expect(vendorFromBrand(null)).toBe('unknown');
  });
});
