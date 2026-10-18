/**
 * Render-ready geometry for a piece: de-indexed, with creased normals.
 *
 * manifold returns a welded mesh — a cube is 8 vertices and 12 triangles, so
 * each corner is shared by three perpendicular faces. Plain vertex normals can
 * only average those, which tilts the normal at every corner of a flat face
 * and interpolates a gradient right across it; the chip's top read as crumpled
 * foil and the port bosses melted into it. `toCreasedNormals` splits vertices
 * whose faces disagree by more than the crease angle, so hard edges get a
 * normal per face and curves keep sharing one.
 *
 * It walks every triangle, 10–20 ms on a template at export quality, so the
 * worker does it once per build rather than the viewport doing it on the main
 * thread — and again on every display-mode toggle, which it used to.
 */

import { BufferAttribute, BufferGeometry, MathUtils } from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Angle above which an edge is drawn hard rather than smoothed.
 *
 * manifold welds coincident vertices, so a cube arrives as 8 vertices and 12
 * triangles — every corner shared between three perpendicular faces. Averaging
 * normals there (which is all `computeVertexNormals` can do) tilts the normal
 * at each corner of a flat face and smears a gradient clear across it.
 *
 * 35° splits the difference cleanly for the geometry this app emits: the
 * coarsest curved surface is a 12-segment cylinder at 30° per facet, so every
 * curve stays smooth, while the shallowest hard edge worth keeping — a 6% luer
 * cone meeting the chip face at ~88° — stays crisp.
 */
export const CREASE_ANGLE = MathUtils.degToRad(35);

export interface RenderMesh {
  /** De-indexed: three floats per corner, three corners per triangle. */
  positions: Float32Array;
  normals: Float32Array;
}

export function creasedRenderMesh(positions: Float32Array, indices: Uint32Array): RenderMesh {
  const indexed = new BufferGeometry();
  indexed.setAttribute('position', new BufferAttribute(positions, 3));
  indexed.setIndex(new BufferAttribute(indices, 1));
  const creased = toCreasedNormals(indexed, CREASE_ANGLE);
  indexed.dispose();
  const mesh = {
    positions: creased.getAttribute('position').array as Float32Array,
    normals: creased.getAttribute('normal').array as Float32Array,
  };
  creased.dispose();
  return mesh;
}
