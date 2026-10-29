// Test scheduling, coordinates and resource ownership without pretending to render on a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { buildTileGroups, createTileLoader } = await import(
  'data:text/javascript;base64,' +
    fs.readFileSync(new URL('../dist/tiles.js', import.meta.url)).toString('base64')
);
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const manifest = () => ({
  schema: 'splat-lab-tiles-v1',
  coordinateSpace: 'world',
  defaultLayer: 'layer_8',
  layers: ['layer_1', 'layer_8'].map((id) => ({
    id,
    frames: [1451, 1450].map((frame) => ({
      id: frame,
      emptyTiles: 2,
      tiles: [1, 2, 3, 4].map((tile) => ({
        path: `${id}/frame_${frame}/voxels_new/tile ${tile}.ply`,
        splats: 2,
        bytes: 8,
      })),
    })),
  })),
});
const manifestUrl = 'https://user.github.io/repository/data/redandblack_tiles/tiles.json';
const entry = () => buildTileGroups(manifest(), manifestUrl).layer_1[0];
const options = () => ({ signal: new AbortController().signal, wanted: () => true });

class Group {
  constructor() {
    this.children = [];
    this.position = { x: 0, y: 0, z: 0 };
  }
  add(mesh) {
    this.children.push(mesh);
  }
  remove(mesh) {
    this.children = this.children.filter((child) => child !== mesh);
  }
}
class Box3 {
  constructor() {
    this.min = Infinity;
    this.max = -Infinity;
  }
  union(box) {
    this.min = Math.min(this.min, box.min);
    this.max = Math.max(this.max, box.max);
  }
}
const response = (size = 8) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(size) });

test('manifest preserves layer identifiers, frame grouping and project-relative encoded URLs', () => {
  const groups = buildTileGroups(manifest(), manifestUrl);
  assert.deepEqual(Object.keys(groups), ['layer_1', 'layer_8']);
  assert.deepEqual(
    groups.layer_1.map((frame) => frame.name),
    ['frame_1450', 'frame_1451'],
  );
  assert.equal(groups.layer_1[0].tiles.length, 4);
  assert.equal(groups.layer_1[0].emptyTiles, 2);
  assert.equal(groups.layer_1[0].totalBytes, 32);
  assert.equal(
    groups.layer_1[0].tiles[0].url,
    'https://user.github.io/repository/data/redandblack_tiles/layer_1/frame_1450/voxels_new/tile%201.ply',
  );
  const bad = manifest();
  bad.layers[1].frames.pop();
  assert.throws(() => buildTileGroups(bad, manifestUrl), /cùng danh sách/);
  const traversal = manifest();
  traversal.layers[0].frames[0].tiles[0].path = '../other.ply';
  assert.throws(() => buildTileGroups(traversal, manifestUrl), /không hợp lệ/);
});

test('fetch concurrency and pending buffers are bounded; decode is serial and positions remain unchanged', async () => {
  const network = [],
    decodes = [],
    meshes = [],
    progress = [];
  let fetching = 0,
    maxFetching = 0,
    decoding = 0,
    maxDecoding = 0,
    returned = false;
  class Mesh extends Group {
    constructor(args) {
      super();
      assert.equal(args.lod, false);
      this.numSplats = 2;
      this.index = meshes.length;
      meshes.push(this);
      decoding++;
      maxDecoding = Math.max(maxDecoding, decoding);
      this.initialized = new Promise((resolve) =>
        decodes.push(() => {
          decoding--;
          resolve();
        }),
      );
    }
    getBoundingBox() {
      return { min: this.index * 10, max: this.index * 10 + 1 };
    }
    dispose() {
      assert(!this.disposed);
      this.disposed = true;
    }
  }
  const load = createTileLoader({
    THREE: { Group, Box3 },
    SplatMesh: Mesh,
    concurrency: () => 2,
    fetcher: () =>
      new Promise((resolve) => {
        fetching++;
        maxFetching = Math.max(maxFetching, fetching);
        network.push(() => {
          fetching--;
          resolve(response());
        });
      }),
  });
  const promise = load(entry(), { ...options(), onProgress: (value) => progress.push(value) }).then(
    (group) => {
      returned = true;
      return group;
    },
  );
  await flush();
  assert.equal(network.length, 2);
  network.shift()();
  network.shift()();
  await flush();
  assert.equal(meshes.length, 1, 'only one decoder runs at a time');
  assert.equal(returned, false);
  for (let i = 0; i < 4; i++) {
    decodes.shift()();
    await flush();
    while (network.length) network.shift()();
    await flush();
  }
  const group = await promise;
  assert.equal(group.children.length, 4);
  assert.equal(group.visible, false);
  assert.equal(maxFetching, 2);
  assert.equal(maxDecoding, 1);
  assert.deepEqual(group.getBoundingBox(), Object.assign(new Box3(), { min: 0, max: 31 }));
  assert(
    meshes.every((mesh) => mesh.position.x === 0 && mesh.position.y === 0 && mesh.position.z === 0),
  );
  assert.equal(progress.at(-1).loaded, 4);
  assert.equal(progress.at(-1).bytes, 32);
  group.dispose();
  group.dispose();
  assert(meshes.every((mesh) => mesh.disposed));
  assert.equal(group.children.length, 0);
});

test('one missing tile fails the whole frame and disposes every decoded sibling', async () => {
  const meshes = [];
  class Mesh extends Group {
    constructor() {
      super();
      this.numSplats = 2;
      this.initialized = Promise.resolve();
      meshes.push(this);
    }
    getBoundingBox() {
      return { min: 0, max: 1 };
    }
    dispose() {
      this.disposed = true;
    }
  }
  let count = 0;
  const load = createTileLoader({
    THREE: { Group, Box3 },
    SplatMesh: Mesh,
    concurrency: () => 1,
    fetcher: async () => (++count === 3 ? { ok: false, status: 404 } : response()),
  });
  await assert.rejects(load(entry(), options()), /frame_1450\/tile 3.ply: HTTP 404/);
  assert.equal(meshes.length, 2);
  assert(meshes.every((mesh) => mesh.disposed));
});

test('cancellation aborts downloads and cleans a decoder that finishes after the scene changes', async () => {
  let finish, mesh;
  class Mesh extends Group {
    constructor() {
      super();
      this.numSplats = 2;
      mesh = this;
      this.initialized = new Promise((resolve) => {
        finish = resolve;
      });
    }
    dispose() {
      this.disposed = true;
    }
    getBoundingBox() {
      throw new Error('cancelled tile must never enter the group');
    }
  }
  const controller = new AbortController();
  let aborted = false,
    count = 0;
  const load = createTileLoader({
    THREE: { Group, Box3 },
    SplatMesh: Mesh,
    concurrency: () => 2,
    fetcher: (url, { signal }) =>
      ++count === 1
        ? Promise.resolve(response())
        : new Promise((resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new Error('AbortError'));
              },
              { once: true },
            );
          }),
  });
  const pending = load(entry(), { signal: controller.signal, wanted: () => true });
  const rejection = assert.rejects(pending, /hủy|AbortError/);
  await flush();
  controller.abort();
  finish();
  await rejection;
  assert.equal(aborted, true);
  assert.equal(mesh.disposed, true);
});

test('an empty frame makes no network requests, and a changed tile size is rejected before decode', async () => {
  const load = createTileLoader({
    THREE: { Group, Box3 },
    SplatMesh: class {
      constructor() {
        throw new Error('must not decode');
      }
    },
    fetcher: async () => response(7),
  });
  await assert.rejects(load(entry(), options()), /Kích thước tile/);
  const group = await load(
    { ...entry(), tiles: [], emptyTiles: 4, totalBytes: 0, totalSplats: 0 },
    options(),
  );
  assert.equal(group.children.length, 0);
  assert.equal(group.emptyTiles, 4);
  group.dispose();
});
