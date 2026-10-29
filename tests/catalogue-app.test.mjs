// Smoke the scene coordinator without a browser or GPU. These are logic tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL('../dist/' + name, import.meta.url), 'utf8');
const appSource = read('app.js').replace(/^import .*;\n/gm, '');
const sequenceSource = read('sequence.js').replace(/^export /gm, '');
const tilesSource = read('tiles.js').replace(/^export /gm, '');
const catalogSource = read('scenes.js').replace(/^export /gm, '');
const flush = async () => {
  for (let i = 0; i < 150; i++) await Promise.resolve();
};

function setup({ missing = false, missingRad = false, query = '', index, tileManifest } = {}) {
  const elements = new Map();
  const defaults = {
    seqBuffer: '4',
    seqFPS: '30',
    seqRotation: '0',
    seqAssign: 'res8',
    speed: '3',
  };
  class Element {
    constructor() {
      this.value = '';
      this.children = [];
      this.style = {};
      this.checked = true;
      this.classList = {
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      };
      this.clientWidth = 900;
      this.clientHeight = 700;
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    prepend(node) {
      this.children.unshift(node);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    setAttribute() {}
    addEventListener() {}
    remove() {}
    focus() {}
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const e = new Element();
        e.value = defaults[id] || '';
        elements.set(id, e);
      }
      return elements.get(id);
    },
    createElement() {
      return new Element();
    },
    body: new Element(),
    addEventListener() {},
  };
  class Vector {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }
    clone() {
      return new Vector(this.x, this.y, this.z);
    }
    copy(v) {
      Object.assign(this, { x: v.x, y: v.y, z: v.z });
      return this;
    }
    set(x, y, z) {
      Object.assign(this, { x, y, z });
      return this;
    }
    fromArray(a) {
      return this.set(...a);
    }
    add() {
      return this;
    }
    addScaledVector() {
      return this;
    }
    normalize() {
      return this;
    }
    applyQuaternion() {
      return this;
    }
    length() {
      return 1;
    }
  }
  class Group {
    constructor() {
      this.position = new Vector();
      this.quaternion = new Vector();
      this.rotation = new Vector();
      this.scale = { setScalar() {} };
      this.visible = true;
      this.children = [];
      this.matrixWorld = {};
    }
    add(m) {
      this.children.push(m);
    }
    remove(m) {
      this.children = this.children.filter((n) => n !== m);
    }
    updateWorldMatrix() {}
  }
  class Scene extends Group {}
  class Box3 {
    constructor() {
      this.min = { x: 0 };
      this.empty = true;
    }
    union() {
      this.empty = false;
      return this;
    }
    clone() {
      return this;
    }
    applyMatrix4() {
      return this;
    }
    isEmpty() {
      return this.empty;
    }
    getCenter() {
      return new Vector();
    }
    getSize() {
      return new Vector(1, 1, 1);
    }
  }
  const staticUrls = [];
  let uuid = 0;
  class SplatMesh extends Group {
    constructor(options) {
      super();
      this.uuid = String(uuid++);
      this.numSplats = 12;
      this.paged = options.paged
        ? {
            numSplats: 12,
            getRadMeta: async () => {
              if (missing || missingRad) throw new Error('HTTP 404');
              return { meta: { lodTree: true, count: 12, chunks: [{}] } };
            },
          }
        : null;
      this.recolor = { set() {} };
      this.initialized = Promise.resolve(this);
      if (options.url) staticUrls.push(options.url);
    }
    dispose() {}
    getBoundingBox() {
      return {
        min: { x: 0 },
        clone() {
          return this;
        },
        applyMatrix4() {
          return this;
        },
        isEmpty() {
          return false;
        },
        getCenter() {
          return new Vector();
        },
        getSize() {
          return new Vector(1, 1, 1);
        },
      };
    }
  }
  class Renderer {
    constructor() {
      this.domElement = new Element();
    }
    setPixelRatio() {}
    setSize() {}
    setAnimationLoop() {}
    getPixelRatio() {
      return 1;
    }
  }
  class Camera extends Group {
    constructor() {
      super();
      this.up = new Vector(0, 1, 0);
    }
    updateProjectionMatrix() {}
    getWorldDirection() {
      return new Vector(0, 0, -1);
    }
  }
  class Controls {
    constructor() {
      this.target = new Vector();
    }
    update() {}
  }
  class SparkControls {
    constructor() {
      this.fpsMovement = {};
      this.pointerControls = {
        scroll: new Vector(),
        rotateVelocity: new Vector(),
        moveVelocity: new Vector(),
      };
    }
  }
  const location = { href: 'https://user.github.io/project/' + query, search: query };
  const requests = [];
  const context = vm.createContext({
    document,
    location,
    URL,
    URLSearchParams,
    AbortController,
    performance,
    console,
    setTimeout,
    setInterval,
    clearInterval,
    Event,
    history: {
      replaceState(a, b, url) {
        location.href = String(url);
      },
    },
    Option: class extends Element {
      constructor(text, value) {
        super();
        this.textContent = text;
        this.value = value;
      }
    },
    window: { addEventListener() {}, dispatchEvent() {} },
    ResizeObserver: class {
      observe() {}
    },
    THREE: {
      Scene,
      Group,
      Box3,
      Vector3: Vector,
      Color: class {
        set() {}
      },
      PerspectiveCamera: Camera,
      WebGLRenderer: Renderer,
      MathUtils: { degToRad: (x) => (x * Math.PI) / 180, radToDeg: (x) => (x * 180) / Math.PI },
    },
    OrbitControls: Controls,
    SparkControls,
    SplatMesh,
    SparkRenderer: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    fetch: async (url) => {
      requests.push(url);
      if (url.endsWith('/tiles.json'))
        return {
          ok: Boolean(tileManifest),
          status: tileManifest ? 200 : 404,
          json: async () => tileManifest,
        };
      if (url.endsWith('.json'))
        return { ok: Boolean(index), status: index ? 200 : 404, json: async () => index };
      return {
        ok: !missing,
        status: missing ? 404 : 200,
        arrayBuffer: async () => new ArrayBuffer(10),
      };
    },
  });
  vm.runInContext(
    catalogSource + '\n' + tilesSource + '\n' + sequenceSource + '\n' + appSource,
    context,
  );
  return { context, requests, staticUrls, $: (id) => document.getElementById(id) };
}

test('without a tile manifest, opening the site starts hosted RAD and retains static samples', async () => {
  const h = setup();
  await flush();
  assert.match(h.staticUrls[0], /\/project\/data\/redandblack-pages\/res8\/001450-lod.rad$/);
  assert.equal(h.$('scenePicker').value, 'redandblack-rad');
  assert.equal(h.$('seqResolution').value, 'res8');
  assert.match(h.$('seqPlay').textContent, /Tạm dừng/);
  await vm.runInContext("selectScene('spaceship')", h.context);
  await flush();
  assert.equal(h.$('sequencePanel').open, false);
  assert.match(h.staticUrls.at(-1), /cozy-spaceship/);
});

const tiledManifest = {
  schema: 'splat-lab-tiles-v1',
  coordinateSpace: 'world',
  defaultLayer: 'layer_4',
  fps: 24,
  layers: ['layer_1', 'layer_4'].map((id) => ({
    id,
    frames: [1450, 1451].map((frame) => ({
      id: frame,
      emptyTiles: 2,
      tiles: ['x_1y_1z_1.ply', 'x_2y_1z_1.ply'].map((file) => ({
        path: `${id}/frame_${frame}/voxels_new/${file}`,
        bytes: 10,
        splats: 12,
      })),
    })),
  })),
};

test('default tile scene groups spatial tiles into frames and exposes layer resolution choices', async () => {
  const h = setup({ tileManifest: tiledManifest });
  await flush();
  assert.equal(h.$('scenePicker').value, 'redandblack-tiles');
  assert.equal(h.$('seqResolution').value, 'layer_4');
  assert.equal(h.$('seqSeek').max, 1, 'two time frames, not four spatial tiles');
  assert.equal(h.$('seqFPS').value, 24);
  assert.match(h.$('seqPlay').textContent, /Tạm dừng/);
  assert(
    h.requests.some((url) =>
      url.includes('/project/data/redandblack_tiles/layer_4/frame_1450/voxels_new/'),
    ),
  );
  assert.match(h.$('tileStats').textContent, /2 tile/);
  await vm.runInContext("sequence.selectResolution('layer_1')", h.context);
  assert.equal(h.$('seqResolution').value, 'layer_1');
  await vm.runInContext("selectScene('butterfly')", h.context);
  assert.equal(h.$('sequencePanel').open, false);
  assert.equal(h.$('tileStats').hidden, true);
});

test('a shared tile scene URL selects the requested layer', async () => {
  const h = setup({ tileManifest: tiledManifest, query: '?scene=redandblack-tiles&res=layer_1' });
  await flush();
  assert.equal(h.$('seqResolution').value, 'layer_1');
  assert(h.requests.some((url) => url.includes('/layer_1/frame_1450/')));
  vm.runInContext('sequence.deactivate()', h.context);
});

test('missing RAD falls back to available PLY without removing RAD from the catalogue', async () => {
  const h = setup({ missingRad: true });
  await flush();
  assert.equal(h.$('scenePicker').value, 'redandblack');
  assert(h.requests.some((url) => url.endsWith('/res8/001450.ply')));
  assert.equal(h.$('datasetNotice').hidden, false);
  assert(h.$('scenePicker').children.some((option) => option.value === 'redandblack-rad'));
});

test('missing datasets fall back to a real sample and keep an honest notice', async () => {
  const h = setup({ missing: true });
  await flush();
  assert.equal(h.$('scenePicker').value, 'butterfly');
  assert.equal(h.$('datasetNotice').hidden, false);
  assert.match(h.$('datasetNotice').textContent, /chưa sẵn sàng/);
  assert.equal(h.staticUrls.at(-1), 'https://sparkjs.dev/assets/splats/butterfly.spz');
});

test('shared scene/resolution links still select PLY res2', async () => {
  const h = setup({ query: '?scene=redandblack&res=res2' });
  await flush();
  assert(h.requests.some((url) => url.endsWith('/res2/001450.ply')));
  assert.equal(h.$('seqResolution').value, 'res2');
});

test('generated index uses the exact RAD names and actual available resolutions', async () => {
  const h = setup({
    index: {
      sequences: {
        rad: {
          baseUrl: './data/redandblack-pages/',
          resolutions: ['res4'],
          defaultResolution: 'res4',
          framesByResolution: { res4: ['001450.rad', '001451.rad'] },
        },
      },
    },
  });
  await flush();
  assert.equal(h.$('seqResolution').value, 'res4');
  assert.match(h.staticUrls[0], /\/res4\/001450.rad$/);
  assert.equal(h.$('seqSeek').max, 1);
});
