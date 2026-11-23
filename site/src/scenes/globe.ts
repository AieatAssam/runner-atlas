// Telemetry globe (SPEC 7.3): one pylon per region, height by sample volume, ring radius by median TTFB,
// pylon colour on the sequential ramp by median total delay.
// The globe spins slowly when idle; it stops on hover, focus, pause or reduced motion.
import type * as THREE from 'three';
import type * as TopoJSON from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { RegionsRollup } from '../../../shared/types/rollups.ts';
import { formatDuration, groupDigits } from '../lib/format.ts';
import type { ChartTokens, RenderContext, SceneHandle, SceneModule } from '../types/views.ts';
import { FrameLoop, Stage, addTag, bindKeys, buildChrome, headCaption, placeTags, rampIndex, stepIndex, twoDToggle, watchVisible, type Tag } from './_common.ts';

export const SPIN_DEG_PER_SEC = 6;
const RADIUS = 1;
const DEFAULT_DISTANCE = 5.4;
const DEFAULT_TILT = 0.35;
const HELP = 'Arrow keys step through regions. Drag to rotate. Space pauses the spin. Plus and minus zoom, 0 resets the view, Escape leaves the globe.';

export type LatLon = readonly [lat: number, lon: number];

// Unit-sphere point. Longitude 0 sits on +z; latitude 90 on +y.
export function latLonToVector(lat: number, lon: number, r = RADIUS): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  return [r * Math.cos(phi) * Math.sin(lambda), r * Math.sin(phi), r * Math.cos(phi) * Math.cos(lambda)];
}

// Rotation about y (radians) that turns longitude `lon` to face the camera at +z.
export function yawToFace(lon: number): number {
  return -(lon * Math.PI) / 180;
}

// Pylon height above the surface: 0 for an empty region, scaling with the square root of its sample count.
export function pylonHeight(samples: number, maxSamples: number): number {
  if (samples <= 0 || maxSamples <= 0) return 0;
  return 0.04 + 0.45 * Math.sqrt(Math.min(1, samples / maxSamples));
}

// Ring radius from a 0..1 fraction (median TTFB over the largest regional median).
export function ringRadius(share: number): number {
  return 0.03 + 0.1 * Math.sqrt(Math.min(1, Math.max(0, share)));
}

// Region indices, busiest first; ties broken by name so the cursor order is stable.
export function regionOrder(regions: RegionsRollup['regions']): number[] {
  return regions
    .map((_, i) => i)
    .sort((a, b) => regions[b]!.samples - regions[a]!.samples || regions[a]!.region.localeCompare(regions[b]!.region));
}

// Graticule polylines: meridians every `step` degrees, parallels between the poles at the same spacing.
export function graticule(step: number): { meridians: LatLon[][]; parallels: LatLon[][] } {
  const meridians: LatLon[][] = [];
  const parallels: LatLon[][] = [];
  for (let lon = -180; lon < 180; lon += step) {
    const line: LatLon[] = [];
    for (let lat = -90; lat <= 90; lat += 2) line.push([lat, lon]);
    meridians.push(line);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const line: LatLon[] = [];
    for (let lon = -180; lon <= 180; lon += 2) line.push([lat, lon]);
    parallels.push(line);
  }
  return { meridians, parallels };
}

// Flat sentence for the cursor readout.
export function regionSentence(r: RegionsRollup['regions'][number], totalSamples: number): string {
  const share = totalSamples > 0 ? Math.round((r.samples / totalSamples) * 1000) / 10 : 0;
  const ttfb = r.ttfbMedianMs === null ? 'no time-to-first-byte median yet' : `median time to first byte ${groupDigits(Math.round(r.ttfbMedianMs))} ms`;
  const delay = r.totalDelayMedianSec === null ? 'no queue-delay median yet' : `median total delay ${formatDuration(r.totalDelayMedianSec)}`;
  return `${r.region}: ${groupDigits(r.samples)} samples, ${share} percent of all samples, ${ttfb}, ${delay}.`;
}

export default {
  panel: 'globe',
  caption: (d: RegionsRollup) => headCaption(d),
  async mount(ctx: RenderContext, data: RegionsRollup): Promise<SceneHandle> {
    const [lib, topo, worldJson] = await Promise.all([
      import('three'),
      import('topojson-client') as Promise<typeof TopoJSON>,
      import('world-atlas/land-110m.json', { with: { type: 'json' } }).then((m) => m.default),
    ]);
    const regions = data.regions;
    const order = regionOrder(regions);
    const total = regions.reduce((s, r) => s + r.samples, 0);
    const maxSamples = Math.max(0, ...regions.map((r) => r.samples));

    const stage = new Stage(lib, ctx.tokens, ctx.width, 'Three-dimensional globe of runner regions, with pylon height by sample volume');
    const chrome = buildChrome(ctx.root, 'globe', HELP);
    chrome.stage.append(stage.renderer.domElement);
    const ac = new AbortController();
    twoDToggle(chrome, ac.signal);
    const pauseBtn = chrome.button('Pause motion', false);
    const resetBtn = chrome.button('Reset view');

    const globe = new lib.Group();
    stage.scene.add(globe);
    // Start, and reset, facing the sample-weighted mean longitude, so the pylons stand face-on, not on the limb.
    const homeYaw = yawToFace(total > 0 ? regions.reduce((s, r) => s + r.lon * r.samples, 0) / total : 0);
    globe.rotation.y = homeYaw;
    // White lights summing to about 1 (three's Lambert divides by pi), so lit faces show the token colour.
    stage.scene.add(new lib.AmbientLight(undefined, Math.PI * 0.72));
    const sun = new lib.DirectionalLight(undefined, Math.PI * 0.3);
    sun.position.set(2, 3, 4);
    stage.scene.add(sun);

    let done = false;
    let paused = false;
    let hovering = false;
    let focused = false;
    let visible = true;
    let distance = DEFAULT_DISTANCE;
    let tilt = DEFAULT_TILT;
    let cursor = -1;

    // Sphere body: the ocean.
    const sphereMat = new lib.MeshLambertMaterial({ color: ctx.tokens.paper });
    globe.add(new lib.Mesh(new lib.SphereGeometry(RADIUS, 48, 32), sphereMat));

    // Graticule every 15 degrees.
    const grid = graticule(15);
    const gridVerts: number[] = [];
    for (const line of [...grid.meridians, ...grid.parallels]) {
      for (let i = 1; i < line.length; i++) {
        const [x0, y0, z0] = latLonToVector(line[i - 1]![0], line[i - 1]![1], RADIUS * 1.001);
        const [x1, y1, z1] = latLonToVector(line[i]![0], line[i]![1], RADIUS * 1.001);
        gridVerts.push(x0, y0, z0, x1, y1, z1);
      }
    }
    const gridMat = new lib.LineBasicMaterial({ color: ctx.tokens.rule });
    globe.add(new lib.LineSegments(new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute(gridVerts, 3)), gridMat));

    // Land outlines from the 110m coastline mesh.
    const world = worldJson as unknown as Topology<{ land: GeometryCollection }>;
    const coast = topo.mesh(world, world.objects.land);
    const coastVerts: number[] = [];
    for (const line of coast.coordinates as Array<Array<[number, number]>>) {
      for (let i = 1; i < line.length; i++) {
        const [lon0, lat0] = line[i - 1]!;
        const [lon1, lat1] = line[i]!;
        const a = latLonToVector(lat0, lon0, RADIUS * 1.002);
        const b = latLonToVector(lat1, lon1, RADIUS * 1.002);
        coastVerts.push(...a, ...b);
      }
    }
    const coastMat = new lib.LineBasicMaterial({ color: ctx.tokens.ink2 });
    globe.add(new lib.LineSegments(new lib.BufferGeometry().setAttribute('position', new lib.Float32BufferAttribute(coastVerts, 3)), coastMat));

    // Pylons coloured on the sequential ramp by median total delay (rule colour when unknown); rings sized by median TTFB.
    const delays = regions.map((r) => r.totalDelayMedianSec).filter((v): v is number => v !== null);
    const delayMin = delays.length ? Math.min(...delays) : null;
    const delayMax = delays.length ? Math.max(...delays) : null;
    const maxTtfb = Math.max(0, ...regions.map((r) => r.ttfbMedianMs ?? 0));
    const steps = regions.map((r) => rampIndex(r.totalDelayMedianSec, delayMin, delayMax, ctx.tokens.sequential.length));
    const pylonColour = (tokens: ChartTokens, step: number): string => (step < 0 ? tokens.rule : tokens.sequential[step] ?? tokens.rule);
    const pylonMats: THREE.MeshLambertMaterial[] = [];
    const ringMat = new lib.MeshLambertMaterial({ color: ctx.tokens.ink, transparent: true, opacity: 0.6 });
    const up = new lib.Vector3(0, 1, 0);
    const anchors: THREE.Vector3[] = [];
    regions.forEach((r, k) => {
      const normal = new lib.Vector3(...latLonToVector(r.lat, r.lon, 1));
      const height = pylonHeight(r.samples, maxSamples);
      const pylonMat = new lib.MeshLambertMaterial({ color: pylonColour(ctx.tokens, steps[k]!) });
      pylonMats.push(pylonMat);
      const pylon = new lib.Mesh(new lib.CylinderGeometry(0.018, 0.018, height, 6), pylonMat);
      pylon.quaternion.setFromUnitVectors(up, normal);
      pylon.position.copy(normal.clone().multiplyScalar(RADIUS + height / 2));
      globe.add(pylon);

      if (r.ttfbMedianMs !== null && maxTtfb > 0) {
        const outer = ringRadius(r.ttfbMedianMs / maxTtfb);
        const ring = new lib.Mesh(new lib.RingGeometry(outer * 0.8, outer, 32), ringMat);
        ring.quaternion.setFromUnitVectors(new lib.Vector3(0, 0, 1), normal);
        ring.position.copy(normal.clone().multiplyScalar(RADIUS * 1.003));
        globe.add(ring);
      }
      anchors.push(normal.clone().multiplyScalar(RADIUS + height + 0.04));
    });

    // Cursor: a focus-coloured marker on the current region.
    const cursorMat = new lib.MeshLambertMaterial({ color: ctx.tokens.focus });
    const cursorMark = new lib.Mesh(new lib.SphereGeometry(0.035, 12, 8), cursorMat);
    cursorMark.visible = false;
    globe.add(cursorMark);
    const tag: Tag = addTag(chrome.stage, '', new lib.Vector3());
    tag.el.hidden = true;

    const spinning = (): boolean => !paused && !ctx.reducedMotion && !hovering && !focused && visible && !done;
    const loop = new FrameLoop((dt) => {
      globe.rotation.y += (SPIN_DEG_PER_SEC * Math.PI / 180) * dt;
      frame();
    }, spinning);

    const frame = (): void => {
      stage.camera.position.set(0, 0, distance);
      stage.camera.lookAt(0, 0, 0);
      globe.rotation.x = tilt;
      stage.render();
      placeTags([tag], stage.camera, stage.width, stage.height, globe);
    };
    const setPauseLabel = (): void => {
      pauseBtn.setAttribute('aria-pressed', String(paused));
    };
    const say = (text: string): void => {
      chrome.readout.textContent = text;
      ctx.announce(text);
    };
    const moveCursor = (delta: number): string => {
      cursor = stepIndex(cursor, delta, order.length);
      if (cursor < 0) return 'No regions to step through.';
      const r = regions[order[cursor]!]!;
      const [x, y, z] = anchors[order[cursor]!]!.toArray();
      cursorMark.position.set(...latLonToVector(r.lat, r.lon, RADIUS * 1.01));
      cursorMark.visible = true;
      tag.el.textContent = r.region;
      tag.el.hidden = false;
      tag.at.set(x!, y!, z!);
      // Spin the globe so the region faces the camera.
      globe.rotation.y = yawToFace(r.lon);
      return regionSentence(r, total);
    };

    bindKeys(chrome.scene, (action) => {
      if (action === 'left' || action === 'up') say(moveCursor(-1));
      else if (action === 'right' || action === 'down') say(moveCursor(1));
      else if (action === 'zoomIn' || action === 'zoomOut') {
        distance = Math.min(8, Math.max(3, distance * (action === 'zoomIn' ? 0.85 : 1 / 0.85)));
        say(`Zoom ${Math.round((DEFAULT_DISTANCE / distance) * 100)} percent.`);
      } else if (action === 'reset') {
        distance = DEFAULT_DISTANCE;
        tilt = DEFAULT_TILT;
        globe.rotation.y = homeYaw;
        say('View reset.');
      } else if (action === 'pause') {
        paused = !paused;
        setPauseLabel();
        say(paused ? 'Spin paused.' : 'Spin resumed.');
        loop.sync();
      } else return;
      frame();
      loop.sync();
    }, ac.signal);

    const dispose = (): void => {
      if (done) return;
      done = true;
      ac.abort();
      loop.dispose();
      disconnect();
      stage.dispose();
    };
    const disconnect = watchVisible(ctx.root, (v) => {
      visible = v;
      loop.sync();
    });
    ctx.signal.addEventListener('abort', dispose, { once: true });
    if (ctx.signal.aborted) dispose();

    // Pause the spin while the pointer is over the globe or focus is inside it.
    const canvas = stage.renderer.domElement;
    canvas.addEventListener('pointerenter', () => { hovering = true; loop.sync(); }, { signal: ac.signal });
    canvas.addEventListener('pointerleave', () => { hovering = false; loop.sync(); }, { signal: ac.signal });
    chrome.scene.addEventListener('focusin', () => { focused = true; loop.sync(); }, { signal: ac.signal });
    chrome.scene.addEventListener('focusout', () => { focused = false; loop.sync(); }, { signal: ac.signal });

    // Drag to tilt and spin.
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    }, { signal: ac.signal });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      globe.rotation.y += (e.clientX - drag.x) * 0.005;
      tilt = Math.min(1.2, Math.max(-1.2, tilt + (e.clientY - drag.y) * 0.005));
      drag = { x: e.clientX, y: e.clientY };
      frame();
    }, { signal: ac.signal });
    const endDrag = (): void => { drag = null; };
    canvas.addEventListener('pointerup', endDrag, { signal: ac.signal });
    canvas.addEventListener('pointercancel', endDrag, { signal: ac.signal });

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      setPauseLabel();
      say(paused ? 'Spin paused.' : 'Spin resumed.');
      loop.sync();
    }, { signal: ac.signal });
    resetBtn.addEventListener('click', () => {
      distance = DEFAULT_DISTANCE;
      tilt = DEFAULT_TILT;
      globe.rotation.y = homeYaw;
      frame();
      say('View reset.');
    }, { signal: ac.signal });

    chrome.readout.textContent = regions.length ? 'Use the arrow keys to step through the regions.' : 'No regions to plot yet.';
    frame();
    loop.sync();

    return {
      setPaused(p: boolean) {
        paused = p;
        setPauseLabel();
        loop.sync();
      },
      setTokens(tokens: ChartTokens) {
        sphereMat.color.set(tokens.paper);
        gridMat.color.set(tokens.rule);
        coastMat.color.set(tokens.ink2);
        pylonMats.forEach((m, k) => m.color.set(pylonColour(tokens, steps[k]!)));
        ringMat.color.set(tokens.ink);
        cursorMat.color.set(tokens.focus);
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
} satisfies SceneModule<RegionsRollup>;
