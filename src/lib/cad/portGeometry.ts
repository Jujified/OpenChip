/**
 * Port solids.
 *
 * Most ports here are a **cavity**: they join the channel network, and the
 * whole network is subtracted from the chip block. So a `luer` port is the
 * female socket a male luer plugs into.
 *
 * Two things are additive instead, and are unioned onto the block *before* the
 * cavity is subtracted so the bore drives cleanly through them:
 *
 * - the **boss**, the raised collar that stands proud of the chip face;
 * - the **male fittings** — `luer-male` grows a 6% cone, `barb` grows a ridged
 *   spigot — which are shaped solids rather than a plain cylinder, and so come
 *   back as meshes in `additive`.
 *
 * ## What is approximated
 *
 * The 6% Luer taper is exact: a truncated cone straight from the ISO figures.
 *
 * The **luer-lock thread is a simplification**, and deliberately so. Real
 * ISO 80369-7 lock threads are a two-start form with a specified crest/root
 * profile and lead-in. What is generated here is a single-start helical rib
 * with a symmetric trapezoidal profile at the nominal major diameter and
 * pitch. It screws, it prints, and it is the right size — but it is not a
 * certified thread form, and a real fitting may need a test print to seat
 * properly. `THREAD_APPROXIMATION_NOTE` carries that warning into the UI so it
 * is stated where the user is actually choosing the fitting.
 */

import type { PortNode } from '../../types/project';
import { bossFilletMm, LUER_LOCK_GEOMETRY, LUER_TAPER, specNumber } from '../ports';
import { helixStations, sweepStations, type RawMesh } from './sweep';

export const THREAD_APPROXIMATION_NOTE =
  'Luer-lock threads are generated as a single-start helical rib at the nominal major diameter and pitch — ' +
  'not the exact two-start ISO 80369-7 form. It screws together and prints, but test-fit before relying on it.';

// ---------------------------------------------------------------------------
// primitives expressed as raw meshes
// ---------------------------------------------------------------------------

/**
 * A truncated cone as a sweep.
 *
 * Built here rather than with `Manifold.cylinder` so the taper, bore and
 * counterbore of a port all come from one code path and stack without
 * z-fighting at their shared seams.
 */
export function coneMesh(
  bottomRadius: number,
  topRadius: number,
  z0: number,
  z1: number,
  segments: number,
): RawMesh | null {
  const ring = (radius: number) =>
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return { u: Math.cos(a) * radius, v: Math.sin(a) * radius };
    });

  // Swept along +Z: `across` is +X, `up` is +Y, so the profile plane is XY.
  return sweepStations([
    {
      center: { x: 0, y: 0, z: z0 },
      across: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      profile: ring(bottomRadius),
    },
    {
      center: { x: 0, y: 0, z: z1 },
      across: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      profile: ring(topRadius),
    },
  ]);
}

/**
 * A boss with a concave fillet where it meets the chip face, as one solid of
 * revolution.
 *
 * One mesh rather than a cylinder plus a separate fillet ring, so there is no
 * pair of coincident cylindrical faces for the union to resolve. The profile
 * starts 0.01 mm below the face at the fillet's full radius — buried in the
 * block, so the union never meets a coplanar face — runs up a quarter-circle
 * to the boss radius, and then straight up to the top.
 */
export function filletedBossMesh(
  radiusMm: number,
  heightMm: number,
  filletMm: number,
  topZ: number,
  segments: number,
  arcSteps: number,
): RawMesh | null {
  if (heightMm <= 0 || radiusMm <= 0) return null;
  const fillet = Math.min(Math.max(0, filletMm), heightMm);

  const ring = (radius: number) =>
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return { u: Math.cos(a) * radius, v: Math.sin(a) * radius };
    });
  const station = (z: number, radius: number) => ({
    center: { x: 0, y: 0, z },
    across: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    profile: ring(radius),
  });

  const stations = [station(topZ - 0.01, radiusMm + fillet)];
  // Arc centred at (radius + fillet, topZ + fillet): full width on the face,
  // tangent to the boss wall at the top of the fillet.
  for (let k = 0; k <= arcSteps; k += 1) {
    const phi = (k / arcSteps) * (Math.PI / 2);
    stations.push(
      station(topZ + fillet - fillet * Math.cos(phi), radiusMm + fillet - fillet * Math.sin(phi)),
    );
  }
  // A fillet as tall as the boss already ends at the top.
  if (heightMm - fillet > 1e-6) stations.push(station(topZ + heightMm, radiusMm));

  return sweepStations(stations);
}

/**
 * The helical rib on the outside of a luer-lock hub.
 *
 * Swept as a trapezoidal profile around a helix. `u` runs radially, `v`
 * axially. The whole rib, flanks included, stays inside `bottomZ..topZ`; a
 * short hub gets a fraction of a turn — a lug, which is what a real female
 * luer-lock carries anyway. Null when the range is too short for any rib.
 */
export function threadMesh(options: {
  majorDiameterMm: number;
  pitchMm: number;
  bottomZ: number;
  topZ: number;
  /** Radial height of the rib, mm. */
  crestMm: number;
  segmentsPerTurn: number;
}): RawMesh | null {
  const { majorDiameterMm, pitchMm, bottomZ, topZ, crestMm, segmentsPerTurn } = options;
  const halfAxial = Math.min(pitchMm * 0.35, pitchMm / 2 - 0.01);
  const rise = topZ - bottomZ - 2 * halfAxial;
  if (rise <= 0.05) return null;
  const turns = rise / Math.max(0.05, pitchMm);
  const startZ = bottomZ + halfAxial;

  // Trapezoid: wide at the root, narrow at the crest — a printable thread form
  // that does not come to a knife edge.
  const profile = [
    { u: -crestMm / 2, v: -halfAxial },
    { u: crestMm / 2, v: -halfAxial * 0.45 },
    { u: crestMm / 2, v: halfAxial * 0.45 },
    { u: -crestMm / 2, v: halfAxial },
  ];

  return sweepStations(
    helixStations({
      radiusMm: majorDiameterMm / 2 - crestMm / 2,
      pitchMm,
      turns,
      startZ,
      profile,
      segmentsPerTurn,
    }),
  );
}

// ---------------------------------------------------------------------------
// port descriptions
// ---------------------------------------------------------------------------

/**
 * A port's contribution to the model, in chip coordinates with the port at
 * the origin in XY. The caller translates it into place.
 */
export interface PortSolids {
  /** Cavity pieces, unioned into the channel network and then subtracted. */
  cavity: RawMesh[];
  /**
   * Additive boss standing above the chip's top face, if any. `filletMm` is
   * the concave blend at its base; 0 leaves the corner sharp.
   */
  boss: { radiusMm: number; heightMm: number; filletMm: number } | null;
  /**
   * Shaped additive solids for male fittings — the protruding luer cone, the
   * ridges of a hose barb. Unioned onto the block alongside the boss and
   * *before* the cavity is subtracted, so the bore runs cleanly up through
   * them and out the tip.
   *
   * A plain cylinder would do for the boss, which is why that stayed its own
   * field; a cone or a barb stack cannot be expressed that way.
   */
  additive: RawMesh[];
  /**
   * Additive solids that sit *inside* cavity space, so they are unioned on
   * after the cavity is subtracted rather than before: the luer-lock thread
   * rib, which runs down into the groove the male collar turns in.
   */
  afterCut: RawMesh[];
  /** True when the fitting includes an approximated thread. */
  approximated: boolean;
}

/** Where the parts of a female luer-lock sit, shared by every exporter. */
export interface LuerLockLayout {
  /** Outer radius of the thread rib. */
  majorRadiusMm: number;
  /** Radius of the hub the rib stands on — the boss, for a luer-lock. */
  hubRadiusMm: number;
  crestMm: number;
  pitchMm: number;
  /** Outer radius of the groove the male collar turns in. */
  grooveRadiusMm: number;
  /** Floor of that groove; equal to the chip face when no groove is needed. */
  grooveBottomZ: number;
  /** Top of the hub, where the rib ends. */
  hubTopZ: number;
}

/**
 * A female luer-lock: the taper socket runs down a hub, the thread is on the
 * *outside* of the hub, and the male fitting's collar screws down over it.
 *
 * The collar reaches `collarDepthMm` down the hub. When the boss is shorter
 * than that, the rest of the hub is below the chip face, so an annular groove
 * is cut around it for the collar — but never so deep that the thread would
 * run into the channel feeding the port (`channelTopZ`).
 */
export function luerLockLayout(
  spec: Record<string, unknown> | undefined,
  topZ: number,
  channelTopZ: number,
): LuerLockLayout {
  const g = LUER_LOCK_GEOMETRY;
  const majorRadiusMm = specNumber(spec, 'threadMajorDiameterMm', g.threadMajorDiameterMm) / 2;
  const pitchMm = specNumber(spec, 'threadPitchMm', g.threadPitchMm);
  const collarDepth = specNumber(spec, 'collarDepthMm', g.collarDepthMm);
  const bossHeight = specNumber(spec, 'bossHeightMm', 0);
  const crestMm = Math.min(0.8, pitchMm * 0.6, majorRadiusMm / 2);
  const hubRadiusMm = majorRadiusMm - crestMm;
  const hubTopZ = topZ + bossHeight;

  // 0.4 mm of floor between the groove and the channel roof.
  const grooveBottomZ = Math.min(topZ, Math.max(hubTopZ - collarDepth, channelTopZ + 0.4));

  return {
    majorRadiusMm,
    hubRadiusMm,
    crestMm,
    pitchMm,
    grooveRadiusMm: Math.max(
      majorRadiusMm + 0.3,
      specNumber(spec, 'collarClearanceDiameterMm', g.collarClearanceDiameterMm) / 2,
    ),
    grooveBottomZ,
    hubTopZ,
  };
}

/** A tube: the space between two coaxial cylinders, as one watertight mesh. */
export function annulusMesh(
  innerRadius: number,
  outerRadius: number,
  z0: number,
  z1: number,
  segments: number,
): RawMesh | null {
  if (!(outerRadius > innerRadius) || !(z1 > z0)) return null;
  const n = segments;
  const vertProperties = new Float32Array(n * 4 * 3);
  // Rings: 0 inner-bottom, 1 outer-bottom, 2 outer-top, 3 inner-top.
  const rings: Array<[number, number]> = [
    [innerRadius, z0],
    [outerRadius, z0],
    [outerRadius, z1],
    [innerRadius, z1],
  ];
  rings.forEach(([radius, z], ring) => {
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const o = (ring * n + i) * 3;
      vertProperties[o] = Math.cos(a) * radius;
      vertProperties[o + 1] = Math.sin(a) * radius;
      vertProperties[o + 2] = z;
    }
  });

  // Each band joins ring k to ring k+1 (wrapping 3 → 0), which walks the
  // closed cross-section bottom → outer wall → top → inner wall.
  const tris: number[] = [];
  for (let k = 0; k < 4; k += 1) {
    const a = k * n;
    const b = ((k + 1) % 4) * n;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      tris.push(a + i, b + i, b + j, a + i, b + j, a + j);
    }
  }
  return { vertProperties, triVerts: new Uint32Array(tris) };
}

/**
 * Builds a port's geometry.
 *
 * `topZ` is the chip's upper surface; `channelZ` is the center of the channel
 * the port feeds. The bore always runs from above the top face down past the
 * channel center, so the two solids overlap and union without a seam.
 */
export function buildPort(
  node: PortNode,
  topZ: number,
  channelZ: number,
  segments: number,
  /** Roof of the channel the port feeds; nothing is cut or grown below it. */
  channelTopZ: number = channelZ,
): PortSolids {
  const spec = node.customSpec as Record<string, unknown> | undefined;
  const bore = Math.max(0.05, node.diameterMm) / 2;
  const bossHeight = specNumber(spec, 'bossHeightMm', 0);
  const cavity: RawMesh[] = [];
  const additive: RawMesh[] = [];
  const afterCut: RawMesh[] = [];

  // The cavity starts above any boss and ends below the channel center, so it
  // reliably breaks through both surfaces it needs to. A male fitting raises
  // the top further, to the tip of whatever it grows.
  const cavityTop = topZ + bossHeight + 0.01;
  const cavityBottom = channelZ - 0.01;

  let approximated = false;
  let bossRadius = bore + 0.8;

  switch (node.portType) {
    case 'luer':
    case 'luer-lock': {
      const large = specNumber(spec, 'taperLargeDiameterMm', LUER_TAPER.taperLargeDiameterMm) / 2;
      const small = specNumber(spec, 'taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm) / 2;
      const taperLength = specNumber(spec, 'taperLengthMm', LUER_TAPER.taperLengthMm);

      // The taper opens upward: wide at the mouth, narrow as it goes in.
      const taperBottom = Math.max(cavityBottom, cavityTop - taperLength);
      const cone = coneMesh(small, large, taperBottom, cavityTop, segments);
      if (cone) cavity.push(cone);

      // Bore on down to the channel.
      const shaft = coneMesh(bore, bore, cavityBottom, taperBottom + 0.01, segments);
      if (shaft) cavity.push(shaft);

      bossRadius = large + 0.8;

      if (node.portType === 'luer-lock') {
        // The taper above stays whole: the seal is the full 6% cone. The boss
        // is the hub, the thread rib is on its outside, and the male collar
        // screws down over both.
        const lock = luerLockLayout(spec, topZ, channelTopZ);
        bossRadius = lock.hubRadiusMm;

        if (lock.grooveBottomZ < topZ) {
          // Hub below the chip face too: cut the collar's groove around it.
          // The inner wall overlaps the hub by a hair so the rib lands on it.
          const groove = annulusMesh(
            lock.hubRadiusMm,
            lock.grooveRadiusMm,
            lock.grooveBottomZ,
            topZ + 0.01,
            segments,
          );
          if (groove) cavity.push(groove);
        }

        const thread = threadMesh({
          majorDiameterMm: lock.majorRadiusMm * 2,
          pitchMm: lock.pitchMm,
          // Sunk 0.05 mm into the hub, so the rib and hub fuse.
          crestMm: lock.crestMm + 0.05,
          bottomZ: lock.grooveBottomZ,
          topZ: lock.hubTopZ,
          segmentsPerTurn: Math.max(16, segments),
        });
        if (thread) {
          afterCut.push(thread);
          approximated = true;
        }
      }
      break;
    }

    // Male fittings. Everything above the chip face is *added*, and the bore is
    // then driven up through it and out the tip — so the cavity is one straight
    // shaft rather than a socket plus a shaft.
    case 'luer-male': {
      const large = specNumber(spec, 'taperLargeDiameterMm', LUER_TAPER.taperLargeDiameterMm) / 2;
      const small = specNumber(spec, 'taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm) / 2;
      const coneLength = specNumber(spec, 'taperLengthMm', LUER_TAPER.taperLengthMm);

      // The cone narrows going up, so a female luer wedges onto it.
      const coneBottom = topZ + bossHeight;
      const cone = coneMesh(large, small, coneBottom, coneBottom + coneLength, segments);
      if (cone) additive.push(cone);

      const shaft = coneMesh(
        bore,
        bore,
        cavityBottom,
        coneBottom + coneLength + 0.01,
        segments,
      );
      if (shaft) cavity.push(shaft);

      bossRadius = large + 0.8;
      break;
    }

    case 'barb': {
      const crest = specNumber(spec, 'barbCrestDiameterMm', 3.5) / 2;
      const stem = specNumber(spec, 'stemDiameterMm', 2.9) / 2;
      const length = specNumber(spec, 'barbLengthMm', 10.5);
      const count = Math.max(1, Math.round(specNumber(spec, 'barbCount', 3)));

      const base = topZ + bossHeight;

      // The stem runs the whole length; the ridges sit on top of it.
      const stemMesh = coneMesh(stem, stem, base, base + length, segments);
      if (stemMesh) additive.push(stemMesh);

      // Each ridge is widest at its lower edge and tapers back to the stem
      // going up. That puts the abrupt shoulder on the base side — the tube
      // slides on over the ramp and has to stretch back over the crest to come
      // off, which is the whole mechanism of a barb.
      const segLength = length / count;
      for (let i = 0; i < count; i += 1) {
        const z0 = base + i * segLength;
        const ridge = coneMesh(crest, stem, z0, z0 + segLength, segments);
        if (ridge) additive.push(ridge);
      }

      const shaft = coneMesh(bore, bore, cavityBottom, base + length + 0.01, segments);
      if (shaft) cavity.push(shaft);

      bossRadius = crest + 0.8;
      break;
    }

    case 'syringe': {
      const barrel = specNumber(spec, 'barrelDiameterMm', 1.6) / 2;
      const depth = specNumber(spec, 'barrelDepthMm', 6);
      const barrelBottom = Math.max(cavityBottom, cavityTop - depth);

      const socket = coneMesh(barrel, barrel, barrelBottom, cavityTop, segments);
      if (socket) cavity.push(socket);

      const shaft = coneMesh(bore, bore, cavityBottom, barrelBottom + 0.01, segments);
      if (shaft) cavity.push(shaft);

      bossRadius = barrel + 0.8;
      break;
    }

    default: {
      const outer = specNumber(spec, 'outerDiameterMm', 4) / 2;
      const depth = specNumber(spec, 'depthMm', 5);
      const socketBottom = Math.max(cavityBottom, cavityTop - depth);

      const socket = coneMesh(outer, outer, socketBottom, cavityTop, segments);
      if (socket) cavity.push(socket);

      const shaft = coneMesh(bore, bore, cavityBottom, socketBottom + 0.01, segments);
      if (shaft) cavity.push(shaft);

      bossRadius = outer + 0.8;
      break;
    }
  }

  return {
    cavity,
    boss:
      bossHeight > 0
        ? { radiusMm: bossRadius, heightMm: bossHeight, filletMm: bossFilletMm(node.portType, spec) }
        : null,
    additive,
    afterCut,
    approximated,
  };
}
