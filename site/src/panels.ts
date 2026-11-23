// Registry of every panel. Chart and scene modules load lazily; a missing module rejects, so the shell shows the error state.
import type { RollupName, TierId } from '../../shared/types/rollups.ts';
import type { ChartModule, PanelDef, PanelId, SceneModule, SheetId } from './types/views.ts';

type PanelModule = { default: ChartModule<never> | SceneModule<never> };
type Loader = () => Promise<PanelModule>;

const chartLoaders = import.meta.glob<PanelModule>('./charts/*.ts');
const sceneLoaders = import.meta.glob<PanelModule>('./scenes/*.ts');

function loaderFor(map: Record<string, Loader>, key: string): Loader {
  const load = map[key];
  return load ?? (() => Promise.reject(new Error(`no module at ${key}`)));
}

function chart(id: PanelId, sheet: SheetId | 'hero', tier: TierId, rollup: RollupName, title: string, question: string): PanelDef {
  return { id, sheet, tier, rollup, title, question, kind: 'chart', load: loaderFor(chartLoaders, `./charts/${id}.ts`) as PanelDef['load'] };
}

function scene(id: PanelId, sheet: SheetId, tier: TierId, rollup: RollupName, title: string, question: string, fallbackId: PanelId): PanelDef {
  return {
    id, sheet, tier, rollup, title, question, kind: 'scene',
    load: loaderFor(sceneLoaders, `./scenes/${id}.ts`) as PanelDef['load'],
    fallback: loaderFor(chartLoaders, `./charts/${fallbackId}.ts`) as NonNullable<PanelDef['fallback']>,
  };
}

// pointcloud-2d has no tier row of its own; it is only the fallback for pointcloud (SPEC 6.3).
export const panels: PanelDef[] = [
  chart('region-map', 'hero', 'day1', 'regions', 'Region map', 'Where each region is and how many samples it contributed.'),
  chart('fleet-sankey', 'fleet', 'day1', 'fleet', 'Fleet mix', 'Which labels, CPU families and regions make up the fleet.'),
  chart('fleet-table', 'fleet', 'day1', 'fleet', 'Fleet by label', 'How many samples each label and region produced.'),
  chart('recent-samples', 'fleet', 'day1', 'fleet', 'Recent samples', 'The latest measured runs, newest first.'),
  scene('globe', 'fleet', 'day1', 'regions', 'Globe preview', 'Where the sampled regions sit on the planet.', 'region-map'),
  chart('ridgelines', 'benchmarks', 'day3', 'benchmarks', 'Speed by label', 'How each label spreads across each benchmark.'),
  chart('beeswarm', 'benchmarks', 'day3', 'benchmarks', 'Runs by label', 'Each sample as a dot, placed by its score.'),
  scene('pointcloud', 'benchmarks', 'day3', 'benchmarks', 'Runs by speed, write and memory', 'Each run as a point on single-core speed, sequential write and memory. The 3D view rotates; the 2D view sizes each dot by write speed.', 'pointcloud-2d'),
  chart('drift-heatmap', 'drift', 'day7', 'drift', 'Start delay by slot', 'Median total delay for each hour and weekday.'),
  scene('terrain', 'drift', 'day7', 'drift', 'Delay terrain', 'How delay rises and falls across the week.', 'drift-heatmap'),
  chart('slot-ranking', 'drift', 'day7', 'drift', 'Best and worst slots', 'The quickest and slowest scheduling slots, with intervals.'),
  chart('neighbours-scatter', 'neighbours', 'day14', 'neighbours', 'Steal against score', 'Whether CPU steal on Linux runners predicts slower scores.'),
  chart('neighbours-multiples', 'neighbours', 'day14', 'neighbours', 'Steal by label and family', 'The same steal relationship, split by label and CPU family.'),
  chart('rollout-timeline', 'rollouts', 'day30', 'rollouts', 'Runner image share over time', 'How the runner mix moved day by day, with change points marked.'),
  chart('changepoints', 'rollouts', 'day30', 'rollouts', 'Change points', 'Days where speed or mix shifted, and the evidence.'),
  chart('seasonality-bands', 'seasonality', 'day90', 'seasonality', 'Speed bands across the cycle', 'The typical range of speed on each day of the survey.'),
  chart('seasonality-effects', 'seasonality', 'day90', 'seasonality', 'Weekday and hour effects', 'How far each weekday and hour sits from the average.'),
];

export function panelById(id: string): PanelDef | undefined {
  return panels.find((p) => p.id === id);
}
