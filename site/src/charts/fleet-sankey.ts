// Label -> CPU family -> region flow. Link colour follows the runner label the flow starts from.
import { sankey, sankeyLinkHorizontal } from 'd3-sankey';
import type { FleetRollup } from '../../../shared/types/rollups.ts';
import type { ChartModule, RenderContext } from '../types/views.ts';
import { chartWidth, chartWrap, count, emptyNote, headCaption, labelColor, summaryTable, svgEl, svgFor, svgText, tooltip } from './_axis.ts';

const CHAR_W = 6.7;

interface Node { id: string; kind: string; name: string; x0?: number; x1?: number; y0?: number; y1?: number }
interface Link { source: string | Node; target: string | Node; value: number; width?: number }

function render(ctx: RenderContext, data: FleetRollup): void {
  const { tokens } = ctx;
  const width = chartWidth(ctx);
  const height = Math.min(420, Math.max(260, Math.round(width * 0.6)));
  const wrap = chartWrap(ctx);

  // The rollup is shared with the table panels, so the layout works on copies.
  const nodes: Node[] = data.sankey.nodes.map((n) => ({ ...n }));
  const links: Link[] = data.sankey.links.map((l) => ({ ...l }));

  if (links.length === 0) {
    svgFor(wrap, width, height, 'Fleet mix: no flows yet.');
    emptyNote(wrap, 'No runner flows yet. The mix appears once samples arrive.');
    summaryTable(wrap, 'Fleet mix', ['From', 'To', 'Samples'], []);
    return;
  }

  const graph = sankey<Node, Omit<Link, 'source' | 'target'>>()
    .nodeId((d) => d.id)
    .nodeWidth(12)
    .nodePadding(10)
    .extent([[1, 1], [width - 1, height - 1]])({ nodes, links: links as never });

  // Label flows wear their label's series. A CPU family fed by exactly one label passes that colour on to its
  // region flows; a family shared by labels cannot say which label reached which region, so those flows stay muted.
  const colourOf = new Map<string, string>();
  const feeders = new Map<string, Set<string>>();
  for (const link of graph.links) {
    const source = link.source as Node;
    const target = link.target as Node;
    if (source.kind !== 'label') continue;
    colourOf.set(source.id, labelColor(tokens, source.name));
    feeders.set(target.id, (feeders.get(target.id) ?? new Set()).add(source.name));
  }
  for (const [id, set] of feeders) if (set.size === 1) colourOf.set(id, labelColor(tokens, [...set][0] ?? null));

  const svg = svgFor(wrap, width, height, `Fleet mix: ${data.labels.length} labels, flowing through CPU families to regions.`);
  const linkPath = sankeyLinkHorizontal();
  for (const link of graph.links) {
    const source = link.source as Node;
    const target = link.target as Node;
    const colour = colourOf.get(source.id) ?? tokens.muted;
    const path = svgEl('path', {
      class: 'chart__mark',
      d: linkPath(link as never) ?? '',
      fill: 'none',
      stroke: colour,
      'stroke-opacity': 0.4,
      'stroke-width': Math.max(1, link.width ?? 1),
    });
    svg.append(path);
    tooltip(ctx, wrap, path, `${source.name} to ${target.name}: n = ${count(link.value)} samples`);
  }

  type Placed = Node & { x0: number; x1: number; y0: number; y1: number; value?: number };
  const placed = graph.nodes as unknown as Placed[];
  // Region labels sit left of the last column; a CPU family label that would run into one is shortened (its full name is in the tooltip and table).
  const regionLabels = placed.filter((n) => n.x0 >= width / 2).map((n) => ({ y: (n.y0 + n.y1) / 2, left: n.x0 - 6 - n.name.length * CHAR_W }));
  for (const n of placed) {
    const rect = svgEl('rect', { x: n.x0, y: n.y0, width: n.x1 - n.x0, height: Math.max(1, n.y1 - n.y0), fill: tokens.ink2 });
    svg.append(rect);
    tooltip(ctx, wrap, rect, `${n.name}: n = ${count(n.value ?? 0)} samples`);
  }
  for (const n of placed) {
    const right = n.x0 < width / 2;
    const mid = (n.y0 + n.y1) / 2;
    let name = n.name;
    if (right && n.kind !== 'label') {
      const limit = Math.min(width, ...regionLabels.filter((r) => Math.abs(r.y - mid) < 13).map((r) => r.left)) - n.x1 - 10;
      const chars = Math.floor(limit / CHAR_W);
      if (chars < name.length) name = `${name.slice(0, Math.max(3, chars - 1))}\u2026`;
    }
    svgText(svg, right ? n.x1 + 6 : n.x0 - 6, mid + 4, name, {
      'text-anchor': right ? 'start' : 'end',
      fill: tokens.ink,
      class: 'chart__halo',
      'aria-hidden': 'true',
    });
  }

  summaryTable(wrap, 'Fleet mix flows', ['From', 'To', 'Samples'],
    graph.links.map((l) => [(l.source as Node).name, (l.target as Node).name, count(l.value)]));
}

export default {
  panel: 'fleet-sankey',
  caption: (data: FleetRollup) => headCaption(data),
  render,
} satisfies ChartModule<FleetRollup>;
