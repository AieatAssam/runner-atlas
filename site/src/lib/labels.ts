// Label placement for the 2D charts and the 3D overlays: candidates are tried in order, and a candidate is taken
// only when it clears the stage edge, every placed label, every obstacle (marks, nodes) and every leader. Pure
// geometry in CSS pixels or SVG user units, so it is unit tested.
export interface Box { left: number; top: number; width: number; height: number }
export interface Leader { x1: number; y1: number; x2: number; y2: number }
export interface Placement { box: Box; leader: Leader | null }

// strict: a leader may not pass through another label. Relaxed only when no strict spot exists.
export interface Bounds { width: number; height: number; pad: number; gap: number; strict?: boolean }

const SAMPLES = 32;

export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return a.left < b.left + b.width + gap && b.left < a.left + a.width + gap
    && a.top < b.top + b.height + gap && b.top < a.top + a.height + gap;
}

function within(b: Box, x: number, y: number, pad: number): boolean {
  return x >= b.left - pad && x <= b.left + b.width + pad && y >= b.top - pad && y <= b.top + b.height + pad;
}

// Sampled rather than solved: 32 points along a leader of a few hundred pixels cannot miss a box by more than a pixel.
export function leaderHits(l: Leader, b: Box, pad = 1): boolean {
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    if (within(b, l.x1 + (l.x2 - l.x1) * t, l.y1 + (l.y2 - l.y1) * t, pad)) return true;
  }
  return false;
}

function side(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// Proper crossing only: leaders that share an endpoint (one anchor, one label) do not count.
export function leadersCross(a: Leader, b: Leader): boolean {
  const d1 = side(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d2 = side(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const d3 = side(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d4 = side(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// A candidate is clear when it is on the surface, touches nothing already placed, and its leader crosses nothing.
// Obstacles that contain the anchor (a region's own circle) are allowed: a leader starts inside its own mark.
export function clear(
  p: Placement,
  anchor: { x: number; y: number },
  bounds: Bounds,
  placed: readonly Placement[],
  obstacles: readonly Box[] = [],
): boolean {
  const b = p.box;
  if (b.left < bounds.pad || b.top < bounds.pad) return false;
  if (b.left + b.width > bounds.width - bounds.pad || b.top + b.height > bounds.height - bounds.pad) return false;
  for (const q of placed) {
    if (overlaps(b, q.box, bounds.gap)) return false;
    if (p.leader && q.leader && leadersCross(p.leader, q.leader)) return false;
    if (bounds.strict !== false) {
      if (p.leader && leaderHits(p.leader, q.box)) return false;
      if (q.leader && leaderHits(q.leader, b)) return false;
    }
  }
  for (const o of obstacles) {
    if (within(o, anchor.x, anchor.y, 0)) continue;
    if (overlaps(b, o, bounds.gap)) return false;
    if (p.leader && bounds.strict !== false && leaderHits(p.leader, o)) return false;
  }
  return true;
}

// The first candidate that is clear, or null. Candidates are tried in the order given, so callers put the
// preferred spot first and the displaced spots (with leaders) after it.
export function firstClear(
  candidates: Iterable<Placement>,
  anchor: { x: number; y: number },
  bounds: Bounds,
  placed: readonly Placement[],
  obstacles: readonly Box[] = [],
): Placement | null {
  for (const c of candidates) if (clear(c, anchor, bounds, placed, obstacles)) return c;
  return null;
}

// The leader from an anchor to the nearest point on a box; null when the label sits on the anchor already.
export function leaderTo(anchor: { x: number; y: number }, box: Box, min = 3): Leader | null {
  const x2 = Math.min(Math.max(anchor.x, box.left), box.left + box.width);
  const y2 = Math.min(Math.max(anchor.y, box.top), box.top + box.height);
  if (Math.hypot(x2 - anchor.x, y2 - anchor.y) < min) return null;
  return { x1: anchor.x, y1: anchor.y, x2, y2 };
}

function distToSegment(px: number, py: number, s: Leader): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((px - s.x1) * dx + (py - s.y1) * dy) / len));
  return Math.hypot(px - (s.x1 + dx * t), py - (s.y1 + dy * t));
}

// Stricter than leadersCross: a crossing, or an endpoint of one leader within half a pixel of the other.
export function leadersMeet(a: Leader, b: Leader): boolean {
  if (leadersCross(a, b)) return true;
  return distToSegment(a.x1, a.y1, b) < 0.5 || distToSegment(a.x2, a.y2, b) < 0.5
    || distToSegment(b.x1, b.y1, a) < 0.5 || distToSegment(b.x2, b.y2, a) < 0.5;
}

export interface Column { x: number; y: number; width: number; height: number; side: 'left' | 'right' }

// Two stacks of labels, one in each stage margin. Each stack is ordered by anchor height and pushed apart only as far
// as it must be; each label takes one straight leader from its inner edge to its anchor. Returns null rather than a
// layout that breaks a rule: a label off the stage, two labels touching, a leader meeting another leader, or a leader
// passing through another label. The caller then falls back to markers.
export function columnLayout(tags: readonly Column[], bounds: Bounds): Placement[] | null {
  const { width, height, pad, gap } = bounds;
  const out: Placement[] = new Array(tags.length);
  for (const side of ['left', 'right'] as const) {
    const idx = tags.map((_, i) => i).filter((i) => tags[i]!.side === side).sort((a, b) => tags[a]!.y - tags[b]!.y);
    const tops = new Array<number>(idx.length);
    let floor = pad;
    idx.forEach((i, k) => { const t = tags[i]!; tops[k] = Math.max(t.y - t.height / 2, floor); floor = tops[k]! + t.height + gap; });
    let ceil = height - pad;
    for (let k = idx.length - 1; k >= 0; k--) { const t = tags[idx[k]!]!; tops[k] = Math.min(tops[k]!, ceil - t.height); ceil = tops[k]! - gap; }
    idx.forEach((i, k) => {
      const t = tags[i]!;
      const left = side === 'left' ? pad : width - pad - t.width;
      const box = { left, top: tops[k]!, width: t.width, height: t.height };
      out[i] = { box, leader: leaderTo(t, box) };
    });
  }
  for (let i = 0; i < out.length; i++) {
    const b = out[i]!.box;
    if (b.left < pad || b.top < pad || b.left + b.width > width - pad || b.top + b.height > height - pad) return null;
    for (let j = 0; j < out.length; j++) {
      if (j === i) continue;
      if (j > i && overlaps(b, out[j]!.box, gap)) return null;
      if (out[i]!.leader && leaderHits(out[i]!.leader!, out[j]!.box)) return null;
      if (j > i && out[i]!.leader && out[j]!.leader && leadersMeet(out[i]!.leader!, out[j]!.leader!)) return null;
    }
  }
  return out;
}
