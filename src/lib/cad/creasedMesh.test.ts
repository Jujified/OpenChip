import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { creasedRenderMesh } from './creasedMesh';

describe('creased render meshes', () => {
  it('gives every face of a welded cube its own flat normal', () => {
    // 8 shared corners, 12 triangles: how manifold hands back a box.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
    const indices = new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]);
    const mesh = creasedRenderMesh(positions, indices);

    assert.equal(mesh.positions.length, 12 * 3 * 3, 'de-indexed: three corners per triangle');
    assert.equal(mesh.normals.length, mesh.positions.length);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const axis = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]].map(Math.abs);
      assert.ok(
        axis.filter((c) => Math.abs(c - 1) < 1e-6).length === 1 && axis.filter((c) => c < 1e-6).length === 2,
        `corner normal ${axis} is averaged across a hard edge`,
      );
    }
  });
});
