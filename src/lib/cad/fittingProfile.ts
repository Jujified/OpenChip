/**
 * The half-section of a port, derived from its own dimensions.
 *
 * This is what the catalogue drawings are built from. It exists so the picture
 * beside a fitting's name is *generated from the same numbers the geometry
 * pipeline uses*, rather than drawn once by hand and left to rot: change a
 * taper and the drawing changes with it, and a dimension callout can never
 * disagree with the part.
 *
 * The model is a profile in `(r, z)` — radius out from the port axis, height
 * with the chip's top face at `z = 0`. Material is everything between the
 * inner boundary (the void: bore, socket) and the outer boundary
 * (the chip slab, the boss, and any male cone or barb standing above it).
 * Revolving that profile about the axis is exactly what `portGeometry.ts`
 * builds, which is why the two agree.
 *
 * Values are millimetres throughout.
 */

import type { PortType } from '../../types/project';
import { bossFilletMm, LUER_TAPER } from '../ports';
import { luerLockLayout } from './portGeometry';

/** How much of the chip slab to draw under the fitting, mm. */
const CHIP_THICKNESS = 4;

/** A linear run of boundary between two heights. */
interface Segment {
  z0: number;
  z1: number;
  r0: number;
  r1: number;
}

/** A dimension to call out on the drawing. */
export type Dimension =
  /** Measured across the axis — a diameter. */
  | { kind: 'diameter'; z: number; r: number; label: string; value: number }
  /** Measured along the axis — a length. */
  | { kind: 'length'; z0: number; z1: number; r: number; label: string; value: number };

export interface FittingProfile {
  /** Outer boundary, ascending in z. Repeated z values are steps. */
  outer: { r: number; z: number }[];
  /** Inner boundary — the void — ascending in z. */
  inner: { r: number; z: number }[];
  dimensions: Dimension[];
  zMin: number;
  zMax: number;
  /** Widest radius anywhere, for framing the drawing. */
  maxRadius: number;
  /** True when the fitting stands above the chip rather than cutting into it. */
  male: boolean;
}

const num = (spec: Record<string, number | string>, key: string, fallback: number): number => {
  const value = spec[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Largest radius any segment reaches at `z`; voids and solids both union. */
function evaluate(segments: Segment[], z: number, fallback: number): number {
  let best = fallback;
  for (const s of segments) {
    const lo = Math.min(s.z0, s.z1);
    const hi = Math.max(s.z0, s.z1);
    if (z < lo - 1e-9 || z > hi + 1e-9) continue;
    const t = Math.abs(s.z1 - s.z0) < 1e-9 ? 0 : (z - s.z0) / (s.z1 - s.z0);
    best = Math.max(best, s.r0 + (s.r1 - s.r0) * t);
  }
  return best;
}

/**
 * Walks a boundary into a point list.
 *
 * Sampled just below and just above every breakpoint, so a step in the profile
 * comes out as two points at the same height rather than a diagonal — which is
 * what a counterbore or a barb shoulder actually is.
 */
function trace(segments: Segment[], zMin: number, zMax: number, fallback: number) {
  const EPS = 1e-6;
  const breaks = new Set<number>([zMin, zMax]);
  for (const s of segments) {
    for (const z of [s.z0, s.z1]) {
      if (z > zMin + EPS && z < zMax - EPS) breaks.add(z);
    }
  }

  const points: { r: number; z: number }[] = [];
  for (const z of [...breaks].sort((a, b) => a - b)) {
    const below = evaluate(segments, Math.max(zMin, z - EPS), fallback);
    const above = evaluate(segments, Math.min(zMax, z + EPS), fallback);
    if (points.length === 0 || Math.abs(points[points.length - 1].r - below) > 1e-9) {
      points.push({ r: below, z });
    }
    if (Math.abs(above - below) > 1e-9) points.push({ r: above, z });
  }
  return points;
}

/**
 * The half-section for a port.
 *
 * Mirrors the cases in `buildPort`; when one changes the other has to, which is
 * what `fittingProfile.test.ts` checks.
 */
export function fittingProfile(
  portType: PortType,
  boreMm: number,
  spec: Record<string, number | string> = {},
): FittingProfile {
  const bore = Math.max(0.05, boreMm) / 2;
  const boss = num(spec, 'bossHeightMm', 0);

  const voids: Segment[] = [];
  const solids: Segment[] = [];
  const dimensions: Dimension[] = [];

  let zMax = boss;
  let bossRadius = bore + 0.8;
  const male = portType === 'luer-male' || portType === 'barb';

  const mm = (value: number) => `⌀${value.toFixed(2)}`;

  switch (portType) {
    case 'luer':
    case 'luer-lock': {
      const large = num(spec, 'taperLargeDiameterMm', LUER_TAPER.taperLargeDiameterMm) / 2;
      const small = num(spec, 'taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm) / 2;
      const length = num(spec, 'taperLengthMm', LUER_TAPER.taperLengthMm);
      bossRadius = large + 0.8;

      // The socket opens upward, and is clamped where the bore takes over.
      const bottom = Math.max(-CHIP_THICKNESS + 0.4, boss - length);
      voids.push({ z0: bottom, z1: boss, r0: small, r1: large });

      dimensions.push(
        { kind: 'diameter', z: boss, r: large, label: mm(large * 2), value: large * 2 },
        { kind: 'diameter', z: bottom, r: small, label: mm(small * 2), value: small * 2 },
        { kind: 'length', z0: bottom, z1: boss, r: large, label: `${length.toFixed(1)}`, value: length },
      );

      if (portType === 'luer-lock') {
        // The boss is the hub and the thread stands on its outside, so the
        // section shows the thread's envelope above the chip face. (The collar
        // groove below it is a ring, which this one-boundary profile cannot
        // draw; the 3D model has it.)
        const lock = luerLockLayout(spec, 0, -CHIP_THICKNESS);
        bossRadius = lock.hubRadiusMm;
        if (boss > 0) {
          solids.push({ z0: 0, z1: boss, r0: lock.majorRadiusMm, r1: lock.majorRadiusMm });
          dimensions.push({
            kind: 'diameter',
            z: 0,
            r: lock.majorRadiusMm,
            label: mm(lock.majorRadiusMm * 2),
            value: lock.majorRadiusMm * 2,
          });
        }
      }
      break;
    }

    case 'luer-male': {
      const large = num(spec, 'taperLargeDiameterMm', LUER_TAPER.taperLargeDiameterMm) / 2;
      const small = num(spec, 'taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm) / 2;
      const length = num(spec, 'taperLengthMm', LUER_TAPER.taperLengthMm);
      bossRadius = large + 0.8;
      zMax = boss + length;

      // Narrows going up, so a female luer wedges onto it.
      solids.push({ z0: boss, z1: zMax, r0: large, r1: small });

      dimensions.push(
        { kind: 'diameter', z: boss, r: large, label: mm(large * 2), value: large * 2 },
        { kind: 'diameter', z: zMax, r: small, label: mm(small * 2), value: small * 2 },
        { kind: 'length', z0: boss, z1: zMax, r: large, label: `${length.toFixed(1)}`, value: length },
      );
      break;
    }

    case 'barb': {
      const crest = num(spec, 'barbCrestDiameterMm', 3.5) / 2;
      const stem = num(spec, 'stemDiameterMm', 2.9) / 2;
      const length = num(spec, 'barbLengthMm', 10.5);
      const count = Math.max(1, Math.round(num(spec, 'barbCount', 3)));
      bossRadius = crest + 0.8;
      zMax = boss + length;

      solids.push({ z0: boss, z1: zMax, r0: stem, r1: stem });
      const seg = length / count;
      for (let i = 0; i < count; i += 1) {
        const z0 = boss + i * seg;
        solids.push({ z0, z1: z0 + seg, r0: crest, r1: stem });
      }

      dimensions.push(
        { kind: 'diameter', z: boss, r: crest, label: mm(crest * 2), value: crest * 2 },
        { kind: 'diameter', z: zMax, r: stem, label: mm(stem * 2), value: stem * 2 },
        { kind: 'length', z0: boss, z1: zMax, r: crest, label: `${length.toFixed(1)}`, value: length },
      );
      break;
    }

    case 'syringe': {
      const barrel = num(spec, 'barrelDiameterMm', 1.6) / 2;
      const depth = num(spec, 'barrelDepthMm', 6);
      bossRadius = barrel + 0.8;
      const bottom = Math.max(-CHIP_THICKNESS + 0.4, boss - depth);
      voids.push({ z0: bottom, z1: boss, r0: barrel, r1: barrel });

      dimensions.push(
        { kind: 'diameter', z: boss, r: barrel, label: mm(barrel * 2), value: barrel * 2 },
        { kind: 'length', z0: bottom, z1: boss, r: barrel, label: `${depth.toFixed(1)}`, value: depth },
      );
      break;
    }

    default: {
      const outer = num(spec, 'outerDiameterMm', 4) / 2;
      const depth = num(spec, 'depthMm', 5);
      bossRadius = outer + 0.8;
      const bottom = Math.max(-CHIP_THICKNESS + 0.4, boss - depth);
      voids.push({ z0: bottom, z1: boss, r0: outer, r1: outer });

      dimensions.push(
        { kind: 'diameter', z: boss, r: outer, label: mm(outer * 2), value: outer * 2 },
        { kind: 'length', z0: bottom, z1: boss, r: outer, label: `${depth.toFixed(1)}`, value: depth },
      );
      break;
    }
  }

  const zMin = -CHIP_THICKNESS;
  const maxRadius = Math.max(bossRadius, evaluate(solids, zMax, 0), 3);
  // Just enough slab to read as a chip. Any more and the fitting — the actual
  // subject — is squeezed into the middle of a mostly-empty drawing.
  const chipHalf = maxRadius + 1.2;

  // The chip slab, then the boss standing on it.
  solids.push({ z0: zMin, z1: 0, r0: chipHalf, r1: chipHalf });
  if (boss > 0) solids.push({ z0: 0, z1: boss, r0: bossRadius, r1: bossRadius });

  // The base fillet, as short chords of its quarter-circle — the same arc
  // `filletedBossMesh` revolves.
  const fillet = boss > 0 ? bossFilletMm(portType, spec) : 0;
  if (fillet > 0) {
    const steps = 8;
    const at = (k: number) => {
      const phi = (k / steps) * (Math.PI / 2);
      return {
        z: fillet - fillet * Math.cos(phi),
        r: bossRadius + fillet - fillet * Math.sin(phi),
      };
    };
    for (let k = 0; k < steps; k += 1) {
      const a = at(k);
      const b = at(k + 1);
      solids.push({ z0: a.z, z1: b.z, r0: a.r, r1: b.r });
    }
  }

  // The bore is only called out on male fittings. On a socket it sits within a
  // millimetre of the taper's small end, where the two labels collide — and it
  // is the less interesting of the two, since the socket is what seals. The
  // inspector carries the bore as its own field either way.
  if (male) {
    dimensions.push({ kind: 'diameter', z: zMin, r: bore, label: mm(bore * 2), value: bore * 2 });
  }

  return {
    outer: trace(solids, zMin, zMax, 0),
    inner: trace(voids, zMin, zMax, bore),
    dimensions,
    zMin,
    zMax,
    maxRadius: chipHalf,
    male,
  };
}
