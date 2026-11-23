// Shared plumbing for the three 3D scenes. Scenes import `three` dynamically inside mount(); this file only
// uses it as a type, so it is safe to import from tests and from the shell.
import type * as THREE from 'three';
import { el } from '../lib/dom.ts';
import { columnLayout, firstClear, leaderTo, type Bounds as LabelBounds, type Placement } from '../lib/labels.ts';
import type { Head } from '../../../shared/types/rollups.ts';
import type { Caption, ChartTokens } from '../types/views.ts';

export type ThreeModule = typeof import('three');
export type KeyAction = 'left' | 'right' | 'up' | 'down' | 'zoomIn' | 'zoomOut' | 'reset' | 'pause' | 'escape';

export function keyAction(key: string): KeyAction | null {
  switch (key) {
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case '+': case '=': return 'zoomIn';
    case '-': case '_': return 'zoomOut';
    case '0': return 'reset';
    case ' ': case 'Spacebar': return 'pause';
    case 'Escape': return 'escape';
    default: return null;
  }
}

// Cursor index in 0..n-1; -1 means no cursor yet, so the first step lands on the first (or last, going back) item.
export function stepIndex(index: number, delta: number, n: number, wrap = true): number {
  if (n <= 0) return -1;
  if (index < 0) return delta < 0 ? n - 1 : 0;
  const next = index + delta;
  return wrap ? ((next % n) + n) % n : Math.min(n - 1, Math.max(0, next));
}

// Grid cursor for arrow keys: left and right move along columns, up and down along rows; clamped at the edges.
export function gridStep(col: number, row: number, action: KeyAction, cols: number, rows: number): [number, number] {
  const dx = action === 'left' ? -1 : action === 'right' ? 1 : 0;
  const dy = action === 'up' ? -1 : action === 'down' ? 1 : 0;
  return [Math.min(cols - 1, Math.max(0, col + dx)), Math.min(rows - 1, Math.max(0, row + dy))];
}

export function zoomFactor(action: KeyAction): number {
  return action === 'zoomIn' ? 0.85 : action === 'zoomOut' ? 1 / 0.85 : 1;
}

export function sceneHeight(width: number): number {
  return Math.round(Math.min(560, Math.max(260, width * 0.62)));
}

// Ramp step (0..steps-1) for a value inside [min, max]; -1 when the value or the range is missing.
export function rampIndex(value: number | null, min: number | null, max: number | null, steps: number): number {
  if (value === null || min === null || max === null || steps < 1) return -1;
  if (max <= min) return 0;
  const t = (value - min) / (max - min);
  return Math.min(steps - 1, Math.max(0, Math.floor(t * steps)));
}

export function headCaption(d: Head): Caption {
  return { n: d.n.samples, unit: 'samples', runs: d.n.runs, range: d.range };
}

// Frees every geometry and material under a node. Safe on empty groups.
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    const obj = node as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) m.dispose();
  });
}

// One renderer, one perspective camera (fov 30), flat background from the tokens. Pixel ratio capped at 2.
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  private readonly lib: ThreeModule;
  width = 0;
  height = 0;

  constructor(lib: ThreeModule, tokens: ChartTokens, width: number, label: string) {
    this.lib = lib;
    this.scene = new lib.Scene();
    this.scene.background = new lib.Color(tokens.paper2);
    this.camera = new lib.PerspectiveCamera(30, 1, 0.1, 100);
    this.renderer = new lib.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', label);
    this.resize(width);
  }

  resize(width: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = sceneHeight(this.width);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setBackground(tokens: ChartTokens): void {
    this.scene.background = new this.lib.Color(tokens.paper2);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    disposeTree(this.scene);
    this.renderer.dispose();
    if (!this.renderer.getContext().isContextLost()) this.renderer.forceContextLoss();
  }
}

// Runs step(dt) on each animation frame while shouldRun() holds. Call sync() whenever a flag it reads changes.
export class FrameLoop {
  private id = 0;
  private last = 0;
  private disposed = false;

  private readonly step: (dtSeconds: number) => void;
  private readonly shouldRun: () => boolean;

  constructor(step: (dtSeconds: number) => void, shouldRun: () => boolean) {
    this.step = step;
    this.shouldRun = shouldRun;
  }

  sync(): void {
    if (this.disposed) return;
    const run = this.shouldRun();
    if (run && !this.id) {
      this.last = performance.now();
      this.id = requestAnimationFrame(this.tick);
    } else if (!run && this.id) {
      cancelAnimationFrame(this.id);
      this.id = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.id) cancelAnimationFrame(this.id);
    this.id = 0;
  }

  private readonly tick = (now: number): void => {
    this.id = 0;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.step(dt);
    if (!this.disposed && this.shouldRun()) this.id = requestAnimationFrame(this.tick);
  };
}

// Calls back with whether the element is near the viewport. Returns the disconnect function.
export function watchVisible(target: HTMLElement, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => onChange(entries.some((e) => e.isIntersecting)), { rootMargin: '200px' });
  observer.observe(target);
  return () => observer.disconnect();
}

// Keyboard map on the scene container only (buttons keep their own keys). Escape leaves the chart.
export function bindKeys(target: HTMLElement, handle: (action: KeyAction) => void, signal: AbortSignal): void {
  target.addEventListener('keydown', (event) => {
    if (event.target !== target) return;
    const action = keyAction(event.key);
    if (!action) return;
    event.preventDefault();
    if (action === 'escape') target.blur();
    else handle(action);
  }, { signal });
}

export interface Chrome {
  readonly scene: HTMLElement;
  readonly stage: HTMLElement;
  readonly readout: HTMLElement;
  readonly controls: HTMLElement;
  button(label: string, pressed?: boolean): HTMLButtonElement;
}

// Builds the focusable container, help text, readout and control row inside the shell-owned root.
export function buildChrome(root: HTMLElement, id: string, help: string): Chrome {
  const stage = el('div', { class: 'scene__stage' });
  const readout = el('p', { class: 'scene__readout', 'aria-hidden': 'true' });
  const controls = el('div', { class: 'scene__controls' });
  const scene = el('div', { class: 'scene', tabindex: '0', 'aria-describedby': `${id}-help` },
    stage, el('p', { class: 'scene__help', id: `${id}-help` }, help), readout, controls);
  root.replaceChildren(scene);
  return {
    scene, stage, readout, controls,
    button(label, pressed) {
      const attrs: Record<string, string> = { type: 'button', class: 'scene__button' };
      if (pressed !== undefined) attrs['aria-pressed'] = String(pressed);
      const node = el('button', attrs, label);
      controls.append(node);
      return node;
    },
  };
}

// Overlay labels: DOM text placed over the canvas at projected 3D anchors, with a leader line back to the anchor.
export interface Tag { readonly el: HTMLElement; readonly line: HTMLElement; readonly at: THREE.Vector3 }

export function addTag(stage: HTMLElement, text: string, at: THREE.Vector3): Tag {
  const line = el('span', { class: 'scene__leader', hidden: '' });
  const node = el('span', { class: 'scene__label' }, text);
  stage.append(line, node);
  return { el: node, line, at };
}

export type { Box, Placement } from '../lib/labels.ts';

const LABEL_PAD = 6;
const LABEL_STEP = 8;

// Candidates for one label: centred on its anchor, then sideways in 8 px steps, first above the anchor in tiers
// going up, then below in tiers going down, until a tier leaves the stage. A label beside the anchor takes a leader;
// one that touches it does not.
function* tierCandidates(a: { x: number; y: number; width: number; height: number }, bounds: LabelBounds): Generator<Placement> {
  const { width, height, pad, gap } = bounds;
  const maxLeft = width - pad - a.width;
  const centred = Math.min(Math.max(pad, a.x - a.width / 2), Math.max(pad, maxLeft));
  const lefts: number[] = [];
  for (let k = 0; k <= 6; k++) {
    for (const s of k === 0 ? [0] : [k * LABEL_STEP, -k * LABEL_STEP]) {
      const left = centred + s;
      if (left >= pad && left <= maxLeft) lefts.push(left);
    }
  }
  const step = a.height + gap;
  for (const dir of [-1, 1]) {
    for (let t = 0; ; t++) {
      const top = dir < 0 ? a.y - gap - a.height - t * step : a.y + gap + t * step;
      if (top < pad || top + a.height > height - pad) break;
      for (const left of lefts) {
        const box = { left, top, width: a.width, height: a.height };
        yield { box, leader: leaderTo(a, box) };
      }
    }
  }
}

// Places every label in order. A label with no clear candidate is clamped above its anchor, so it stays on the stage.
export function declutter(anchors: ReadonlyArray<{ x: number; y: number; width: number; height: number }>, stageWidth: number, stageHeight: number, gap = 2): Placement[] {
  const bounds: LabelBounds = { width: stageWidth, height: stageHeight, pad: LABEL_PAD, gap };
  const placed: Placement[] = [];
  for (const a of anchors) {
    const strict: LabelBounds = { ...bounds, strict: true };
    const relaxed: LabelBounds = { ...bounds, strict: false };
    const found = firstClear(tierCandidates(a, strict), a, strict, placed)
      ?? firstClear(tierCandidates(a, relaxed), a, relaxed, placed);
    if (found) { placed.push(found); continue; }
    const left = Math.min(Math.max(LABEL_PAD, a.x - a.width / 2), Math.max(LABEL_PAD, stageWidth - LABEL_PAD - a.width));
    const top = Math.min(Math.max(LABEL_PAD, a.y - gap - a.height), Math.max(LABEL_PAD, stageHeight - LABEL_PAD - a.height));
    const box = { left, top, width: a.width, height: a.height };
    placed.push({ box, leader: leaderTo(a, box) });
  }
  return placed;
}

// Camera distance multiplier so a scene framed for a wide stage still fits a narrow (phone) one.
export function fitScale(aspect: number, reference = 1.6): number {
  return Math.max(1, reference / Math.max(0.1, aspect));
}

export function placeTags(tags: readonly Tag[], camera: THREE.Camera, width: number, height: number, parent?: THREE.Object3D): void {
  const shown = tags.filter((t) => !t.el.hidden);
  for (const tag of tags) if (tag.el.hidden) tag.line.hidden = true;
  const anchors = shown.map((tag) => {
    const p = tag.at.clone();
    if (parent) p.applyMatrix4(parent.matrixWorld);
    p.project(camera);
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height, width: tag.el.offsetWidth, height: tag.el.offsetHeight };
  });
  declutter(anchors, width, height).forEach((p, i) => {
    const tag = shown[i]!;
    tag.el.style.transform = `translate(${p.box.left.toFixed(1)}px, ${p.box.top.toFixed(1)}px)`;
    const l = p.leader;
    tag.line.hidden = !l;
    if (!l) return;
    const angle = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
    tag.line.style.width = `${Math.hypot(l.x2 - l.x1, l.y2 - l.y1).toFixed(1)}px`;
    tag.line.style.transform = `translate(${l.x1.toFixed(1)}px, ${l.y1.toFixed(1)}px) rotate(${angle.toFixed(4)}rad)`;
  });
}

const MARKER_CLEARANCE = 3;

// Fallback markers sit on their anchors; clustered anchors take the nearest spot on a small grid that keeps every
// marker at least MARKER_CLEARANCE px from the others and inside the stage, so numbers never touch. Pure, so it is unit tested.
export function spreadMarkers(anchors: ReadonlyArray<{ x: number; y: number }>, sizes: ReadonlyArray<{ width: number; height: number }>, width: number, height: number): Array<{ left: number; top: number }> {
  const placed: Array<{ left: number; top: number; width: number; height: number }> = [];
  const grid = [-2, -1, 0, 1, 2].flatMap((dy) => [-2, -1, 0, 1, 2].map((dx) => [dx, dy] as const)).sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  const c = MARKER_CLEARANCE;
  anchors.forEach((a, i) => {
    const { width: mw, height: mh } = sizes[i]!;
    const inside = (l: number, t: number) => l >= 0 && t >= 0 && l + mw <= width && t + mh <= height;
    const clear = (l: number, t: number) => placed.every((m) => l + mw + c <= m.left || m.left + m.width + c <= l || t + mh + c <= m.top || m.top + m.height + c <= t);
    const baseL = a.x - mw / 2;
    const baseT = a.y - mh / 2;
    let spot = { left: Math.min(Math.max(0, baseL), width - mw), top: Math.min(Math.max(0, baseT), height - mh) };
    for (const [dx, dy] of grid) {
      const l = baseL + dx * (mw + c + 1);
      const t = baseT + dy * (mh + c + 1);
      if (inside(l, t) && clear(l, t)) { spot = { left: l, top: t }; break; }
    }
    placed.push({ ...spot, width: mw, height: mh });
  });
  return placed.map(({ left, top }) => ({ left, top }));
}

export interface BeaconLabel { readonly tag: Tag; readonly marker: HTMLElement; readonly side: 'left' | 'right' }

// Beacon labels in the stage margins with one leader each (columnLayout). When that layout breaks a rule, the labels
// hide and each beacon shows its number at the anchor; the caller then shows the numbered list. Returns true for labels.
// Visibility, not display, hides the labels, so their sizes stay measurable.
export function placeBeacons(beacons: readonly BeaconLabel[], camera: THREE.Camera, width: number, height: number, parent?: THREE.Object3D): boolean {
  const anchors = beacons.map((b) => {
    const p = b.tag.at.clone();
    if (parent) p.applyMatrix4(parent.matrixWorld);
    p.project(camera);
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height, width: b.tag.el.offsetWidth, height: b.tag.el.offsetHeight, side: b.side };
  });
  const layout = columnLayout(anchors, { width, height, pad: LABEL_PAD, gap: 4 });
  const spots = layout ? [] : spreadMarkers(anchors, beacons.map((b) => ({ width: b.marker.offsetWidth, height: b.marker.offsetHeight })), width, height);
  beacons.forEach((b, i) => {
    b.tag.el.style.visibility = layout ? '' : 'hidden';
    b.marker.style.visibility = layout ? 'hidden' : '';
    if (!layout) {
      b.tag.line.hidden = true;
      const spot = spots[i]!;
      b.marker.style.transform = `translate(${spot.left.toFixed(1)}px, ${spot.top.toFixed(1)}px)`;
      return;
    }
    const p = layout[i]!;
    b.tag.el.style.transform = `translate(${p.box.left.toFixed(1)}px, ${p.box.top.toFixed(1)}px)`;
    const l = p.leader;
    b.tag.line.hidden = !l;
    if (!l) return;
    const angle = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
    b.tag.line.style.width = `${Math.hypot(l.x2 - l.x1, l.y2 - l.y1).toFixed(1)}px`;
    b.tag.line.style.transform = `translate(${l.x1.toFixed(1)}px, ${l.y1.toFixed(1)}px) rotate(${angle.toFixed(4)}rad)`;
  });
  return !!layout;
}

// "Show 2D chart" toggle. The shell listens for this bubbling event on the panel body and swaps in the 2D fallback.
export function twoDToggle(chrome: Chrome, signal: AbortSignal): HTMLButtonElement {
  const button = chrome.button('Show 2D chart', false);
  button.setAttribute('data-show-2d', '');
  button.addEventListener('click', () => button.dispatchEvent(new CustomEvent('scene:show-2d', { bubbles: true })), { signal });
  return button;
}
