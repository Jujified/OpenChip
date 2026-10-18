/**
 * Binary STL export.
 *
 * Binary rather than ASCII: a serpentine runs to tens of thousands of
 * triangles, and ASCII STL is roughly six times the size for identical
 * geometry. Every slicer reads binary.
 *
 * STL carries no units — it is bare floats. Since the whole model is built in
 * millimetres and every slicer defaults to millimetres, the numbers land
 * correctly without conversion.
 */

export interface StlMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/**
 * Facet normals are computed per triangle rather than written as zeroes.
 *
 * Some slicers and mesh repair tools use the stored normal to resolve
 * ambiguous winding, and a zero normal makes them guess.
 */
export function exportStl(meshes: StlMesh[], header = 'OpenChip'): ArrayBuffer {
  let capacity = 0;
  for (const mesh of meshes) capacity += mesh.indices.length / 3;

  // Sized for the worst case, then trimmed once the real count is known —
  // degenerate facets are dropped as they are found (see below).
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + capacity * TRIANGLE_BYTES);
  const view = new DataView(buffer);

  const headerBytes = new TextEncoder().encode(header.slice(0, HEADER_BYTES - 1));
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);

  let written = 0;
  let offset = HEADER_BYTES + 4;

  for (const mesh of meshes) {
    const { positions, indices } = mesh;

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3;
      const b = indices[i + 1] * 3;
      const c = indices[i + 2] * 3;

      const ax = positions[a];
      const ay = positions[a + 1];
      const az = positions[a + 2];
      const bx = positions[b];
      const by = positions[b + 1];
      const bz = positions[b + 2];
      const cx = positions[c];
      const cy = positions[c + 1];
      const cz = positions[c + 2];

      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;

      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);

      // Skip zero-area facets. Boolean seams produce a handful of them, they
      // carry no surface, and strict STL validators and some slicers report
      // them as mesh errors — so they are dropped rather than written with a
      // meaningless normal.
      if (len <= 1e-12) continue;

      nx /= len;
      ny /= len;
      nz /= len;

      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      view.setFloat32(offset + 12, ax, true);
      view.setFloat32(offset + 16, ay, true);
      view.setFloat32(offset + 20, az, true);
      view.setFloat32(offset + 24, bx, true);
      view.setFloat32(offset + 28, by, true);
      view.setFloat32(offset + 32, bz, true);
      view.setFloat32(offset + 36, cx, true);
      view.setFloat32(offset + 40, cy, true);
      view.setFloat32(offset + 44, cz, true);
      view.setUint16(offset + 48, 0, true);

      offset += TRIANGLE_BYTES;
      written += 1;
    }
  }

  view.setUint32(HEADER_BYTES, written, true);

  // Trim to what was actually written, so the declared facet count and the
  // file length agree — readers check that.
  return written === capacity ? buffer : buffer.slice(0, offset);
}

/** Triangle count a reader would find in an STL buffer, for verification. */
export function stlTriangleCount(buffer: ArrayBuffer): number {
  if (buffer.byteLength < HEADER_BYTES + 4) return 0;
  return new DataView(buffer).getUint32(HEADER_BYTES, true);
}
