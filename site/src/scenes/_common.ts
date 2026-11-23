// Shared plumbing for the three 3D scenes. Scenes import `three` dynamically inside mount(); this file only
// uses it as a type, so it is safe to import from tests and from the shell.
import type * as THREE from 'three';
import { el } from '../lib/dom.ts';
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

// Overlay labels: DOM text placed over the canvas at projected 3D anchors.
export interface Tag { readonly el: HTMLElement; readonly at: THREE.Vector3 }

export function addTag(stage: HTMLElement, text: string, at: THREE.Vector3): Tag {
  const node = el('span', { class: 'scene__label' }, text);
  stage.append(node);
  return { el: node, at };
}

export interface Box { left: number; top: number; width: number; height: number }

// Greedy declutter: each label sits centred above its anchor; a label that would overlap one already placed moves
// above it, and when that runs off the top it stacks below the anchor instead. Labels stay inside the stage.
// Pure, so it is unit tested.
export function declutter(anchors: ReadonlyArray<{ x: number; y: number; width: number; height: number }>, stageWidth: number, stageHeight: number, gap = 2): Box[] {
  const placed: Box[] = [];
  const hit = (left: number, top: number, w: number, h: number): Box | undefined =>
    placed.find((b) => left < b.left + b.width && left + w > b.left && top < b.top + b.height + gap && top + h + gap > b.top);
  for (const a of anchors) {
    const left = Math.min(Math.max(0, stageWidth - a.width), Math.max(0, a.x - a.width / 2));
    let top = a.y - a.height - gap;
    for (let b = hit(left, top, a.width, a.height); b && top >= 0; b = hit(left, top, a.width, a.height)) top = b.top - a.height - gap;
    if (top < 0) {
      top = Math.max(0, a.y + gap);
      for (let b = hit(left, top, a.width, a.height); b; b = hit(left, top, a.width, a.height)) top = b.top + b.height + gap;
    }
    top = Math.min(Math.max(0, stageHeight - a.height), Math.max(0, top));
    placed.push({ left, top, width: a.width, height: a.height });
  }
  return placed;
}

// Camera distance multiplier so a scene framed for a wide stage still fits a narrow (phone) one.
export function fitScale(aspect: number, reference = 1.6): number {
  return Math.max(1, reference / Math.max(0.1, aspect));
}

export function placeTags(tags: readonly Tag[], camera: THREE.Camera, width: number, height: number, parent?: THREE.Object3D): void {
  const shown = tags.filter((t) => !t.el.hidden);
  const anchors = shown.map((tag) => {
    const p = tag.at.clone();
    if (parent) p.applyMatrix4(parent.matrixWorld);
    p.project(camera);
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height, width: tag.el.offsetWidth, height: tag.el.offsetHeight };
  });
  declutter(anchors, width, height).forEach((box, i) => {
    shown[i]!.el.style.transform = `translate(${box.left.toFixed(1)}px, ${box.top.toFixed(1)}px)`;
  });
}

// "Show 2D chart" toggle. The shell listens for this bubbling event on the panel body and swaps in the 2D fallback.
export function twoDToggle(chrome: Chrome, signal: AbortSignal): HTMLButtonElement {
  const button = chrome.button('Show 2D chart', false);
  button.setAttribute('data-show-2d', '');
  button.addEventListener('click', () => button.dispatchEvent(new CustomEvent('scene:show-2d', { bubbles: true })), { signal });
  return button;
}
