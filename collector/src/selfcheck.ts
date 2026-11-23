// In-job structural self-check (SPEC 2, 3.2). Full JSON Schema validation with ajv runs later, in publish.
import { scanForLeaks, type ScanOptions } from './privacy.ts';
import { parseCidr } from './region.ts';

// SPEC 2: the in-job self-check fails above 1600 bytes. 2048 is the publish validator's quarantine limit.
export const MAX_BYTES = 1600;
export const MAX_BENCH_MS = 20_000;

const LABELS = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2025', 'windows-11-arm', 'macos-15', 'macos-15-intel'];
const FLAGS = ['avx', 'avx2', 'avx512f', 'avx512bw', 'avx512vnni', 'amx_tile', 'fma', 'bmi2', 'aes', 'sha_ni', 'sse4_2', 'asimd', 'sve', 'sve2', 'lse'];
const DISK_KINDS = ['nvme', 'ssd', 'hdd', 'virtual', 'unknown'];
const TRUNCATABLE = ['single', 'multi', 'disk', 'mem', 'net'];

type Check = (v: unknown) => boolean;
type Node = Check | { [key: string]: Node };

// Per-field maxLength, as in schemas/raw-sample.schema.json.
const str = (max: number): Check => (v) => typeof v === 'string' && v.length <= max;
const isStr = str(128);
const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
const orNull = (c: Check): Check => (v) => v === null || c(v);
const oneOf = (values: readonly unknown[]): Check => (v) => values.includes(v);
const arrayOf = (item: Check, max: number): Check => (v) => Array.isArray(v) && v.length <= max && v.every(item);

const ISO = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/;
const isIso: Check = (v) => typeof v === 'string' && ISO.test(v);
// Copied from the schema's place.matchedCidr pattern.
const CIDR = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}\/(3[01]|[12]?[0-9])|(?!.*:::)(?!.*::.*::)[0-9A-Fa-f]{0,4}(:[0-9A-Fa-f]{0,4}){2,7}\/(12[0-7]|1[01][0-9]|[1-9]?[0-9]))$/;
const isCidr: Check = (v) => typeof v === 'string' && v.length <= 49 && CIDR.test(v) && parseCidr(v) !== null;

const SHAPE: Record<string, Node> = {
  v: (v) => v === 1,
  id: (v) => isStr(v) && (v as string).length <= 96,
  src: oneOf(['live', 'local', 'synthetic']),
  label: oneOf(LABELS),
  replica: (v) => Number.isInteger(v) && (v as number) >= 1,
  event: oneOf(['schedule', 'workflow_dispatch', 'local']),
  collectedAtIso: isIso,
  timing: {
    scheduledSlotIso: orNull(isIso), runCreatedAtIso: orNull(isIso), jobQueuedAtIso: orNull(isIso), jobStartedAtIso: orNull(isIso),
    cronDriftSec: orNull(isNum), queueTimeSec: orNull((v) => typeof v === 'number'), totalDelaySec: orNull((v) => typeof v === 'number'),
  },
  env: {
    imageOS: orNull(str(64)), imageVersion: orNull(str(64)), runnerOS: orNull(str(32)), runnerArch: orNull(str(32)),
    runnerEnvironment: orNull(str(32)), agentVersion: orNull(str(32)),
  },
  os: { name: isStr, version: str(64), kernel: isStr },
  cpu: {
    model: isStr, vendor: str(64), logical: (v) => isInt(v) && (v as number) >= 1, physical: orNull((v) => isInt(v) && (v as number) >= 1),
    flags: arrayOf(oneOf(FLAGS), 12),
  },
  memGB: isNum,
  disk: { totalGB: isNum, freeGB: isNum, kind: oneOf(DISK_KINDS), fs: orNull(str(32)) },
  place: {
    imdsStatus: oneOf(['reachable', 'unreachable']), region: orNull(str(64)), vmSize: orNull(str(64)), inferredRegion: orNull(str(64)),
    matchedCidr: orNull(isCidr), method: oneOf(['imds', 'cidr', 'none']),
  },
  uptimeSec: isInt,
  stealPct: orNull((v) => typeof v === 'number' && v >= 0 && v <= 100),
  bench: {
    benchmarkDurationMs: (v) => isInt(v) && (v as number) <= MAX_BENCH_MS,
    singleCoreScore: orNull(isNum), multiCoreScore: orNull(isNum), seqWriteMBs: orNull(isNum), seqReadMBs: orNull(isNum),
    memBandwidthGBs: orNull(isNum), netTtfbMs: orNull(isNum), netMbps: orNull(isNum),
    netProbe: oneOf(['repo', 'meta', null]),
    truncated: (v) => Array.isArray(v) && v.every((t) => TRUNCATABLE.includes(t as string)) && new Set(v).size === v.length,
  },
};

// Walks the shape: exact key set at every object, leaf checks at every leaf. Returns error paths.
function checkNode(value: unknown, node: Node, path: string, errors: string[]): void {
  if (typeof node === 'function') {
    if (!node(value)) errors.push(`bad:${path}`);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`not-object:${path}`);
    return;
  }
  const keys = Object.keys(node);
  const actual = Object.keys(value);
  for (const k of keys) if (!(k in value)) errors.push(`missing:${path}.${k}`);
  for (const k of actual) if (!keys.includes(k)) errors.push(`extra:${path}.${k}`);
  for (const k of keys) if (k in value) checkNode((value as Record<string, unknown>)[k], node[k], path ? `${path}.${k}` : k, errors);
}

// Full self-check on the serialized sample. Returns errors (empty = pass).
export function selfCheck(serialized: string, scan: ScanOptions = {}): string[] {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_BYTES) errors.push(`too-large:${bytes}`);
  let sample: unknown;
  try {
    sample = JSON.parse(serialized);
  } catch {
    return [...errors, 'not-json'];
  }
  checkNode(sample, SHAPE, '', errors);
  for (const finding of scanForLeaks(sample, scan)) errors.push(`privacy:${finding}`);
  return errors;
}
