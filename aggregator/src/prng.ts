// Deterministic PRNG: every stream is mulberry32(fnv1a32(key)) with a documented key (SPEC 1).

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ byte, 0x01000193);
  }
  return h >>> 0;
}

// Returns raw uint32 values.
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// Uniform floats in [0, 1) for one named stream.
export function uniformStream(key: string): () => number {
  const next = mulberry32(fnv1a32(key));
  return () => next() / 4294967296;
}
