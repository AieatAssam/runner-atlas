// Benchmark point cloud (SPEC 7.2): every run as a point on single-core x sequential write x memory bandwidth,
// coloured by CPU family. Outliers (|z| > 3, robust z of the single-core score against its label x cpuFamily group,
// SPEC 4.4) are marked; the cursor steps through family centroids and outliers.
import type * as THREE from 'three';
import type { BenchmarksRollup, MetricId } from '../../../shared/types/rollups.ts';
import { groupDigits } from '../lib/format.ts';
import type { ChartTokens, RenderContext, SceneHandle, SceneModule } from '../types/views.ts';
import { Stage, addTag, bindKeys, buildChrome, fitScale, headCaption, placeTags, stepIndex, twoDToggle, zoomFactor, type Tag } from './_common.ts';

export const AXES: readonly [MetricId, MetricId, MetricId] = ['singleCoreScore', 'seqWriteMBs', 'memBandwidthGBs'];
export const OUTLIER_Z = 3;
const SPAN = 3;
const DEFAULT_DISTANCE = 8.5;
const DEFAULT_ROT: [number, number] = [0.3, -0.5];
const HELP = 'Arrow keys step through family centroids and outliers. Drag to rotate. Plus and minus zoom, 0 resets the view, Escape leaves the chart.';

export interface Centroid { family: number; n: number; norm: [number, number, number]; raw: [number, number, number] }
export interface CloudModel {
  families: string[];
  familyOf: number[];
  raw: [number[], number[], number[]];
  norm: [number[], number[], number[]];
  outliers: number[];
  outlierZ: number[];      // |z| per outlier, same order as outliers
  centroids: Centroid[];
}
export type Target = { kind: 'family'; index: number } | { kind: 'outlier'; index: number };

// Each axis to 0..1 over its metric domain; a missing or empty domain sits at the middle.
export function normalise(values: readonly number[], domain: readonly [number, number] | null | undefined): number[] {
  const span = domain ? domain[1] - domain[0] : 0;
  return values.map((v) => (span > 0 ? (v - domain![0]) / span : 0.5));
}

// Robust z of each point's single-core score: (x - p50) / mad of its "<label>|<cpuFamily>" byHardware group.
// null when the group is missing or its mad is 0 (SPEC 4.4).
export function robustZ(data: Pick<BenchmarksRollup, 'points' | 'byHardware'>, n: number): Array<number | null> {
  const p = data.points;
  const groups = new Map((data.byHardware?.singleCoreScore ?? []).map((g) => [g.key, g]));
  return Array.from({ length: n }, (_, i) => {
    const g = groups.get(`${p.labels[p.label[i] ?? -1]}|${p.families[p.family[i] ?? -1]}`);
    return g && g.mad > 0 ? (p.single[i]! - g.q.p50) / g.mad : null;
  });
}

export function buildModel(data: Pick<BenchmarksRollup, 'points' | 'metrics' | 'byHardware'>): CloudModel {
  const p = data.points;
  const n = Math.min(p.single.length, p.write.length, p.mem.length, p.family.length);
  const raw = [p.single.slice(0, n), p.write.slice(0, n), p.mem.slice(0, n)] as CloudModel['raw'];
  const norm = AXES.map((id, k) => normalise(raw[k]!, data.metrics.find((m) => m.id === id)?.domain)) as CloudModel['norm'];
  const outliers: number[] = [];
  const outlierZ: number[] = [];
  robustZ(data, n).forEach((z, i) => {
    if (z !== null && Math.abs(z) > OUTLIER_Z) {
      outliers.push(i);
      outlierZ.push(Math.abs(z));
    }
  });
  const familyOf = p.family.slice(0, n);
  const centroids: Centroid[] = [];
  p.families.forEach((_, f) => {
    const members = familyOf.map((x, i) => (x === f ? i : -1)).filter((i) => i >= 0);
    if (members.length === 0) return;
    const mean = (axis: readonly number[]): number => members.reduce((s, i) => s + (axis[i] ?? 0), 0) / members.length;
    centroids.push({
      family: f,
      n: members.length,
      norm: [mean(norm[0]), mean(norm[1]), mean(norm[2])],
      raw: [mean(raw[0]), mean(raw[1]), mean(raw[2])],
    });
  });
  return { families: p.families, familyOf, raw, norm, outliers, outlierZ, centroids };
}

export function targetsOf(model: CloudModel): Target[] {
  return [
    ...model.centroids.map((_, index): Target => ({ kind: 'family', index })),
    ...model.outliers.map((index): Target => ({ kind: 'outlier', index })),
  ];
}

// Normalised position (0..1 per axis) of a target.
export function targetNorm(model: CloudModel, t: Target): [number, number, number] {
  if (t.kind === 'family') return model.centroids[t.index]!.norm;
  const i = model.outliers[t.index]!;
  return [model.norm[0][i]!, model.norm[1][i]!, model.norm[2][i]!];
}

export function targetSentence(model: CloudModel, t: Target): string {
  const [s, w, m] = t.kind === 'family'
    ? model.centroids[t.index]!.raw
    : [model.raw[0][model.outliers[t.index]!]!, model.raw[1][model.outliers[t.index]!]!, model.raw[2][model.outliers[t.index]!]!];
  const axes = `single-core score ${groupDigits(Math.round(s))}, sequential write ${groupDigits(Math.round(w))} MB/s, memory bandwidth ${groupDigits(Math.round(m))} GB/s`;
  if (t.kind === 'family') {
    const c = model.centroids[t.index]!;
    return `${model.families[c.family]} centroid from ${c.n} ${c.n === 1 ? 'sample' : 'samples'}: ${axes}.`;
  }
  const i = model.outliers[t.index]!;
  const family = model.families[model.familyOf[i] ?? -1] ?? 'unknown family';
  return `Outlier, ${family}: ${axes}. Single-core score ${model.outlierZ[t.index]!.toFixed(1)} robust deviations from its group median.`;
}

const world = (n: number): number => (n - 0.5) * SPAN;

export default {
  panel: 'pointcloud',
  caption: (d: BenchmarksRollup) => headCaption(d),
  async mount(ctx: RenderContext, data: BenchmarksRollup): Promise<SceneHandle> {
    const lib = await import('three');
    const model = buildModel(data);
    const stage = new Stage(lib, ctx.tokens, ctx.width, '3D scatter of benchmark runs: single-core score, sequential write and memory bandwidth, coloured by CPU family');
    const chrome = buildChrome(ctx.root, 'pointcloud', HELP);
    chrome.stage.append(stage.renderer.domElement);
    const ac = new AbortController();
    twoDToggle(chrome, ac.signal);
    const resetBtn = chrome.button('Reset view');

    const cloud = new lib.Group();
    stage.scene.add(cloud);
    let done = false;
    const dispose = (): void => {
      if (done) return;
      done = true;
      ac.abort();
      stage.dispose();
    };
    ctx.signal.addEventListener('abort', dispose, { once: true });
    if (ctx.signal.aborted) dispose();

    // Family point clouds, one Points object per family so the legend can hide them.
    const familyMats: THREE.PointsMaterial[] = [];
    const familyGroups: THREE.Points[] = [];
    model.families.forEach((_, f) => {
      const members = model.familyOf.map((x, i) => (x === f ? i : -1)).filter((i) => i >= 0);
      const verts = new Float32Array(members.length * 3);
      members.forEach((i, k) => {
        verts[k * 3] = world(model.norm[0][i]!);
        verts[k * 3 + 1] = world(model.norm[1][i]!);
        verts[k * 3 + 2] = world(model.norm[2][i]!);
      });
      const mat = new lib.PointsMaterial({ size: 3, sizeAttenuation: false, color: ctx.tokens.series[f % 6] });
      const points = new lib.Points(new lib.BufferGeometry().setAttribute('position', new lib.BufferAttribute(verts, 3)), mat);
      familyMats.push(mat);
      familyGroups.push(points);
      cloud.add(points);
    });

    // Axes, with DOM labels at their ends.
    const h = SPAN / 2;
    const axisVerts = [-h, -h, -h, h, -h, -h, -h, -h, -h, -h, h, -h, -h, -h, -h, -h, -h, h];
    const axisMat = new lib.LineBasicMaterial({ color: ctx.tokens.ink2 });
    cloud.add(new lib.LineSegments(new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute(axisVerts, 3)), axisMat));
    const axisName = ['single-core score', 'write MB/s', 'memory GB/s'];
    const tags: Tag[] = [
      addTag(chrome.stage, axisName[0]!, new lib.Vector3(h + 0.15, -h, -h)),
      addTag(chrome.stage, axisName[1]!, new lib.Vector3(-h, h + 0.15, -h)),
      addTag(chrome.stage, axisName[2]!, new lib.Vector3(-h, -h, h + 0.15)),
    ];

    // Outlier marks: a small three-axis cross per outlier.
    const s = 0.04;
    const outlierVerts: number[] = [];
    for (const i of model.outliers) {
      const [x, y, z] = [world(model.norm[0][i]!), world(model.norm[1][i]!), world(model.norm[2][i]!)];
      outlierVerts.push(x - s, y, z, x + s, y, z, x, y - s, z, x, y + s, z, x, y, z - s, x, y, z + s);
    }
    const inkMat = new lib.LineBasicMaterial({ color: ctx.tokens.ink });
    cloud.add(new lib.LineSegments(new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute(outlierVerts, 3)), inkMat));

    // Cursor: a focus-coloured cross on the current centroid or outlier.
    const cc = 0.09;
    const focusMat = new lib.LineBasicMaterial({ color: ctx.tokens.focus });
    const cross = new lib.LineSegments(new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute([
      -cc, 0, 0, cc, 0, 0, 0, -cc, 0, 0, cc, 0, 0, 0, -cc, 0, 0, cc,
    ], 3)), focusMat);
    cross.visible = false;
    cloud.add(cross);

    // Legend: one toggle per family, drawn above the controls.
    const swatches: HTMLElement[] = [];
    const legend = document.createElement('div');
    legend.className = 'scene__legend';
    model.families.forEach((name, f) => {
      const swatch = document.createElement('span');
      swatch.className = 'scene__swatch';
      swatch.style.backgroundColor = ctx.tokens.series[f % 6];
      swatches.push(swatch);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'scene__button';
      toggle.setAttribute('aria-pressed', 'true');
      toggle.append(swatch, name);
      toggle.addEventListener('click', () => {
        const on = !familyGroups[f]!.visible;
        familyGroups[f]!.visible = on;
        toggle.setAttribute('aria-pressed', String(on));
        say(`${name} ${on ? 'shown' : 'hidden'}.`);
      }, { signal: ac.signal });
      legend.append(toggle);
    });
    chrome.controls.before(legend);

    const targets = targetsOf(model);
    let cursor = -1;
    let distance = DEFAULT_DISTANCE;
    let [rotX, rotY] = DEFAULT_ROT;
    const orient = (): void => {
      cloud.rotation.set(rotX, rotY, 0);
    };
    const frame = (): void => {
      stage.camera.position.set(0, 0, distance * fitScale(stage.camera.aspect));
      stage.camera.lookAt(0, 0, 0);
      orient();
      stage.render();
      placeTags(tags, stage.camera, stage.width, stage.height, cloud);
    };
    const say = (text: string): void => {
      chrome.readout.textContent = text;
      ctx.announce(text);
    };
    const moveCursor = (delta: number): string => {
      cursor = stepIndex(cursor, delta, targets.length);
      if (cursor < 0) return 'There are no runs to step through.';
      const t = targets[cursor]!;
      const [x, y, z] = targetNorm(model, t).map(world) as [number, number, number];
      cross.position.set(x, y, z);
      cross.visible = true;
      return targetSentence(model, t);
    };

    bindKeys(chrome.scene, (action) => {
      if (action === 'left' || action === 'up') say(moveCursor(-1));
      else if (action === 'right' || action === 'down') say(moveCursor(1));
      else if (action === 'zoomIn' || action === 'zoomOut') {
        distance = Math.min(13, Math.max(5, distance * zoomFactor(action)));
        frame();
        say(`Zoom ${Math.round((DEFAULT_DISTANCE / distance) * 100)} percent.`);
      } else if (action === 'reset') {
        [rotX, rotY] = DEFAULT_ROT;
        distance = DEFAULT_DISTANCE;
        frame();
        say('View reset.');
      } else if (action === 'pause') say('The point cloud has no motion to pause.');
      else return;
      frame();
    }, ac.signal);

    // Drag to rotate.
    let drag: { x: number; y: number } | null = null;
    const canvas = stage.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    }, { signal: ac.signal });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      rotY += (e.clientX - drag.x) * 0.01;
      rotX = Math.min(1.2, Math.max(-1.2, rotX + (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
      frame();
    }, { signal: ac.signal });
    const endDrag = (): void => { drag = null; };
    canvas.addEventListener('pointerup', endDrag, { signal: ac.signal });
    canvas.addEventListener('pointercancel', endDrag, { signal: ac.signal });

    resetBtn.addEventListener('click', () => {
      [rotX, rotY] = DEFAULT_ROT;
      distance = DEFAULT_DISTANCE;
      frame();
      say('View reset.');
    }, { signal: ac.signal });

    chrome.readout.textContent = targets.length ? 'Use the arrow keys to step through the centroids and outliers.' : 'No runs to plot yet.';
    frame();

    return {
      setPaused: () => {},
      setTokens(tokens: ChartTokens) {
        familyMats.forEach((m, f) => m.color.set(tokens.series[f % 6] ?? tokens.ink));
        swatches.forEach((sw, f) => { sw.style.backgroundColor = tokens.series[f % 6] ?? tokens.ink; });
        axisMat.color.set(tokens.ink2);
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
} satisfies SceneModule<BenchmarksRollup>;
