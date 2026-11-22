import type { RollupName, TierId, Manifest, FleetRollup, BenchmarksRollup, DriftRollup, NeighboursRollup, RolloutsRollup, SeasonalityRollup, RegionsRollup } from '../../../shared/types/rollups.ts';

export interface RollupMap { fleet: FleetRollup; benchmarks: BenchmarksRollup; drift: DriftRollup; neighbours: NeighboursRollup; rollouts: RolloutsRollup; seasonality: SeasonalityRollup; regions: RegionsRollup }
export type SheetId = 'fleet' | 'benchmarks' | 'drift' | 'neighbours' | 'rollouts' | 'seasonality';
export type PanelId = 'region-map' | 'fleet-sankey' | 'fleet-table' | 'recent-samples' | 'globe' | 'ridgelines' | 'beeswarm' | 'pointcloud' | 'pointcloud-2d' | 'drift-heatmap' | 'terrain' | 'slot-ranking' | 'neighbours-scatter' | 'neighbours-multiples' | 'rollout-timeline' | 'changepoints' | 'seasonality-bands' | 'seasonality-effects';

export interface ChartTokens {                       // all hex strings, read by site/src/lib/tokens.ts
  paper: string; paper2: string; ink: string; ink2: string; muted: string; rule: string; accent: string; focus: string; warn: string;
  series: readonly [string, string, string, string, string, string];
  sequential: readonly [string, string, string, string, string, string, string];
  diverging: { low: string; mid: string; high: string };
  fontBody: string; fontFigure: string;
}
export interface Caption { n: number; unit: 'samples' | 'runs'; runs?: number; range: { from: string; to: string } | null; note?: string }
export interface RenderContext {
  readonly root: HTMLElement;          // empty element the module owns
  readonly tokens: ChartTokens;
  readonly reducedMotion: boolean;
  readonly signal: AbortSignal;        // aborted before re-render (theme or resize) and on teardown
  readonly width: number;              // content width in px
  announce(message: string): void;     // shell's polite live region
}
export interface ChartModule<D> { readonly panel: PanelId; caption(data: D): Caption; render(ctx: RenderContext, data: D): void }
export interface SceneHandle { setPaused(paused: boolean): void; setTokens(tokens: ChartTokens): void; resize(width: number, height: number): void; dispose(): void }
export interface SceneModule<D> { readonly panel: PanelId; caption(data: D): Caption; mount(ctx: RenderContext, data: D): Promise<SceneHandle> }
export interface PanelDef<R extends RollupName = RollupName> {
  id: PanelId; sheet: SheetId | 'hero'; tier: TierId | 'day0'; rollup: R;
  title: string; question: string;     // sentence case; question is the one sentence the panel answers
  kind: 'chart' | 'scene';
  load(): Promise<{ default: ChartModule<RollupMap[R]> | SceneModule<RollupMap[R]> }>;
  fallback?: () => Promise<{ default: ChartModule<RollupMap[R]> }>;   // required when kind === 'scene'
}
export type { Manifest, RollupName, TierId };
