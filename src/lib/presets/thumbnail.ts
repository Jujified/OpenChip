/**
 * Preview geometry for a template card.
 *
 * Rendered from the preset's own `channelGraph` through the same `solveLoft`
 * the canvas and the CSG sweep use, rather than shipping static images. A
 * picture that is generated from the data cannot drift away from it — edit a
 * template and its thumbnail is already correct — and seven PNGs are seven more
 * things to keep in step for no benefit.
 *
 * Pure data out: no colours, no React. The component paints it with theme
 * tokens so a card looks right in both schemes from one source.
 */

import { getLoft } from '../loft';
import { edgeCurve, nodeIndex, nodePoint, perpendicular } from '../geometry';
import { portFootprintMm } from '../ports';
import type { ChannelGraph, ChipParams, Point2 } from '../../types/project';

export interface ThumbnailPort {
  x: number;
  y: number;
  /** Outer footprint radius, mm. */
  r: number;
  /** Bore radius, mm. */
  bore: number;
}

export interface PresetThumbnail {
  /** Chip-space extents, mm. The component supplies its own padding. */
  widthMm: number;
  lengthMm: number;
  /** Filled outlines of every channel at its true local width. */
  ribbons: string[];
  /** Centerlines, drawn hairline over the ribbons so thin channels stay visible. */
  centerlines: string[];
  ports: ThumbnailPort[];
  chambers: { x: number; y: number; r: number }[];
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

export function buildThumbnail(graph: ChannelGraph, chipParams: ChipParams): PresetThumbnail {
  const loft = getLoft(graph, chipParams);
  const nodes = nodeIndex(graph.nodes);

  const ribbons: string[] = [];
  const centerlines: string[] = [];

  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;

    const solved = loft.edges.get(edge.id);
    if (solved && solved.samples.length > 1) {
      const left: Point2[] = [];
      const right: Point2[] = [];

      for (const sample of solved.samples) {
        const normal = perpendicular(sample.tangent);
        const half = sample.widthMm / 2;
        left.push({
          x: sample.point.x + normal.x * half,
          y: sample.point.y + normal.y * half,
        });
        right.push({
          x: sample.point.x - normal.x * half,
          y: sample.point.y - normal.y * half,
        });
      }

      const ring = [...left, ...right.reverse()];
      ribbons.push(
        `${ring.map((p, i) => `${i === 0 ? 'M' : 'L'} ${f(p.x)} ${f(p.y)}`).join(' ')} Z`,
      );
    }

    const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
    centerlines.push(
      `M ${f(curve.p0.x)} ${f(curve.p0.y)} C ${f(curve.c0.x)} ${f(curve.c0.y)}, ` +
        `${f(curve.c1.x)} ${f(curve.c1.y)}, ${f(curve.p1.x)} ${f(curve.p1.y)}`,
    );
  }

  const ports: ThumbnailPort[] = [];
  const chambers: { x: number; y: number; r: number }[] = [];

  for (const node of graph.nodes) {
    if (node.type === 'port') {
      ports.push({
        x: node.x,
        y: node.y,
        r: portFootprintMm(node.portType, node.customSpec) / 2,
        bore: node.diameterMm / 2,
      });
    } else if (node.type === 'chamber') {
      chambers.push({ x: node.x, y: node.y, r: node.sizeMm / 2 });
    }
  }

  return {
    widthMm: chipParams.width,
    lengthMm: chipParams.length,
    ribbons,
    centerlines,
    ports,
    chambers,
  };
}
