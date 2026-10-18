/**
 * The starter template library.
 *
 * Seven well-known microfluidic geometries, recreated from published device
 * descriptions (each template's `references` names the paper, where one device
 * clearly started it) and shipped as static data. Nothing here is fetched, scraped or
 * generated at runtime — the app has no network dependency, and a template that
 * needed one would break OpenChip's offline-first rule.
 *
 * **These are recreations, not reproductions.** Dimensions are chosen to print
 * cleanly on a desktop mSLA machine and to sit comfortably inside the default
 * printer profile's build volume, not to match any particular paper's device.
 * Where a published geometry cannot be expressed by a planar channel graph at a
 * single Z — the staggered herringbone being the clear case — the template says
 * so in `caveat` rather than quietly shipping something that looks right and
 * mixes differently.
 */

import type { ChannelGraph, ChipParams } from '../../types/project';
import { totalChannelLengthMm } from '../graphOps';
import { GraphBuilder, arcHandles, spiralPoint, zigzag } from './builders';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type PresetCategory = 'mixing' | 'gradient' | 'droplet';

export const CATEGORY_LABEL: Record<PresetCategory, string> = {
  mixing: 'Mixing',
  gradient: 'Gradient',
  droplet: 'Droplets',
};

export interface PresetBuild {
  graph: ChannelGraph;
  /** Ports that default to inlets when the template is opened. */
  inletPortIds: string[];
  outletPortIds: string[];
}

/** A published source for a template's geometry. */
export interface PresetReference {
  /** Authors, year, title, journal, volume and pages, as one line. */
  citation: string;
  doi?: string;
}

export interface ChipPreset {
  id: string;
  name: string;
  category: PresetCategory;
  /** One line, shown on the card. */
  tagline: string;
  /** A paragraph, shown when the template is opened for a closer look. */
  description: string;
  /** How the geometry actually does its job — the physics, in two sentences. */
  principle: string;
  /** Free-text search terms beyond the name and description. */
  tags: string[];
  /** Honest statement of what this recreation does and does not capture. */
  caveat?: string;
  /**
   * The paper the geometry descends from, when one device clearly started it.
   * Generic shapes — a serpentine, a T, a Y — have no single origin and carry
   * none rather than an arbitrary pick. A DOI is given only where it was
   * checked against the publisher.
   */
  references?: PresetReference[];
  /** Overrides on top of `DEFAULT_CHIP_PARAMS`. */
  chipParams: Partial<ChipParams>;
  /** Per-inlet flow rate seeded into the fluid setup, µL/min. */
  inletFlowUlPerMin: number;
  build: () => PresetBuild;
}

/** Shared by every template: a chip that prints without a support raft or a lid warning. */
const BASE: Partial<ChipParams> = {
  baseThickness: 4,
  wallThickness: 2,
  minEdgeSpacing: 3,
  splitType: 'two-piece',
  splitHeight: 2,
  defaultCrossSection: 'rect',
  defaultChannelWidthMm: 0.8,
  defaultChannelHeightMm: 0.5,
};

const LUER = 'norm-ject-luer-slip';
const LUER_LOCK = 'norm-ject-luer-lock';

// ---------------------------------------------------------------------------
// 1 — serpentine mixer
// ---------------------------------------------------------------------------

function buildSerpentine(): PresetBuild {
  const b = new GraphBuilder('serpentine', {
    crossSection: 'rect',
    widthMm: 0.8,
    heightMm: 0.5,
  });

  const inletA = b.port(13, 54, LUER);
  const inletB = b.port(27, 54, LUER);
  const junction = b.waypoint(20, 47);
  b.connect(inletA, junction);
  b.connect(inletB, junction);

  const lead = b.waypoint(20, 43);
  b.connect(junction, lead);

  // Six full passes across the chip. Length is the only lever a purely
  // diffusive mixer has, so the path is folded until it is long enough for the
  // two streams to interdiffuse at a realistic flow rate.
  const left = 7;
  const right = 33;
  const rows = [43, 37, 31, 25, 19, 13];

  const path: { x: number; y: number }[] = [{ x: left, y: rows[0] }];
  for (let i = 1; i < rows.length; i += 1) {
    const endX = i % 2 === 1 ? left : right;
    path.push({ x: endX, y: rows[i] }, { x: endX === left ? right : left, y: rows[i] });
  }

  const run = b.polyline(path, lead);
  const tail = b.waypoint(path[path.length - 1].x, 7);
  b.connect(run[run.length - 1], tail);

  const outlet = b.port(20, 7, LUER);
  b.connect(tail, outlet);

  return { graph: b.build(), inletPortIds: [inletA, inletB], outletPortIds: [outlet] };
}

// ---------------------------------------------------------------------------
// 2 — T-junction mixer
// ---------------------------------------------------------------------------

function buildTJunction(): PresetBuild {
  const b = new GraphBuilder('tjunction', { crossSection: 'rect', widthMm: 0.8, heightMm: 0.5 });

  const inletA = b.port(6, 33, LUER);
  const inletB = b.port(30, 33, LUER);
  const tee = b.waypoint(18, 33);
  b.connect(inletA, tee);
  b.connect(inletB, tee);

  const run = b.polyline([{ x: 18, y: 26 }, { x: 18, y: 19 }, { x: 18, y: 12 }], tee);
  const outlet = b.port(18, 6, LUER);
  b.connect(run[run.length - 1], outlet);

  return { graph: b.build(), inletPortIds: [inletA, inletB], outletPortIds: [outlet] };
}

// ---------------------------------------------------------------------------
// 3 — Y-junction mixer
// ---------------------------------------------------------------------------

function buildYJunction(): PresetBuild {
  const b = new GraphBuilder('yjunction', { crossSection: 'rect', widthMm: 0.8, heightMm: 0.5 });

  const inletA = b.port(9, 37, LUER);
  const inletB = b.port(27, 37, LUER);
  const junction = b.waypoint(18, 28);

  // Curved arms, not straight ones. Both streams arrive at the junction running
  // parallel, so they lie down side by side instead of colliding head-on — that
  // is the whole difference between a Y and a T, and it is the reason a Y is
  // the gentler choice for anything shear-sensitive.
  b.connect(inletA, junction, {
    controlPoints: [
      { x: 9, y: 33 },
      { x: 18, y: 32 },
    ],
  });
  b.connect(inletB, junction, {
    controlPoints: [
      { x: 27, y: 33 },
      { x: 18, y: 32 },
    ],
  });

  const run = b.polyline([{ x: 18, y: 21 }, { x: 18, y: 14 }], junction);
  const outlet = b.port(18, 6, LUER);
  b.connect(run[run.length - 1], outlet);

  return { graph: b.build(), inletPortIds: [inletA, inletB], outletPortIds: [outlet] };
}

// ---------------------------------------------------------------------------
// 4 — herringbone (planar chevron) mixer
// ---------------------------------------------------------------------------

function buildHerringbone(): PresetBuild {
  const b = new GraphBuilder('herringbone', { crossSection: 'rect', widthMm: 0.8, heightMm: 0.5 });

  const inletA = b.port(10, 70, LUER);
  const inletB = b.port(20, 70, LUER);
  const junction = b.waypoint(15, 65);
  b.connect(inletA, junction);
  b.connect(inletB, junction);

  // Three staggered groups. The real staggered herringbone mixer reverses the
  // asymmetry of its grooves every half-cycle so the transverse flow reverses
  // and folds the interface again; shifting the whole chevron run sideways
  // between groups is the planar equivalent of that reversal.
  let previous = junction;
  const groups = [-1.5, 1.5, -1.5];
  const spanPerGroup = 15;

  groups.forEach((bias, index) => {
    const fromY = 65 - index * spanPerGroup;
    const ids = zigzag(b, previous, {
      centerX: 15,
      fromY,
      toY: fromY - spanPerGroup,
      amplitudeMm: 3.5,
      legs: 3,
      biasMm: bias,
    });
    previous = ids[ids.length - 1];
  });

  const gather = b.waypoint(15, 14);
  b.connect(previous, gather);
  const outlet = b.port(15, 8, LUER);
  b.connect(gather, outlet);

  return { graph: b.build(), inletPortIds: [inletA, inletB], outletPortIds: [outlet] };
}

// ---------------------------------------------------------------------------
// 5 — spiral mixer
// ---------------------------------------------------------------------------

function buildSpiral(): PresetBuild {
  const b = new GraphBuilder('spiral', { crossSection: 'rect', widthMm: 0.8, heightMm: 0.5 });

  const center = { x: 30, y: 30 };
  const startTheta = Math.PI / 4;
  const turns = 2.5;
  const sweep = turns * 2 * Math.PI;
  const outerR = 22;
  const innerR = 7;
  const drdTheta = (innerR - outerR) / sweep;
  const radiusAt = (theta: number) => outerR + drdTheta * (theta - startTheta);

  const steps = Math.round(sweep / (Math.PI / 4)); // 45° per segment
  const deltaTheta = sweep / steps;

  const inletA = b.port(54, 42, LUER);
  const inletB = b.port(42, 54, LUER);
  const junction = b.waypoint(48, 48);
  b.connect(inletA, junction);
  b.connect(inletB, junction);

  let previousId: string | null = null;
  let previousSample = spiralPoint(center, startTheta, radiusAt, drdTheta);

  for (let i = 0; i <= steps; i += 1) {
    const theta = startTheta + deltaTheta * i;
    const sample = spiralPoint(center, theta, radiusAt, drdTheta);
    const id = b.waypoint(sample.point.x, sample.point.y);

    if (previousId) {
      b.connect(previousId, id, {
        controlPoints: arcHandles(
          previousSample.point,
          sample.point,
          previousSample.velocity,
          sample.velocity,
          deltaTheta,
        ),
      });
    } else {
      b.connect(junction, id);
    }

    previousId = id;
    previousSample = sample;
  }

  const outlet = b.port(center.x, center.y, LUER);
  b.connect(previousId as string, outlet);

  return { graph: b.build(), inletPortIds: [inletA, inletB], outletPortIds: [outlet] };
}

// ---------------------------------------------------------------------------
// 6 — gradient generator (Christmas tree)
// ---------------------------------------------------------------------------

function buildGradientGenerator(): PresetBuild {
  const b = new GraphBuilder('gradient', { crossSection: 'rect', widthMm: 0.8, heightMm: 0.5 });

  /** One stream's mixing run: a short serpentine that ends back on its own axis. */
  const mixingRun = (startId: string, cx: number, fromY: number): string => {
    const ids = b.polyline(
      [
        { x: cx - 2.5, y: fromY - 3 },
        { x: cx + 2.5, y: fromY - 6 },
        { x: cx - 2.5, y: fromY - 9 },
        { x: cx, y: fromY - 12 },
      ],
      startId,
    );
    return ids[ids.length - 1];
  };

  const inletA = b.port(24, 64, LUER);
  const inletB = b.port(36, 64, LUER);
  const splitA = b.waypoint(24, 58);
  const splitB = b.waypoint(36, 58);
  b.connect(inletA, splitA);
  b.connect(inletB, splitB);

  // Level B: three streams. Each interior stream is fed by both parents, so it
  // carries their average; the outer two stay pure. Repeat the split-and-mix
  // and the concentrations step linearly across the outlets.
  const levelBx = [18, 30, 42];
  const levelB = levelBx.map((x) => b.waypoint(x, 52));
  b.connect(splitA, levelB[0]);
  b.connect(splitA, levelB[1]);
  b.connect(splitB, levelB[1]);
  b.connect(splitB, levelB[2]);

  const levelBOut = levelB.map((id, i) => mixingRun(id, levelBx[i], 52));
  const levelBSplit = levelBx.map((x, i) => {
    const id = b.waypoint(x, 37);
    b.connect(levelBOut[i], id);
    return id;
  });

  const levelCx = [12, 24, 36, 48];
  const levelC = levelCx.map((x) => b.waypoint(x, 31));
  b.connect(levelBSplit[0], levelC[0]);
  b.connect(levelBSplit[0], levelC[1]);
  b.connect(levelBSplit[1], levelC[1]);
  b.connect(levelBSplit[1], levelC[2]);
  b.connect(levelBSplit[2], levelC[2]);
  b.connect(levelBSplit[2], levelC[3]);

  const outlets = levelCx.map((x, i) => {
    const tail = mixingRun(levelC[i], x, 31);
    const port = b.port(x, 10, LUER);
    b.connect(tail, port);
    return port;
  });

  return { graph: b.build(), inletPortIds: [inletA, inletB], outletPortIds: outlets };
}

// ---------------------------------------------------------------------------
// 7 — flow-focusing droplet generator
// ---------------------------------------------------------------------------

function buildDropletGenerator(): PresetBuild {
  const b = new GraphBuilder('droplet', { crossSection: 'rect', widthMm: 0.6, heightMm: 0.4 });

  const dispersed = b.port(20, 44, LUER);
  const oilLeft = b.port(7, 32, LUER);
  const oilRight = b.port(33, 32, LUER);
  const cross = b.waypoint(20, 32);

  b.connect(dispersed, cross);
  b.connect(oilLeft, cross);
  b.connect(oilRight, cross);

  // The orifice is built out of dimension markers rather than a separate short
  // edge, because it is exactly what the loft is for: the width is pinched to
  // 0.35 mm at the throat and released downstream, and the solid generator
  // interpolates the neck rather than stepping between two constant channels.
  const throat = b.waypoint(20, 28);
  b.connect(cross, throat, {
    dimensionPoints: [
      { t: 0, widthMm: 0.6, heightMm: 0.4 },
      { t: 0.45, widthMm: 0.35, heightMm: 0.3 },
      { t: 1, widthMm: 0.9, heightMm: 0.5 },
    ],
  });

  const relax = b.waypoint(20, 20);
  b.connect(throat, relax, {
    dimensionPoints: [
      { t: 0, widthMm: 0.9, heightMm: 0.5 },
      { t: 1, widthMm: 1.2, heightMm: 0.6 },
    ],
  });

  const outlet = b.port(20, 8, LUER_LOCK);
  b.connect(relax, outlet, {
    dimensionPoints: [
      { t: 0, widthMm: 1.2, heightMm: 0.6 },
      { t: 1, widthMm: 1.2, heightMm: 0.6 },
    ],
  });

  return {
    graph: b.build(),
    inletPortIds: [dispersed, oilLeft, oilRight],
    outletPortIds: [outlet],
  };
}

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

export const CHIP_PRESETS: ChipPreset[] = [
  {
    id: 'serpentine-mixer',
    name: 'Serpentine mixer',
    category: 'mixing',
    tagline: 'Two streams, folded through six passes of channel until they interdiffuse.',
    description:
      'The workhorse. Two inlets meet at a Y and the combined stream is folded back and forth ' +
      'across the chip six times, giving roughly 200 mm of contact length in a 40 × 60 mm ' +
      'footprint. Start here if you are not sure what you need — it is easy to print, easy to ' +
      'clear of resin, and the only parameter that really matters is how long you make it.',
    principle:
      'At these Reynolds numbers there is no turbulence to help, so mixing is pure molecular ' +
      'diffusion across the interface between the two streams. Length buys time: doubling the ' +
      'path doubles the residence time, and the mixing length scales with the square of channel width.',
    tags: ['serpentine', 'diffusive', 'meander', 'boustrophedon', 'beginner', 'two inlet'],
    chipParams: { ...BASE, width: 40, length: 60 },
    inletFlowUlPerMin: 10,
    build: buildSerpentine,
  },
  {
    id: 't-junction-mixer',
    name: 'T-junction mixer',
    category: 'mixing',
    tagline: 'Two streams meeting head-on, then a single straight mixing leg.',
    description:
      'The simplest two-stream contactor there is: opposed inlets, a right-angle turn, and 27 mm ' +
      'of straight channel to mix in. Compact and unambiguous, which makes it the right starting ' +
      'point when you want to change one thing at a time and see what it does.',
    principle:
      'The two streams collide and turn together, which stretches the interface at the corner ' +
      'and gives a small mixing head start over a Y. Downstream it is diffusion again, so the ' +
      'straight leg is doing most of the work.',
    tags: ['t junction', 'tee', 'contactor', 'simple', 'two inlet'],
    chipParams: { ...BASE, width: 36, length: 40 },
    inletFlowUlPerMin: 10,
    build: buildTJunction,
  },
  {
    id: 'y-junction-mixer',
    name: 'Y-junction mixer',
    category: 'mixing',
    tagline: 'Curved arms that lay two streams side by side without a head-on collision.',
    description:
      'Both inlet arms curve so they arrive at the junction running parallel. The streams merge ' +
      'as neat co-flowing laminae rather than slamming into each other, which is what you want ' +
      'for cells, emulsions or anything else a head-on collision would damage.',
    principle:
      'Co-flow produces a clean, flat interface between the two streams and holds it stable down ' +
      'the mixing leg. That makes it the gentlest merge available — and also the slowest to mix, ' +
      'since nothing is stretching the interface. The gentleness is in how the streams meet, ' +
      'which a one-dimensional model cannot see: the Fluid tab reads the same wall shear here as ' +
      'for a T of the same section and flow, because wall shear follows the channel, not the corner.',
    tags: ['y junction', 'co-flow', 'laminar', 'gentle', 'shear', 'two inlet'],
    chipParams: { ...BASE, width: 36, length: 44 },
    inletFlowUlPerMin: 10,
    build: buildYJunction,
  },
  {
    id: 'herringbone-mixer',
    name: 'Herringbone mixer',
    category: 'mixing',
    tagline: 'Staggered chevrons that fold the interface instead of waiting on diffusion.',
    description:
      'Nine chevron legs in three staggered groups. Each group biases the run to one side, and ' +
      'the bias reverses between groups — the planar equivalent of the alternating half-cycles ' +
      'in a staggered herringbone mixer. Mixes far shorter than a plain serpentine of the same ' +
      'length, at the cost of sharper corners and a higher pressure drop.',
    principle:
      'Repeatedly reorienting the flow stretches and folds the interface between the two streams, ' +
      'so the diffusion distance shrinks geometrically rather than linearly. This is chaotic ' +
      'advection: the same reason folding dough is faster than stirring it.',
    caveat:
      'The published staggered herringbone mixer works by ridges cut into the channel floor, which ' +
      'are sub-channel features a planar graph at a single Z cannot express. This is the planar ' +
      'chevron interpretation: it folds the interface by turning the whole channel rather than by ' +
      'driving a helical secondary flow, so expect useful mixing but not the original device’s numbers.',
    tags: ['herringbone', 'chevron', 'chaotic advection', 'staggered', 'shm', 'fold'],
    references: [
      {
        citation:
          'Stroock, A. D., Dertinger, S. K. W., Ajdari, A., Mezić, I., Stone, H. A. & Whitesides, G. M. ' +
          '(2002). Chaotic mixer for microchannels. Science 295, 647–651.',
      },
    ],
    chipParams: { ...BASE, width: 30, length: 76 },
    inletFlowUlPerMin: 10,
    build: buildHerringbone,
  },
  {
    id: 'spiral-mixer',
    name: 'Spiral mixer',
    category: 'mixing',
    tagline: 'Two and a half turns of continuous curvature, winding inward to a center outlet.',
    description:
      'An Archimedean spiral from a 22 mm outer radius down to 7 mm, with 6 mm between turns. ' +
      'Long path length in a compact square footprint and, unlike a serpentine, no corners at ' +
      'all — nothing to catch a bubble on and nothing to spike the pressure drop.',
    principle:
      'Sustained curvature sets up Dean vortices: a pair of counter-rotating secondary flows in ' +
      'the channel cross-section that stir the fluid transversely as it travels. Dean flow ' +
      'strengthens with flow rate, so this is the geometry that gets better as you push it harder.',
    tags: ['spiral', 'dean', 'curved', 'archimedean', 'secondary flow', 'inertial'],
    references: [
      {
        citation:
          'Sudarsan, A. P. & Ugaz, V. M. (2006). Fluid mixing in planar spiral microchannels. ' +
          'Lab on a Chip 6, 74–82.',
        doi: '10.1039/B511524H',
      },
    ],
    chipParams: { ...BASE, width: 60, length: 60 },
    inletFlowUlPerMin: 40,
    build: buildSpiral,
  },
  {
    id: 'gradient-generator',
    name: 'Gradient generator',
    category: 'gradient',
    tagline: 'Christmas-tree network turning two inputs into four evenly stepped concentrations.',
    description:
      'Two inlets split, mix and recombine through two levels of branching to produce four ' +
      'outlets carrying a linear concentration series. The classic tool for dose–response and ' +
      'chemotaxis work: one syringe of buffer, one of compound, four conditions at once.',
    principle:
      'Each branch point splits a stream in half and each junction averages two neighbours, so ' +
      'the concentration steps linearly across the outlets. The serpentine between levels exists ' +
      'purely to give each combined stream time to homogenise before it is split again.',
    caveat:
      'The linear series holds only if every branch has the same hydraulic resistance. Widen one ' +
      'channel and the split stops being even — check the Fluid Dynamics tab after any edit, ' +
      'because a branch twice as wide carries roughly sixteen times the flow.',
    tags: ['gradient', 'christmas tree', 'concentration', 'dilution', 'dose response', 'chemotaxis'],
    references: [
      {
        citation:
          'Jeon, N. L., Dertinger, S. K. W., Chiu, D. T., Choi, I. S., Stroock, A. D. & Whitesides, G. M. ' +
          '(2000). Generation of solution and surface gradients using microfluidic systems. ' +
          'Langmuir 16, 8311–8316.',
        doi: '10.1021/la000600b',
      },
    ],
    chipParams: { ...BASE, width: 60, length: 70 },
    inletFlowUlPerMin: 20,
    build: buildGradientGenerator,
  },
  {
    id: 'droplet-generator',
    name: 'Flow-focusing droplet generator',
    category: 'droplet',
    tagline: 'Three streams pinched through a 0.35 mm throat that shears off droplets.',
    description:
      'A dispersed phase entering from the top is squeezed between two continuous-phase streams ' +
      'and forced through a narrow orifice, which breaks it into droplets. The throat is built ' +
      'from dimension markers rather than a separate channel, so you can drag it wider or ' +
      'narrower and watch the neck reflow in 3D.',
    principle:
      'Where the streams converge, viscous shear from the continuous phase overcomes the interfacial ' +
      'tension holding the thread together and it pinches off. Droplet size follows the orifice ' +
      'width and the flow-rate ratio, which is why both are the first things to tune.',
    caveat:
      'The 0.35 mm throat is near the limit of a standard 4K printer and will be the first thing ' +
      'the warnings panel flags on a coarse profile. Print a test coupon before committing a chip.',
    tags: ['droplet', 'flow focusing', 'emulsion', 'orifice', 'shear', 'three inlet', 'loft'],
    references: [
      {
        citation:
          'Anna, S. L., Bontoux, N. & Stone, H. A. (2003). Formation of dispersions using “flow ' +
          'focusing” in microchannels. Applied Physics Letters 82, 364–366.',
        doi: '10.1063/1.1537519',
      },
    ],
    chipParams: {
      ...BASE,
      width: 40,
      length: 50,
      defaultChannelWidthMm: 0.6,
      defaultChannelHeightMm: 0.4,
    },
    inletFlowUlPerMin: 15,
    build: buildDropletGenerator,
  },
];

export const findPreset = (id: string): ChipPreset | undefined =>
  CHIP_PRESETS.find((p) => p.id === id);

// ---------------------------------------------------------------------------
// derived facts for the cards
// ---------------------------------------------------------------------------

export interface PresetStats {
  portCount: number;
  segmentCount: number;
  channelLengthMm: number;
  footprint: string;
}

export function presetStats(preset: ChipPreset, build: PresetBuild): PresetStats {
  const width = preset.chipParams.width ?? 40;
  const length = preset.chipParams.length ?? 60;
  return {
    portCount: build.graph.nodes.filter((n) => n.type === 'port').length,
    segmentCount: build.graph.edges.length,
    channelLengthMm: totalChannelLengthMm(build.graph),
    footprint: `${width} × ${length} mm`,
  };
}

/**
 * Free-text match over everything a user might type.
 *
 * Deliberately substring rather than fuzzy: with seven entries a fuzzy matcher
 * only ever produces surprising misses, and "spiral" should not rank
 * "serpentine" above "spiral mixer".
 */
export function matchesQuery(preset: ChipPreset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const haystack = [
    preset.name,
    preset.tagline,
    preset.description,
    preset.principle,
    CATEGORY_LABEL[preset.category],
    ...preset.tags,
  ]
    .join(' ')
    .toLowerCase();

  // Every whitespace-separated term must appear, so adding a word narrows the
  // list rather than widening it.
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}
