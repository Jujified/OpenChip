/**
 * The CSG pipeline: `channelGraph` → printable solid.
 *
 * Order matters:
 *
 *   1. sweep each edge's cross-section along its path at the lofted size
 *   2. union chamber solids at chamber nodes
 *   3. union port cavities at port nodes
 *   4. subtract that whole network from the chip block
 *   5. split at `splitHeight`, when the chip is two-piece
 *
 * Everything before step 4 builds one **negative** solid — the void the fluid
 * will occupy. Bosses are the sole additive part and are unioned onto the block
 * before the subtraction, so their sockets bore straight through them.
 */

import { buildAdjacency, edgesFrom } from '../geometry';
import { sampleAtNode, solveLoft, type LoftSolution } from '../loft';
import type {
  ChannelEdge,
  ChannelGraph,
  ChipParams,
  DrainageVent,
  PortNode,
} from '../../types/project';
import { placeChannel, profilePoints, radialSegmentsFor } from './placement';
import { slidePocket, withChannelPlane } from './slide';
import { buildPort, coneMesh, filletedBossMesh } from './portGeometry';
import { planarFrame, sweepStations, type RawMesh, type SweepStation } from './sweep';

// Minimal structural typing against the manifold-3d API, so this module can be
// unit-tested with the real WASM in Node and still run in a worker.
export interface ManifoldLike {
  add(other: ManifoldLike): ManifoldLike;
  subtract(other: ManifoldLike): ManifoldLike;
  translate(v: [number, number, number]): ManifoldLike;
  splitByPlane(normal: [number, number, number], offset: number): [ManifoldLike, ManifoldLike];
  volume(): number;
  isEmpty(): boolean;
  getMesh(): { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
  /**
   * Frees the WASM heap behind this handle. embind only finalises smart
   * pointers, so a Manifold that is never deleted leaks for the life of the
   * worker. Optional so plain test doubles still satisfy the type.
   */
  delete?(): void;
}

/**
 * Registers a Manifold for deletion when the build finishes and hands it back,
 * so it can wrap an expression in place: `own(a.translate(v))`.
 */
type Own = <T extends ManifoldLike>(solid: T) => T;

export interface ManifoldApi {
  Manifold: {
    cube(size: [number, number, number], center?: boolean): ManifoldLike;
    cylinder(
      height: number,
      radiusLow: number,
      radiusHigh?: number,
      circularSegments?: number,
      center?: boolean,
    ): ManifoldLike;
    sphere(radius: number, circularSegments?: number): ManifoldLike;
    ofMesh(mesh: unknown): ManifoldLike;
    union(items: ManifoldLike[]): ManifoldLike;
  };
  Mesh: new (options: {
    numProp: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
  }) => unknown;
}

export interface BuildOptions {
  /** 1 = interactive preview, 2 = export. Scales tessellation. */
  quality?: number;
  /** Drainage holes to drill from each vent's node up to the surface. */
  drainageVents?: DrainageVent[];
  /**
   * Also return the cavity as a solid in its own right, for the CAD view's
   * isolate-channels mode.
   *
   * Off by default, and deliberately so: this is the fluid path rendered as if
   * it were a part, which it is not. Nothing printable comes of it, so the
   * export path leaves it off and cannot accidentally put the negative space in
   * an STL.
   */
  includeChannelSolid?: boolean;
}

export interface ChipPiece {
  id: 'body' | 'lid' | 'solid' | 'channels' | 'slide';
  label: string;
  positions: Float32Array;
  indices: Uint32Array;
  volumeMm3: number;
}

export interface BuildResult {
  pieces: ChipPiece[];
  /**
   * The subtracted cavity as a positive solid — channels, chambers, port bores
   * and drainage vents, i.e. everything the fluid touches.
   *
   * Kept out of `pieces` on purpose. Every consumer of `pieces` treats its
   * entries as parts of the chip: they get summed into the chip volume, counted
   * into the triangle total, listed in the toolbar, and written to STL. The
   * cavity is none of those things, and a separate field means none of that
   * code needs to learn to skip it.
   *
   * Null unless `includeChannelSolid` was requested, or when the graph is empty.
   */
  channelSolid: ChipPiece | null;
  /**
   * The glass slide sitting in its pocket, on a `glass-slide` chip.
   *
   * Out of `pieces` for the same reason the cavity is: `pieces` are the things
   * the printer makes. Glass is bought by the box, so it belongs in the
   * preview — where seeing whether it covers the channels is the point — and
   * nowhere near an STL.
   *
   * Null on every other split type.
   */
  slideSolid: ChipPiece | null;
  stats: {
    channelVolumeMm3: number;
    chipVolumeMm3: number;
    triangleCount: number;
    portCount: number;
    chamberCount: number;
    /** Drainage holes actually drilled. */
    ventCount: number;
    /** True when any port used an approximated thread. */
    usedThreadApproximation: boolean;
  };
  warnings: string[];
}

const toMesh = (api: ManifoldApi, raw: RawMesh) =>
  new api.Mesh({ numProp: 3, vertProperties: raw.vertProperties, triVerts: raw.triVerts });

// ---------------------------------------------------------------------------
// channel network
// ---------------------------------------------------------------------------

/**
 * Sweeps every edge, then plugs the joints.
 *
 * Each edge is swept independently and unioned, rather than sweeping whole
 * chains as one tube. Sweeping through a sharp corner makes the outer ring
 * fold through itself and produces a self-intersecting, non-manifold mesh; per
 * edge plus a joint solid at each junction is robust at any turn angle.
 */
function buildChannelNetwork(
  api: ManifoldApi,
  graph: ChannelGraph,
  chipParams: ChipParams,
  quality: number,
  loft: LoftSolution,
  adjacency: Map<string, ChannelEdge[]>,
  own: Own,
): { solid: ManifoldLike | null; volume: number } {
  const parts: ManifoldLike[] = [];

  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved || solved.samples.length < 2) continue;

    const segments = radialSegmentsFor(edge.crossSection, quality);
    const stations: SweepStation[] = solved.samples.map((sample) => {
      const place = placeChannel(
        edge.crossSection,
        sample.widthMm,
        sample.heightMm,
        chipParams.splitHeight,
      );
      const frame = planarFrame(sample.tangent.x, sample.tangent.y);
      return {
        center: { x: sample.point.x, y: sample.point.y, z: place.centerZ },
        across: frame.across,
        up: frame.up,
        profile: profilePoints(edge.crossSection, sample.widthMm, sample.heightMm, segments),
      };
    });

    const raw = sweepStations(stations);
    if (raw) parts.push(own(api.Manifold.ofMesh(toMesh(api, raw))));
  }

  // Joints. Sweeps meeting at an angle leave a notch on the outside of the
  // turn; a solid sized to the local channel fills it and rounds the inner
  // corner, which is better for flow anyway.
  for (const node of graph.nodes) {
    const touching = edgesFrom(adjacency, node.id);
    if (touching.length < 2) continue;
    if (node.type === 'chamber') continue; // the chamber itself covers this

    const edge = touching[0];
    const sample = sampleAtNode(loft, edge, node.id);
    if (!sample) continue;

    const place = placeChannel(
      edge.crossSection,
      sample.widthMm,
      sample.heightMm,
      chipParams.splitHeight,
    );

    const joint = own(
      edge.crossSection === 'round'
        ? api.Manifold.sphere(sample.widthMm / 2, Math.max(12, Math.round(16 * quality)))
        : api.Manifold.cylinder(
            place.halfHeight * 2,
            sample.widthMm / 2,
            sample.widthMm / 2,
            Math.max(12, Math.round(16 * quality)),
            true,
          ),
    );

    parts.push(own(joint.translate([node.x, node.y, place.centerZ])));
  }

  // Chambers.
  for (const node of graph.nodes) {
    if (node.type !== 'chamber') continue;

    const touching = edgesFrom(adjacency, node.id);
    const edge = touching[0];
    const sample = edge ? sampleAtNode(loft, edge, node.id) : undefined;

    const place = placeChannel(
      edge?.crossSection ?? chipParams.defaultCrossSection,
      sample?.widthMm ?? chipParams.defaultChannelWidthMm,
      sample?.heightMm ?? chipParams.defaultChannelHeightMm,
      chipParams.splitHeight,
    );

    // As with ports: a chamber is one of the few large curved surfaces here, so
    // it gets the finer ring.
    const segments = Math.max(24, Math.round(32 * quality));
    const chamber = own(
      node.shape === 'sphere'
        ? api.Manifold.sphere(node.sizeMm / 2, segments)
        : api.Manifold.cylinder(node.sizeMm, node.sizeMm / 2, node.sizeMm / 2, segments, true),
    );

    parts.push(own(chamber.translate([node.x, node.y, place.centerZ])));
  }

  if (parts.length === 0) return { solid: null, volume: 0 };
  const solid = own(api.Manifold.union(parts));
  return { solid, volume: solid.volume() };
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

/** Centre and roof of the channel at a node, from the first edge touching it. */
function channelAtNode(
  adjacency: Map<string, ChannelEdge[]>,
  chipParams: ChipParams,
  nodeId: string,
  loft: LoftSolution,
): { centerZ: number; topZ: number } {
  const touching = edgesFrom(adjacency, nodeId);
  const edge = touching[0];
  if (!edge) return { centerZ: chipParams.splitHeight, topZ: chipParams.splitHeight };

  const sample = sampleAtNode(loft, edge, nodeId);

  const place = placeChannel(
    edge.crossSection,
    sample?.widthMm ?? chipParams.defaultChannelWidthMm,
    sample?.heightMm ?? chipParams.defaultChannelHeightMm,
    chipParams.splitHeight,
  );
  return { centerZ: place.centerZ, topZ: place.centerZ + place.halfHeight };
}

const channelZAtNode = (
  adjacency: Map<string, ChannelEdge[]>,
  chipParams: ChipParams,
  nodeId: string,
  loft: LoftSolution,
): number => channelAtNode(adjacency, chipParams, nodeId, loft).centerZ;

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

export function buildChip(
  api: ManifoldApi,
  graph: ChannelGraph,
  chipParams: ChipParams,
  options: BuildOptions = {},
): BuildResult {
  // Every Manifold this build creates, intermediates included. The result is
  // plain typed arrays copied out of the solids, so nothing here outlives the
  // call — and without the deletes each rebuild leaked several MB of WASM heap
  // until the worker ran out of memory.
  const owned: ManifoldLike[] = [];
  const own: Own = (solid) => {
    owned.push(solid);
    return solid;
  };
  try {
    return buildChipOwned(api, graph, chipParams, options, own);
  } finally {
    for (const solid of owned) solid.delete?.();
  }
}

function buildChipOwned(
  api: ManifoldApi,
  graph: ChannelGraph,
  chipParams: ChipParams,
  options: BuildOptions,
  own: Own,
): BuildResult {
  const quality = options.quality ?? 1;
  const vents = options.drainageVents ?? [];
  const includeChannelSolid = options.includeChannelSolid ?? false;
  const warnings: string[] = [];
  // Ports and chambers are the largest curved features on the chip and there
  // are only a handful of them, so they carry a finer ring than the channels:
  // a 4.3 mm boss at 24 sides showed its facets, and going to 32 costs almost
  // nothing next to the channel sweep.
  const segments = Math.max(24, Math.round(32 * quality));

  const topZ = chipParams.baseThickness;
  const pocket = slidePocket(chipParams);
  // On a slide chip the channels open onto the pocket floor rather than the
  // split plane. Everything downstream reads `splitHeight`, so it is given a
  // chipParams whose split height already *is* that floor.
  const placed = withChannelPlane(chipParams);
  const loft = solveLoft(graph, placed, quality);
  const adjacency = buildAdjacency(graph.edges);

  // --- 1-2. channel network + chambers -------------------------------------
  const network = buildChannelNetwork(api, graph, placed, quality, loft, adjacency, own);
  const cavityParts: ManifoldLike[] = network.solid ? [network.solid] : [];

  // --- 3. ports -------------------------------------------------------------
  const raised: ManifoldLike[] = [];
  const afterCut: ManifoldLike[] = [];
  let usedThreadApproximation = false;
  let portCount = 0;

  for (const node of graph.nodes) {
    if (node.type !== 'port') continue;
    portCount += 1;

    const channel = channelAtNode(adjacency, placed, node.id, loft);
    const port = buildPort(node as PortNode, topZ, channel.centerZ, segments, channel.topZ);
    usedThreadApproximation ||= port.approximated;

    for (const raw of port.cavity) {
      cavityParts.push(
        own(own(api.Manifold.ofMesh(toMesh(api, raw))).translate([node.x, node.y, 0])),
      );
    }

    if (port.boss && port.boss.filletMm > 0) {
      // Three chords of arc in the preview, six at export: a sub-millimetre
      // fillet reads as round with either, and the extra rings are what the
      // fillet costs a rebuild (~5-10% on the templates).
      const raw = filletedBossMesh(
        port.boss.radiusMm,
        port.boss.heightMm,
        port.boss.filletMm,
        topZ,
        segments,
        Math.max(3, Math.round(3 * quality)),
      );
      if (raw) {
        raised.push(own(own(api.Manifold.ofMesh(toMesh(api, raw))).translate([node.x, node.y, 0])));
      }
    } else if (port.boss) {
      raised.push(
        own(
          own(
            api.Manifold.cylinder(
              port.boss.heightMm,
              port.boss.radiusMm,
              port.boss.radiusMm,
              segments,
              false,
            ),
          ).translate([node.x, node.y, topZ]),
        ),
      );
    }

    // Male fittings: the cone or barb stack, already in absolute Z like the
    // cavity, so only the XY placement is left to do.
    for (const raw of port.additive) {
      raised.push(own(own(api.Manifold.ofMesh(toMesh(api, raw))).translate([node.x, node.y, 0])));
    }
    for (const raw of port.afterCut) {
      afterCut.push(own(own(api.Manifold.ofMesh(toMesh(api, raw))).translate([node.x, node.y, 0])));
    }
  }

  // --- 3b. drainage vents ---------------------------------------------------
  // Small bores from the channel straight up through the top face, so trapped
  // resin has somewhere to go. Part of the subtracted cavity like any port.
  let ventCount = 0;
  for (const vent of vents) {
    const node = graph.nodes.find((n) => n.id === vent.nodeId);
    if (!node) continue; // the node was deleted; the vent goes with it

    const channelZ = channelZAtNode(adjacency, placed, node.id, loft);
    const bore = coneMesh(
      vent.diameterMm / 2,
      vent.diameterMm / 2,
      channelZ - 0.01,
      // Overshoot the top face so the bore reliably breaks through.
      topZ + 0.5,
      Math.max(8, Math.round(12 * quality)),
    );
    if (bore) {
      cavityParts.push(
        own(own(api.Manifold.ofMesh(toMesh(api, bore))).translate([node.x, node.y, 0])),
      );
      ventCount += 1;
    }
  }

  // --- 4. subtract from the block -------------------------------------------
  let chip: ManifoldLike = own(
    api.Manifold.cube([chipParams.width, chipParams.length, chipParams.baseThickness], false),
  );

  // Bosses and male fittings go on before the subtraction, so the bores drive
  // straight through them.
  if (raised.length > 0) chip = own(chip.add(own(api.Manifold.union(raised))));

  const cavity = cavityParts.length > 0 ? own(api.Manifold.union(cavityParts)) : null;
  if (cavity) chip = own(chip.subtract(cavity));

  // Solids that live in cavity space — a luer-lock's thread, down in the
  // groove its collar turns in — go back on once the cavity is out.
  if (afterCut.length > 0) chip = own(chip.add(own(api.Manifold.union(afterCut))));

  // --- 4b. the slide pocket -------------------------------------------------
  // Cut after the cavity so the channels are already there to be opened: what
  // is left is a groove with no roof, running up to the floor the glass lands
  // on. The cut overshoots the top face by 1 mm so it breaks through cleanly
  // even when the pocket is the full depth of the block.
  if (pocket) {
    if (pocket.floorZ <= 0) {
      warnings.push(
        `A ${chipParams.slide.thicknessMm} mm slide needs a pocket ${pocket.depthMm} mm deep, ` +
          `which is the whole ${chipParams.baseThickness} mm block. Make the chip thicker.`,
      );
    }

    chip = own(
      chip.subtract(
        own(
          own(
            api.Manifold.cube([pocket.pocket.width, pocket.pocket.length, pocket.depthMm + 1], false),
          ).translate([pocket.pocket.x, pocket.pocket.y, pocket.floorZ]),
        ),
      ),
    );
  }

  if (chip.isEmpty()) {
    warnings.push(
      'The channel network removed the entire chip. Check that the channels fit inside the chip footprint.',
    );
  }

  // --- 5. split -------------------------------------------------------------
  const pieces: ChipPiece[] = [];

  const toPiece = (id: ChipPiece['id'], label: string, solid: ManifoldLike): ChipPiece => {
    const mesh = solid.getMesh();
    // manifold hands back interleaved vertex properties; position is always
    // the first three, and this pipeline sets no others.
    const count = mesh.vertProperties.length / mesh.numProp;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = mesh.vertProperties[i * mesh.numProp];
      positions[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1];
      positions[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2];
    }
    return {
      id,
      label,
      positions,
      indices: new Uint32Array(mesh.triVerts),
      volumeMm3: solid.volume(),
    };
  };

  const emit = (id: ChipPiece['id'], label: string, solid: ManifoldLike) => {
    pieces.push(toPiece(id, label, solid));
  };

  if (chipParams.splitType === 'two-piece') {
    const height = chipParams.splitHeight;
    if (height <= 0 || height >= chipParams.baseThickness) {
      warnings.push(
        `Split height ${height} mm is outside the block (0–${chipParams.baseThickness} mm), so the chip was left whole.`,
      );
      emit('solid', 'Chip', chip);
    } else {
      const [lid, body] = chip.splitByPlane([0, 0, 1], height).map(own);
      if (!body.isEmpty()) emit('body', 'Channel plate', body);
      if (!lid.isEmpty()) emit('lid', 'Lid', lid);
    }
  } else {
    // On a slide chip the printed part is the plate the glass caps, and saying
    // so is worth the extra word: it is also what the STL gets named.
    emit('solid', pocket ? 'Channel plate' : 'Chip', chip);
  }

  // Built from the same manifold that was subtracted above, so what the isolate
  // view shows is by construction the exact void inside the chip beside it —
  // not a second, separately-swept approximation of it that could drift.
  const channelSolid =
    includeChannelSolid && cavity && !cavity.isEmpty()
      ? toPiece('channels', 'Channels', cavity)
      : null;

  // The glass. Modelled at its true size rather than the pocket's, so the fit
  // clearance is visible as the gap it is.
  const slideSolid = pocket
    ? toPiece(
        'slide',
        'Glass slide',
        own(
          own(
            api.Manifold.cube(
              [pocket.glass.width, pocket.glass.length, pocket.glass.thicknessMm],
              false,
            ),
          ).translate([pocket.glass.x, pocket.glass.y, pocket.glass.z]),
        ),
      )
    : null;

  return {
    pieces,
    channelSolid,
    slideSolid,
    stats: {
      channelVolumeMm3: network.volume,
      chipVolumeMm3: pieces.reduce((sum, p) => sum + p.volumeMm3, 0),
      triangleCount: pieces.reduce((sum, p) => sum + p.indices.length / 3, 0),
      portCount,
      chamberCount: graph.nodes.filter((n) => n.type === 'chamber').length,
      ventCount,
      usedThreadApproximation,
    },
    warnings,
  };
}
