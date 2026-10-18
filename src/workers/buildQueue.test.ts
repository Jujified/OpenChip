import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createBuildQueue } from './buildQueue';

type Req = { id: string; kind: 'preview' | 'export' };

/** A queue whose builds take one macrotask, like a real synchronous build. */
function harness() {
  const built: string[] = [];
  const queue = createBuildQueue<Req>(async (request) => {
    built.push(request.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  return { built, queue, settle };
}

describe('the CAD build queue', () => {
  it('builds only the newest of a burst of previews', async () => {
    const { built, queue, settle } = harness();
    queue.push({ id: 'p1', kind: 'preview' });
    queue.push({ id: 'p2', kind: 'preview' });
    queue.push({ id: 'p3', kind: 'preview' });
    await settle();
    assert.deepEqual(built, ['p3']);
  });

  it('never lets a preview replace an export', async () => {
    const { built, queue, settle } = harness();
    queue.push({ id: 'p1', kind: 'preview' });
    queue.push({ id: 'export', kind: 'export' });
    queue.push({ id: 'p2', kind: 'preview' });
    await settle();
    assert.deepEqual(built, ['export', 'p2']);
  });

  it('coalesces previews posted while a build is running', async () => {
    const { built, queue, settle } = harness();
    queue.push({ id: 'first', kind: 'preview' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    // Mid-build: these land while `first` is still going.
    queue.push({ id: 'stale', kind: 'preview' });
    queue.push({ id: 'newest', kind: 'preview' });
    await settle();
    assert.deepEqual(built, ['first', 'newest']);
  });

  it('builds every export, in order', async () => {
    const { built, queue, settle } = harness();
    queue.push({ id: 'a', kind: 'export' });
    queue.push({ id: 'b', kind: 'export' });
    await settle();
    assert.deepEqual(built, ['a', 'b']);
  });
});
