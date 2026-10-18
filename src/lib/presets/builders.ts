/**
 * Construction helpers for the starter templates.
 *
 * Everything here produces plain `channelGraph` data — the same shape the
 * drawing tools emit. A template is not a special kind of project: once it is
 * loaded there is nothing left to distinguish it from a chip the user drew by
 * hand, which is the whole point of the library.
 *
 * Node ids are **deterministic** (`serpentine-n7`, not a UUID). Two builds of
 * the same preset produce byte-identical graphs, so a thumbnail can be rendered
 * without touching the store, the geometry can be asserted in a test, and a
 * `.openchip` file made from a template diffs cleanly against the template it
 * came from.
 */

import type {
  ChannelEdge,
  ChannelGraph,
  ChannelNode,
  CrossSection,
  DimensionPoint,
  Point2,
  PortType,
} from '../../types/project';
import { findFitting } from '../ports';

export interface BuilderDefaults {
  crossSection: CrossSection;
  widthMm: number;
  heightMm: number;
}

/**
 * An append-only graph under construction.
 *
 * Deliberately a small mutable builder rather than the pure operations in
 * `graphOps`: those exist to make *user edits* undoable, and paying immutable
 * copy costs to lay down ninety nodes nobody can undo would be ceremony.
 */
export class GraphBuilder {
  readonly nodes: ChannelNode[] = [];
  readonly edges: ChannelEdge[] = [];
  private counter = 0;

  private readonly prefix: string;
  private readonly defaults: BuilderDefaults;

  constructor(prefix: string, defaults: BuilderDefaults) {
    this.prefix = prefix;
    this.defaults = defaults;
  }

  private nextId(kind: string): string {
    this.counter += 1;
    return `${this.prefix}-${kind}${this.counter}`;
  }

  /** A plain vertex. */
  waypoint(x: number, y: number): string {
    const id = this.nextId('n');
    this.nodes.push({ id, x, y, type: 'waypoint' });
    return id;
  }

  /**
   * An inlet or outlet, cut for a named fitting.
   *
   * Templates ship with real fittings rather than bare holes because a starter
   * chip a user cannot physically connect anything to is not a starting point.
   */
  port(x: number, y: number, fittingId: string): string {
    const id = this.nextId('p');
    const fitting = findFitting(fittingId);
    const portType: PortType = fitting?.portType ?? 'luer';
    this.nodes.push({
      id,
      x,
      y,
      type: 'port',
      portType,
      diameterMm: fitting?.boreMm ?? 1.6,
      customSpec: { ...(fitting?.spec ?? {}) },
    });
    return id;
  }

  chamber(x: number, y: number, sizeMm: number, shape: 'sphere' | 'cylinder' = 'sphere'): string {
    const id = this.nextId('c');
    this.nodes.push({ id, x, y, type: 'chamber', shape, sizeMm, autoPlaced: false });
    return id;
  }

  /** Joins two nodes. `dimensionPoints` left empty means "the project default width". */
  connect(
    fromNodeId: string,
    toNodeId: string,
    options: {
      controlPoints?: Point2[];
      crossSection?: CrossSection;
      dimensionPoints?: DimensionPoint[];
    } = {},
  ): string {
    const id = this.nextId('e');
    this.edges.push({
      id,
      fromNodeId,
      toNodeId,
      curveType: options.controlPoints ? 'bezier' : 'straight',
      ...(options.controlPoints ? { controlPoints: options.controlPoints } : {}),
      crossSection: options.crossSection ?? this.defaults.crossSection,
      dimensionPoints: options.dimensionPoints ?? [],
    });
    return id;
  }

  /** Lays down a run of waypoints and the straight segments between them. */
  polyline(points: Point2[], startNodeId?: string): string[] {
    const ids: string[] = [];
    let previous = startNodeId ?? null;

    for (const point of points) {
      const id = this.waypoint(point.x, point.y);
      ids.push(id);
      if (previous) this.connect(previous, id);
      previous = id;
    }

    return ids;
  }

  build(): ChannelGraph {
    return { nodes: [...this.nodes], edges: [...this.edges] };
  }
}

// ---------------------------------------------------------------------------
// curve helpers
// ---------------------------------------------------------------------------

/**
 * Cubic handles that make an arc-like step read as a true curve.
 *
 * `k = (4/3)·tan(Δθ/4)` is the standard circular-arc approximation; scaling it
 * by the local speed |dP/dθ| generalises it to a spiral, where the radius is
 * changing as the angle sweeps. At 45° steps the error is under a thousandth of
 * a millimetre — small enough that a 24-segment spiral is smooth rather than a
 * visibly faceted polygon, without paying for hundreds of nodes the user would
 * then have to drag around.
 */
export function arcHandles(
  from: Point2,
  to: Point2,
  tangentFrom: Point2,
  tangentTo: Point2,
  deltaThetaRad: number,
): Point2[] {
  const k = (4 / 3) * Math.tan(deltaThetaRad / 4);
  return [
    { x: from.x + tangentFrom.x * k, y: from.y + tangentFrom.y * k },
    { x: to.x - tangentTo.x * k, y: to.y - tangentTo.y * k },
  ];
}

/** A point on an Archimedean spiral, plus its derivative with respect to θ. */
export function spiralPoint(
  center: Point2,
  theta: number,
  radiusAt: (theta: number) => number,
  drdTheta: number,
): { point: Point2; velocity: Point2 } {
  const r = radiusAt(theta);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    point: { x: center.x + r * cos, y: center.y + r * sin },
    velocity: { x: drdTheta * cos - r * sin, y: drdTheta * sin + r * cos },
  };
}

/**
 * A vertical zig-zag run, used by the herringbone and gradient templates.
 *
 * Returns the ids in order so the caller can attach whatever comes next.
 */
export function zigzag(
  builder: GraphBuilder,
  startNodeId: string,
  options: {
    centerX: number;
    fromY: number;
    toY: number;
    amplitudeMm: number;
    legs: number;
    /** Shifts the whole run sideways — the "staggered" part of a staggered herringbone. */
    biasMm?: number;
    startSign?: 1 | -1;
  },
): string[] {
  const { centerX, fromY, toY, amplitudeMm, legs, biasMm = 0, startSign = -1 } = options;
  const step = (toY - fromY) / legs;

  const points: Point2[] = [];
  for (let i = 1; i <= legs; i += 1) {
    const sign = i % 2 === 1 ? startSign : -startSign;
    points.push({ x: centerX + biasMm + sign * amplitudeMm, y: fromY + step * i });
  }

  return builder.polyline(points, startNodeId);
}
