// Raw sample contract (SPEC 3.2), schema `runner-atlas/raw-sample@1`: schemas/raw-sample.schema.json.

export type RunnerLabel = 'ubuntu-24.04' | 'ubuntu-24.04-arm' | 'windows-2025' | 'windows-11-arm' | 'macos-15' | 'macos-15-intel';
export type DiskKind = 'nvme' | 'ssd' | 'hdd' | 'virtual' | 'unknown';

export interface RawSample {
  v: 1;
  id: string;                         // "<runId>.<runAttempt>.<label>.<replica>"; local: "local.<epochMs>.<label>.1"
  src: 'live' | 'local' | 'synthetic';
  label: RunnerLabel; replica: number;
  event: 'schedule' | 'workflow_dispatch' | 'local';
  collectedAtIso: string;
  timing: {
    scheduledSlotIso: string | null; runCreatedAtIso: string | null;
    jobQueuedAtIso: string | null; jobStartedAtIso: string | null;
    cronDriftSec: number | null; queueTimeSec: number | null; totalDelaySec: number | null;
  };
  env: { imageOS: string | null; imageVersion: string | null; runnerOS: string | null; runnerArch: string | null; runnerEnvironment: string | null; agentVersion: string | null };
  os: { name: string; version: string; kernel: string };
  cpu: { model: string; vendor: string; logical: number; physical: number | null; flags: string[] };   // flags <= 12
  memGB: number;
  disk: { totalGB: number; freeGB: number; kind: DiskKind; fs: string | null };
  place: { imdsStatus: 'reachable' | 'unreachable'; region: string | null; vmSize: string | null; inferredRegion: string | null; matchedCidr: string | null; method: 'imds' | 'cidr' | 'none' };
  uptimeSec: number;
  stealPct: number | null;            // Linux only
  bench: {
    benchmarkDurationMs: number;      // <= 20000, schema maximum
    singleCoreScore: number | null; multiCoreScore: number | null;   // Mops/s of the kernel; null only when the step is in `truncated`
    seqWriteMBs: number | null; seqReadMBs: number | null;
    memBandwidthGBs: number | null;
    netTtfbMs: number | null; netMbps: number | null;
    netProbe: 'repo' | 'meta' | null; // which body netMbps was timed on (3.6); null when netMbps is null
    truncated: Array<'single' | 'multi' | 'disk' | 'mem' | 'net'>;
  };
}
