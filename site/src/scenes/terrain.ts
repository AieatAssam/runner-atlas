// Cron drift terrain (SPEC 7.1): a 24 x 7 heightfield of median start delay, x = UTC hour, z = weekday (Monday first).
import { contours } from 'd3-contour';
import type { DriftCell, DriftRollup, SlotScore } from '../../../shared/types/rollups.ts';
import { formatDuration, formatSlot } from '../lib/format.ts';
import type { ChartTokens, RenderContext, SceneHandle, SceneModule } from '../types/views.ts';
import { Stage, addTag, bindKeys, buildChrome, fitScale, gridStep, headCaption, placeTags, rampIndex, twoDToggle, zoomFactor, type Tag } from './_common.ts';

export const COLS = 24;
export const ROWS = 7;
const CELL_W = 0.2;
const CELL_D = 0.3;
const MAX_HEIGHT = 1;
const DEFAULT_ZOOM = 1;
const HELP = 'Arrow keys move the cell cursor. Plus and minus zoom, 0 resets the view, Escape leaves the chart.';

export interface Beacon { kind: 'best' | 'worst'; rank: number; weekday: number | null; hourUtc: number }

// Median total delay per cell, index = weekday * 24 + hour. Cells with no runs are null.
export function surfaceValues(cells: readonly DriftCell[]): Array<number | null> {
  return Array.from({ length: COLS * ROWS }, (_, i) => {
    const c = cells[i];
    return c && c.runs > 0 && c.total ? c.total.median : null;
  });
}

export function extent(values: ReadonlyArray<number | null>): { min: number | null; max: number | null } {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return { min: null, max: null };
  return { min: Math.min(...present), max: Math.max(...present) };
}

export function heightOf(value: number | null, min: number | null, max: number | null): number {
  if (value === null || min === null || max === null || max <= min) return 0;
  return ((value - min) / (max - min)) * MAX_HEIGHT;
}

// Vertex grid of (COLS + 1) x (ROWS + 1) corners; each corner averages the cells that touch it.
export function cornerHeights(values: ReadonlyArray<number | null>, min: number | null, max: number | null): number[] {
  const out: number[] = [];
  for (let j = 0; j <= ROWS; j++) {
    for (let i = 0; i <= COLS; i++) {
      let sum = 0;
      let count = 0;
      for (const cj of [j - 1, j]) for (const ci of [i - 1, i]) {
        if (ci < 0 || cj < 0 || ci >= COLS || cj >= ROWS) continue;
        sum += heightOf(values[cj * COLS + ci] ?? null, min, max);
        count += 1;
      }
      out.push(count ? sum / count : 0);
    }
  }
  return out;
}

// Two triangles per cell, flat per cell (six vertices each, xyz). Cell (hour i, weekday j) sits at x = i, z = j.
export function quadPositions(values: ReadonlyArray<number | null>, min: number | null, max: number | null): Float32Array {
  const corners = cornerHeights(values, min, max);
  const at = (i: number, j: number): number => corners[j * (COLS + 1) + i] ?? 0;
  const out = new Float32Array(COLS * ROWS * 18);
  let p = 0;
  const put = (i: number, j: number): void => {
    out[p++] = i * CELL_W - (COLS * CELL_W) / 2;
    out[p++] = at(i, j);
    out[p++] = j * CELL_D - (ROWS * CELL_D) / 2;
  };
  // Counter-clockwise seen from above (+y), so the faces point up and survive back-face culling.
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    put(i, j); put(i, j + 1); put(i + 1, j + 1);
    put(i, j); put(i + 1, j + 1); put(i + 1, j);
  }
  return out;
}

export function cellCentre(hour: number, weekday: number): [number, number] {
  return [(hour + 0.5) * CELL_W - (COLS * CELL_W) / 2, (weekday + 0.5) * CELL_D - (ROWS * CELL_D) / 2];
}

// Isolines at one threshold, as segments in grid units (cell centres at i + 0.5). Edge-hugging pieces are dropped.
export function isolineSegments(values: ReadonlyArray<number | null>, threshold: number): Array<[number, number, number, number]> {
  const grid = values.map((v) => v ?? 0);
  const [first] = contours().size([COLS, ROWS]).thresholds([threshold])(grid);
  const out: Array<[number, number, number, number]> = [];
  const eps = 1e-9;
  const edges = (p: number[]): boolean[] => [p[0]! <= eps, p[0]! >= COLS - eps, p[1]! <= eps, p[1]! >= ROWS - eps];
  for (const polygon of first?.coordinates ?? []) for (const ring of polygon) {
    for (let k = 0; k + 1 < ring.length; k++) {
      const a = ring[k]!;
      const b = ring[k + 1]!;
      const ea = edges(a);
      const eb = edges(b);
      if (ea.some((on, side) => on && eb[side])) continue;
      out.push([a[0]!, a[1]!, b[0]!, b[1]!]);
    }
  }
  return out;
}

// Three best and three worst slots as beacons. A null weekday (hour-only ranking) stands on the middle row.
export function beacons(best: readonly SlotScore[], worst: readonly SlotScore[], n = 3): Beacon[] {
  const pick = (list: readonly SlotScore[], kind: Beacon['kind']): Beacon[] =>
    list.slice(0, n).map((s, k) => ({ kind, rank: k + 1, weekday: s.weekday, hourUtc: s.hourUtc }));
  return [...pick(best, 'best'), ...pick(worst, 'worst')];
}

export function beaconRow(weekday: number | null): number {
  return weekday ?? Math.floor(ROWS / 2);
}

export function cellSentence(cell: DriftCell | undefined, weekday: number | null, hourUtc: number): string {
  const slot = formatSlot(weekday, hourUtc);
  if (!cell || cell.runs === 0 || !cell.total) return `${slot}: no runs in this slot.`;
  const runs = cell.runs === 1 ? '1 run' : `${cell.runs} runs`;
  return `${slot}: median wait ${formatDuration(cell.total.median)}, p95 ${formatDuration(cell.total.p95)}, ${runs}.`;
}

function beaconLabel(b: Beacon): string {
  return `${b.kind === 'best' ? 'Best' : 'Worst'} ${b.rank}: ${formatSlot(b.weekday, b.hourUtc)}`;
}

export default {
  panel: 'terrain',
  caption: (d: DriftRollup) => headCaption(d),
  async mount(ctx: RenderContext, data: DriftRollup): Promise<SceneHandle> {
    const lib = await import('three');
    const values = surfaceValues(data.weekdayHour);
    const { min, max } = extent(values);
    const ramp = values.map((v) => rampIndex(v, min, max, ctx.tokens.sequential.length));
    const stage = new Stage(lib, ctx.tokens, ctx.width, '3D terrain of median start delay by weekday and UTC hour, with the best and worst slots marked');
    const chrome = buildChrome(ctx.root, 'terrain', HELP);
    chrome.stage.append(stage.renderer.domElement);
    const ac = new AbortController();
    twoDToggle(chrome, ac.signal);
    const resetBtn = chrome.button('Reset view');

    // Surface: flat per-cell colour from the sequential ramp; empty cells in the rule colour.
    const positions = quadPositions(values, min, max);
    const tint = new lib.Color();
    const colourAttr = new lib.BufferAttribute(new Float32Array(positions.length), 3);
    const surfaceGeo = new lib.BufferGeometry();
    surfaceGeo.setAttribute('position', new lib.BufferAttribute(positions, 3));
    surfaceGeo.setAttribute('color', colourAttr);
    const surfaceMat = new lib.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const surface = new lib.Mesh(surfaceGeo, surfaceMat);
    const paintSurface = (tokens: ChartTokens): void => {
      ramp.forEach((step, cell) => {
        tint.set(step < 0 ? tokens.rule : tokens.sequential[step] ?? tokens.rule);
        for (let v = 0; v < 6; v++) colourAttr.setXYZ(cell * 6 + v, tint.r, tint.g, tint.b);
      });
      colourAttr.needsUpdate = true;
    };
    paintSurface(ctx.tokens);

    // Isolines: lifted to the height of their threshold.
    const inkMat = new lib.LineBasicMaterial({ color: ctx.tokens.ink });
    const focusMat = new lib.LineBasicMaterial({ color: ctx.tokens.focus });
    const lineVerts: number[] = [];
    for (const t of data.terrain.contours) {
      const h = heightOf(t, min, max) + 0.01;
      for (const [x1, z1, x2, z2] of isolineSegments(values, t)) {
        const [ax, az] = [x1 * CELL_W - (COLS * CELL_W) / 2, z1 * CELL_D - (ROWS * CELL_D) / 2];
        const [bx, bz] = [x2 * CELL_W - (COLS * CELL_W) / 2, z2 * CELL_D - (ROWS * CELL_D) / 2];
        lineVerts.push(ax, h, az, bx, h, bz);
      }
    }
    const isolines = new lib.LineSegments(
      new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute(lineVerts, 3)),
      inkMat,
    );

    // Beacons: thin vertical ink lines with DOM labels.
    const beaconList = beacons(data.ranking.best, data.ranking.worst, 3);
    const beaconVerts: number[] = [];
    const tags: Tag[] = [];
    for (const b of beaconList) {
      const [x, z] = cellCentre(b.hourUtc, beaconRow(b.weekday));
      const foot = heightOf(values[beaconRow(b.weekday) * COLS + b.hourUtc] ?? null, min, max);
      beaconVerts.push(x, foot, z, x, MAX_HEIGHT + 0.3, z);
      tags.push(addTag(chrome.stage, beaconLabel(b), new lib.Vector3(x, MAX_HEIGHT + 0.3, z)));
    }
    const beaconLines = new lib.LineSegments(
      new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute(beaconVerts, 3)),
      inkMat,
    );

    // Cell cursor: a rectangle on the surface.
    const rect = [
      new lib.Vector3(-CELL_W / 2, 0, -CELL_D / 2), new lib.Vector3(CELL_W / 2, 0, -CELL_D / 2),
      new lib.Vector3(CELL_W / 2, 0, CELL_D / 2), new lib.Vector3(-CELL_W / 2, 0, CELL_D / 2),
    ];
    const cursor = new lib.LineLoop(new lib.BufferGeometry().setFromPoints(rect), focusMat);

    const group = new lib.Group();
    group.add(surface, isolines, beaconLines, cursor);
    stage.scene.add(group);
    // White lights summing to about 1 (three's Lambert divides by pi), so up-facing cells show the token colour
    // and slopes shade slightly darker.
    const light = new lib.DirectionalLight(undefined, Math.PI * 0.4);
    light.position.set(2, 6, 4);
    const ambient = new lib.AmbientLight(undefined, Math.PI * 0.68);
    stage.scene.add(light, ambient);

    const base = new lib.Vector3(0, 4.4, 5.6);
    let zoom = DEFAULT_ZOOM;
    const frame = (): void => {
      stage.camera.position.copy(base).multiplyScalar(zoom * fitScale(stage.camera.aspect));
      stage.camera.lookAt(0, 0.3, 0);
      stage.render();
      placeTags(tags, stage.camera, stage.width, stage.height);
    };

    // Cursor starts on the best slot when there is one, else the first cell.
    const first = beaconList.find((b) => b.kind === 'best');
    let col = first ? first.hourUtc : 0;
    let row = first ? beaconRow(first.weekday) : 0;
    const moveCursor = (): string => {
      const [x, z] = cellCentre(col, row);
      cursor.position.set(x, heightOf(values[row * COLS + col] ?? null, min, max) + 0.02, z);
      return cellSentence(data.weekdayHour[row * COLS + col], row, col);
    };
    const say = (text: string): void => {
      chrome.readout.textContent = text;
      ctx.announce(text);
    };

    let done = false;
    const dispose = (): void => {
      if (done) return;
      done = true;
      ac.abort();
      stage.dispose();
    };
    ctx.signal.addEventListener('abort', dispose, { once: true });
    if (ctx.signal.aborted) dispose();

    bindKeys(chrome.scene, (action) => {
      if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
        [col, row] = gridStep(col, row, action, COLS, ROWS);
        const text = moveCursor();
        frame();
        say(text);
      } else if (action === 'zoomIn' || action === 'zoomOut') {
        zoom = Math.min(2, Math.max(0.5, zoom * zoomFactor(action)));
        frame();
        say(`Zoom ${Math.round(100 / zoom)} percent.`);
      } else if (action === 'reset') {
        zoom = DEFAULT_ZOOM;
        frame();
        say('View reset.');
      } else if (action === 'pause') {
        say('The terrain has no motion to pause.');
      }
    }, ac.signal);
    resetBtn.addEventListener('click', () => {
      zoom = DEFAULT_ZOOM;
      frame();
      say('View reset.');
    }, { signal: ac.signal });

    chrome.readout.textContent = moveCursor();
    frame();

    return {
      setPaused: () => {},
      setTokens(tokens) {
        paintSurface(tokens);
        inkMat.color.set(tokens.ink);
        focusMat.color.set(tokens.focus);
        stage.setBackground(tokens);
        frame();
      },
      resize(width) {
        stage.resize(width);
        frame();
      },
      dispose,
    };
  },
} satisfies SceneModule<DriftRollup>;
