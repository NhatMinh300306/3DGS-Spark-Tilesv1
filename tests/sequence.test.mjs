import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleFromFile = (path) =>
  import(
    'data:text/javascript;base64,' +
      fs.readFileSync(new URL(path, import.meta.url)).toString('base64')
  );
const { groupFiles, buildRemoteGroups, initSequence, prepareRadFrame } =
  await moduleFromFile('../dist/sequence.js');
const { sceneCatalog, viewerSettings } = await moduleFromFile('../dist/scenes.js');
const flush = async () => {
  for (let step = 0; step < 120; step += 1) await Promise.resolve();
};
const file = (name, folder = '') => ({
  name,
  webkitRelativePath: `${folder}/${name}`,
  arrayBuffer: async () => new ArrayBuffer(10),
});
const config = {
  baseUrl: './data/redandblack-pages/',
  resolutions: ['res1', 'res2', 'res4', 'res8'],
  firstFrame: 1450,
  lastFrame: 1479,
  padding: 6,
  defaultResolution: 'res8',
  fps: 30,
};

function harness(fetchOverride, loadTileFrame) {
  const nodes = new Map();
  const values = { seqBuffer: '4', seqFPS: '30', seqRotation: '0', seqAssign: 'res8' };
  globalThis.document = {
    getElementById(id) {
      if (!nodes.has(id))
        nodes.set(id, {
          value: values[id] || '',
          checked: true,
          textContent: '',
          children: [],
          replaceChildren() {
            this.children = [];
          },
          append(child) {
            this.children.push(child);
          },
        });
      return nodes.get(id);
    },
    createElement() {
      return {};
    },
  };
  globalThis.location = { href: 'https://user.github.io/project/' };
  const requests = [];
  globalThis.fetch =
    fetchOverride ||
    (async (url) => {
      requests.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(10) };
    });
  const meshes = new Set();
  const root = {
    visible: true,
    rotation: { x: 0 },
    add(mesh) {
      meshes.add(mesh);
    },
    remove(mesh) {
      meshes.delete(mesh);
    },
  };
  let alive = 0,
    peak = 0,
    fits = 0;
  class Mesh {
    constructor(options) {
      this.name = options.fileName || new URL(options.url).pathname.split('/').pop();
      this.options = options;
      this.paged = options.paged
        ? {
            numSplats: 12,
            getRadMeta: async () => ({ meta: { count: 12, lodTree: true, chunks: [{}] } }),
          }
        : null;
      this.initialized = Promise.resolve(this);
      alive++;
      peak = Math.max(peak, alive);
    }
    dispose() {
      assert(!this.disposed, 'mesh disposed twice');
      this.disposed = true;
      alive--;
    }
  }
  const player = initSequence({
    THREE: {
      Group: class {
        constructor() {
          return root;
        }
      },
      MathUtils: { degToRad: (x) => (x * Math.PI) / 180 },
    },
    SplatMesh: Mesh,
    loadTileFrame,
    scene: { add() {} },
    fitMesh() {
      fits++;
    },
    setNavigation() {},
    onOpen() {},
  });
  return {
    player,
    $: (id) => document.getElementById(id),
    meshes,
    requests,
    get alive() {
      return alive;
    },
    get peak() {
      return peak;
    },
    get fits() {
      return fits;
    },
  };
}

test('catalogue retains all samples and uses project-relative PLY URLs', () => {
  assert.equal(viewerSettings.defaultSceneId, 'redandblack-tiles');
  assert.deepEqual(
    sceneCatalog
      .filter((s) => s.type === 'static')
      .map((s) => s.id)
      .sort(),
    ['butterfly', 'hobbit', 'poland', 'spaceship', 'tower'],
  );
  const groups = buildRemoteGroups(config, 'https://user.github.io/project/?scene=redandblack');
  assert.equal(Object.keys(groups).length, 4);
  assert.equal(groups.res8.length, 30);
  assert.equal(
    groups.res8[0].url,
    'https://user.github.io/project/data/redandblack-pages/res8/001450.ply',
  );
  assert.equal(groups.res1[29].name, '001479.ply');
  assert.throws(() => buildRemoteGroups({ ...config, firstFrame: 2000 }, 'https://example.com/'));
  assert.throws(() =>
    buildRemoteGroups({ ...config, baseUrl: 'file:///tmp/' }, 'https://example.com/'),
  );
  assert.equal(
    buildRemoteGroups(
      { ...config, baseUrl: 'https://data.example.com/scans/' },
      'https://user.github.io/project/',
    ).res8[0].url,
    'https://data.example.com/scans/res8/001450.ply',
  );
});

test('local sequences are naturally sorted and duplicates are rejected', () => {
  assert.deepEqual(
    groupFiles([file('10.ply'), file('2.ply')]).res8.map((f) => f.name),
    ['2.ply', '10.ply'],
  );
  assert.equal(groupFiles([file('1.ply', 'root/res4')]).res4.length, 1);
  assert.throws(() => groupFiles([file('1.ply'), file('1.ply')]));
  assert.throws(
    () => groupFiles([file('x_1y_1z_1.ply', 'root/layer_1/frame_1450/voxels_new')]),
    /tile/,
  );
});

test('tile playback holds a complete frame until every tile of the next frame is ready', async () => {
  let finish;
  const prepared = [];
  const h = harness(undefined, async (entry) => {
    if (entry.name === 'frame_1451')
      await new Promise((resolve) => {
        finish = resolve;
      });
    const group = {
      visible: false,
      tileCount: 3,
      emptyTiles: 2,
      dispose() {
        this.disposed = true;
      },
    };
    prepared.push(group);
    return group;
  });
  const groups = { layer_1: [1450, 1451].map((id) => ({ name: `frame_${id}`, format: 'tiles' })) };
  assert.equal(
    await h.player.loadGroups(groups, { format: 'tiles', autoplay: true, buffer: 2 }),
    true,
  );
  await flush();
  const first = prepared[0];
  h.player.tick(performance.now() + 1000);
  await flush();
  assert.equal(h.player.state().frameName, 'frame_1450');
  assert.equal(first.visible, true);
  assert.equal(h.meshes.size, 1, 'no partially loaded frame in the scene');
  finish();
  await flush();
  assert.equal(h.player.state().frameName, 'frame_1451');
  assert.equal(first.visible, false);
  assert.equal([...h.meshes].filter((mesh) => mesh.visible).length, 1);
  h.player.deactivate();
  assert(prepared.every((group) => group.disposed));
});

test('hosted autoplay, playback, resolution, seek and cleanup stay bounded', async () => {
  const h = harness();
  assert.equal(
    await h.player.loadRemote(config, { id: 'redandblack', name: 'Redandblack', autoplay: true }),
    true,
  );
  await flush();
  assert.equal(h.player.state().playing, true);
  assert.equal(h.fits, 1);
  assert.equal(
    h.requests[0],
    'https://user.github.io/project/data/redandblack-pages/res8/001450.ply',
  );
  let now = performance.now() + 100;
  for (let i = 0; i < 40; i++) {
    h.player.tick((now += 100));
    await flush();
    assert.equal([...h.meshes].filter((m) => m.visible).length, 1);
    assert(h.player.state().buffered <= 4);
    assert(h.alive <= 4);
  }
  const name = h.player.state().frameName;
  await h.player.selectResolution('res1');
  await flush();
  assert.equal(h.player.state().frameName, name);
  assert.equal(h.player.state().playing, true);
  assert.equal(h.fits, 1, 'camera preserved between resolutions');
  h.$('seqSeek').value = '29';
  h.$('seqSeek').oninput();
  h.$('seqSeek').value = '4';
  h.$('seqSeek').oninput();
  await flush();
  assert.equal(h.player.state().index, 4);
  assert.equal(h.player.state().playing, false);
  assert(h.alive <= 4);
  h.player.deactivate();
  await flush();
  assert.equal(h.alive, 0);
  assert.equal(h.player.state().visible, false);
  h.player.clear();
  assert.equal(h.player.state().frameCount, 0);
});

test('a missing hosted frame reports HTTP and never pretends to play', async () => {
  const h = harness(async () => ({ ok: false, status: 404 }));
  assert.equal(await h.player.loadRemote(config, { autoplay: true }), false);
  assert.equal(h.player.state().playing, false);
  assert.equal(h.player.state().ready, false);
  assert.match(h.player.state().error, /HTTP 404/);
  assert.equal(h.alive, 0);
});

test('scene change aborts a pending fetch without resurrecting a frame', async () => {
  let aborted = false;
  const h = harness(
    (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('AbortError'));
          },
          { once: true },
        );
      }),
  );
  const load = h.player.loadRemote(config, { autoplay: true });
  await flush();
  h.player.deactivate();
  assert.equal(await load, false);
  assert.equal(aborted, true);
  assert.equal(h.alive, 0);
  assert.equal(h.player.state().error, '');
});

test('autoplay can be paused while the first file is still loading', async () => {
  let finish;
  const h = harness(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(10) });
      }),
  );
  const load = h.player.loadRemote(config, { autoplay: true });
  await flush();
  h.player.pause();
  finish();
  assert.equal(await load, true);
  assert.equal(h.player.state().playing, false);
  h.player.deactivate();
});

const radConfig = { ...config, format: 'rad', filePattern: '{frame}-lod.rad', buffer: 3 };

test('RAD URLs retain filenames for chunk resolution, including plain .rad names', () => {
  const root = 'https://user.github.io/project/';
  assert.equal(
    buildRemoteGroups(radConfig, root).res8[0].url,
    root + 'data/redandblack-pages/res8/001450-lod.rad',
  );
  assert.equal(
    buildRemoteGroups({ ...radConfig, filePattern: '{frame}.rad' }, root).res8[29].name,
    '001479.rad',
  );
  assert.equal(
    buildRemoteGroups({ ...radConfig, framesByResolution: { res8: ['frame 1.rad'] } }, root).res8[0]
      .url,
    root + 'data/redandblack-pages/res8/frame%201.rad',
  );
  assert.throws(
    () =>
      buildRemoteGroups(
        {
          ...radConfig,
          framesByResolution: {
            res1: ['001450.rad'],
            res8: ['001451.rad'],
          },
        },
        root,
      ),
    /cùng danh sách/,
  );
});

test('RAD playback streams by URL, keeps only one opaque frame, and cleans up on resolution switch', async () => {
  const h = harness();
  assert.equal(await h.player.loadRemote(radConfig, { autoplay: true }), true);
  await flush();
  assert.equal(h.player.state().format, 'rad');
  assert.equal(h.requests.length, 0, 'do not fetch a whole RAD into a PLY byte loader');
  assert([...h.meshes].every((m) => m.options.paged === true && m.options.url.endsWith('.rad')));
  let now = performance.now() + 100;
  for (let i = 0; i < 65; i++) {
    h.player.tick((now += 100));
    await flush();
    assert.equal([...h.meshes].filter((m) => m.visible && m.opacity > 0).length, 1);
    assert(h.player.state().buffered <= 3);
    assert(h.alive <= 3);
  }
  const frame = h.player.state().frameName;
  const old = [...h.meshes];
  await h.player.selectResolution('res1');
  await flush();
  assert(old.every((m) => m.disposed));
  assert.equal(h.player.state().frameName, frame);
  assert.equal(h.fits, 1);
  assert([...h.meshes].every((m) => m.options.url.includes('/res1/')));
  h.player.clear();
  await flush();
  assert.equal(h.alive, 0);
});

test('a RAD header alone is not treated as a ready dynamic frame', async () => {
  const abort = new AbortController();
  const mesh = {
    initialized: Promise.resolve(),
    paged: {
      numSplats: 0,
      getRadMeta: async () => ({
        meta: { count: 100, lodTree: true, chunks: [{}] },
      }),
    },
  };
  let done = false;
  const pending = prepareRadFrame(mesh, {
    root: { add() {} },
    signal: abort.signal,
    wanted: () => true,
  }).then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false);
  assert.equal(mesh.opacity, 0);
  assert.equal(mesh.visible, true, 'participates in LoD traversal while transparent');
  mesh.paged.numSplats = 3;
  await pending;
  assert.equal(done, true);
});

test('a stalled RAD header can be cancelled or time out without blocking the next scene', async () => {
  const abort = new AbortController();
  const mesh = {
    initialized: Promise.resolve(),
    paged: { getRadMeta: () => new Promise(() => {}) },
  };
  const pending = prepareRadFrame(mesh, {
    root: { add() {} },
    signal: abort.signal,
    wanted: () => true,
  });
  await flush();
  abort.abort();
  await assert.rejects(pending, /hủy/);
  await assert.rejects(
    prepareRadFrame(mesh, {
      root: { add() {} },
      signal: new AbortController().signal,
      wanted: () => true,
      timeoutMs: 10,
    }),
    /RAD chưa có splat/,
  );
});

test('non-LoD and missing RAD metadata fail before showing a blank frame', async () => {
  const base = { root: { add() {} }, signal: new AbortController().signal, wanted: () => true };
  await assert.rejects(
    prepareRadFrame(
      {
        initialized: Promise.resolve(),
        paged: {
          getRadMeta: async () => ({ meta: { count: 20, chunks: [{}] } }),
        },
      },
      base,
    ),
    /LoD/,
  );
  await assert.rejects(
    prepareRadFrame(
      {
        initialized: Promise.resolve(),
        paged: {
          getRadMeta: async () => {
            throw new Error('HTTP 404 header.rad');
          },
        },
      },
      base,
    ),
    /HTTP 404/,
  );
});
