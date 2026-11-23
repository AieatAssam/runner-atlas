// CPU model -> family (SPEC 4.1). Unknown models map to "unknown".
const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/AMD EPYC\s+(\w{4})/i, (m) => `AMD EPYC ${m[1].toUpperCase()}`],
  [/Xeon\s+(?:\(R\)\s+)?Platinum\s+(\w{4}[A-Z]?)/i, (m) => `Intel Xeon Platinum ${m[1].toUpperCase()}`],
  [/Xeon\s+(?:\(R\)\s+)?(Gold|Silver|Bronze)\s+(\w{4}[A-Z]?)/i, (m) => `Intel Xeon ${m[1]} ${m[2].toUpperCase()}`],
  [/Xeon\s+(?:\(R\)\s+)?(\d{4}[A-Z0-9-]*)/i, (m) => `Intel Xeon ${m[1].toUpperCase()}`],
  [/Core\s*(?:\(TM\)\s*)?(i\d-\w+)/i, (m) => `Intel Core ${m[1].toLowerCase()}`],
  [/Neoverse-([NV]\d+)/i, (m) => `Neoverse-${m[1].toUpperCase()}`],
  [/Cobalt\s+(\d+)/i, (m) => `Microsoft Cobalt ${m[1]}`],
  [/Ampere\s+Altra/i, () => 'Ampere Altra'],
  [/Apple\s+(M\d+(?:\s+(?:Pro|Max|Ultra))?)(\s*\(Virtual\))?/i, (m) => `Apple ${m[1]}${m[2] ? ' (Virtual)' : ''}`],
];

export function cpuFamily(model: string): string {
  // Strip trademark marks and clock suffixes, then collapse spaces.
  const cleaned = model
    .replace(/\((R|TM)\)/g, '')
    .replace(/\s*CPU\s*@\s*[\d.]+\s*GHz/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, name] of RULES) {
    const m = cleaned.match(re);
    if (m) return name(m);
  }
  return 'unknown';
}
