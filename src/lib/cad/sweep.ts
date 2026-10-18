/**
 * Swept-loft mesh construction.
 *
 * manifold-3d has `extrude` and `revolve` but no general sweep, so the one
 * primitive the whole CAD pipeline rests on is built here: a sequence of profile
 * rings stitched into a watertight tube.
 *
 * The output must be a valid 2-manifold or `Manifold.ofMesh` rejects it and
 * every downstream boolean fails. Two rules make that hold:
 *
 * 1. Every ring carries the same vertex count, so consecutive rings stitch
 *    one-to-one. Varying the *positions* is what produces the taper.
 * 2. Winding is consistent — profiles are supplied counter-clockwise in the
 *    (across, up) plane, and the stitching below preserves that as
 *    outward-facing from the tube.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One cross-section placed in 3D: a center, a frame, and the profile on it. */
export interface SweepStation {
  center: Vec3;
  /** Unit vector across the path, in the XY plane. */
  across: Vec3;
  /** Unit vector "up" for the profile — world +Z for a planar chip. */
  up: Vec3;
  /** Profile in (across, up) coordinates, counter-clockwise, same length everywhere. */
  profile: { u: number; v: number }[];
}

export interface RawMesh {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

/**
 * Stitches stations into a closed tube with flat end caps.
 *
 * Returns null when there is nothing to build — fewer than two stations, or a
 * degenerate profile — rather than emitting a mesh that would fail validation
 * deeper in the pipeline where the cause is harder to see.
 */
export function sweepStations(stations: SweepStation[]): RawMesh | null {
  if (stations.length < 2) return null;

  const ringSize = stations[0].profile.length;
  if (ringSize < 3) return null;
  if (stations.some((s) => s.profile.length !== ringSize)) return null;

  const vertexCount = stations.length * ringSize;
  const verts = new Float32Array(vertexCount * 3);

  for (let s = 0; s < stations.length; s += 1) {
    const station = stations[s];
    for (let i = 0; i < ringSize; i += 1) {
      const { u, v } = station.profile[i];
      const base = (s * ringSize + i) * 3;
      verts[base] = station.center.x + station.across.x * u + station.up.x * v;
      verts[base + 1] = station.center.y + station.across.y * u + station.up.y * v;
      verts[base + 2] = station.center.z + station.across.z * u + station.up.z * v;
    }
  }

  const tris: number[] = [];

  // Handedness check.
  //
  // The winding below is only outward-facing when `across × up` points along
  // the direction of travel. That holds for a straight run with a left-hand
  // normal, but a helix — where `across` points radially outward — is the
  // mirror case, and the whole solid comes out inside-out with negative
  // volume. Rather than make every caller reason about this, the sweep detects
  // it once and flips its own winding.
  const forward = {
    x: stations[1].center.x - stations[0].center.x,
    y: stations[1].center.y - stations[0].center.y,
    z: stations[1].center.z - stations[0].center.z,
  };
  const { across, up } = stations[0];
  const crossX = across.y * up.z - across.z * up.y;
  const crossY = across.z * up.x - across.x * up.z;
  const crossZ = across.x * up.y - across.y * up.x;
  const flip = crossX * forward.x + crossY * forward.y + crossZ * forward.z < 0;

  const tri = (a: number, b: number, c: number) => {
    if (flip) tris.push(a, c, b);
    else tris.push(a, b, c);
  };

  // --- sides ---------------------------------------------------------------
  for (let s = 0; s < stations.length - 1; s += 1) {
    for (let i = 0; i < ringSize; i += 1) {
      const next = (i + 1) % ringSize;
      const a = s * ringSize + i;
      const b = s * ringSize + next;
      const c = (s + 1) * ringSize + i;
      const d = (s + 1) * ringSize + next;
      tri(a, b, d);
      tri(a, d, c);
    }
  }

  // --- caps ----------------------------------------------------------------
  // Triangle fans. The start cap is wound opposite the end cap because it
  // faces backwards along the sweep.
  const last = (stations.length - 1) * ringSize;
  for (let i = 1; i < ringSize - 1; i += 1) {
    tri(0, i + 1, i);
    tri(last, last + i, last + i + 1);
  }

  return { vertProperties: verts, triVerts: new Uint32Array(tris) };
}

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

const EPS = 1e-9;

export function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return len < EPS ? { x: 1, y: 0, z: 0 } : { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * The frame for a planar chip: the path runs in XY, "up" is world +Z, and
 * "across" is the in-plane normal.
 *
 * A general 3D sweep would need a rotation-minimising frame, but every channel
 * here is planar, so the simple construction is both correct and stable — and
 * it keeps a rect channel's walls truly vertical, which matters for printing.
 */
export function planarFrame(tangentX: number, tangentY: number): { across: Vec3; up: Vec3 } {
  const len = Math.hypot(tangentX, tangentY);
  const tx = len < EPS ? 1 : tangentX / len;
  const ty = len < EPS ? 0 : tangentY / len;
  return {
    // Left-hand normal of the tangent, matching the 2D preview's convention.
    across: { x: -ty, y: tx, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  };
}

// ---------------------------------------------------------------------------
// helices
// ---------------------------------------------------------------------------

export interface HelixOptions {
  /** Radius to the center of the swept profile, mm. */
  radiusMm: number;
  /** Axial rise per full turn, mm. */
  pitchMm: number;
  turns: number;
  /** Z of the start of the helix, mm. */
  startZ: number;
  /** Profile in (radial, axial) coordinates, counter-clockwise. */
  profile: { u: number; v: number }[];
  /** Angular steps per turn. */
  segmentsPerTurn: number;
}

/**
 * A helical sweep, used for the luer-lock thread.
 *
 * The profile's `u` runs outward in radius and `v` runs along the axis, so the
 * same `sweepStations` machinery handles it — a thread is just a sweep whose
 * path happens to be a helix.
 */
export function helixStations(options: HelixOptions): SweepStation[] {
  const { radiusMm, pitchMm, turns, startZ, profile, segmentsPerTurn } = options;
  const steps = Math.max(8, Math.round(segmentsPerTurn * turns));
  const stations: SweepStation[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    stations.push({
      center: { x: cos * radiusMm, y: sin * radiusMm, z: startZ + t * turns * pitchMm },
      across: { x: cos, y: sin, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      profile,
    });
  }

  return stations;
}
