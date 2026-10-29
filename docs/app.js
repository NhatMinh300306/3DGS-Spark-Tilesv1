import { buildTileGroups, createTileLoader } from './tiles.js';
import { initSequence } from './sequence.js';
import { sceneCatalog, viewerSettings } from './scenes.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh, SparkControls } from '@sparkjsdev/spark';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101719');
const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 10000);
camera.position.set(0, 1, 4);
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(1);
viewport.prepend(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.02;
controls.maxDistance = 5000;
controls.zoomSpeed = 1.3;
const spark = new SparkRenderer({
  renderer,
  pagedExtSplats: true,
  lodSplatScale: 1,
  numLodFetchers: 3,
  lodCleanupTimeoutMs: 1000,
  coneFov0: 70,
  coneFov: 120,
  coneFoveate: 0.4,
  behindFoveate: 0.2,
});
renderer.domElement.tabIndex = 0;
const flyControls = new SparkControls({ canvas: renderer.domElement });
let navigation = 'orbit';
function setNavigation(value) {
  navigation = value;
  controls.enabled = value === 'orbit';
  flyControls.lastTime = performance.now();
  flyControls.fpsMovement.keydown = {};
  flyControls.fpsMovement.keycode = {};
  flyControls.pointerControls.scroll.set(0, 0, 0);
  flyControls.pointerControls.rotateVelocity.set(0, 0, 0);
  flyControls.pointerControls.moveVelocity.set(0, 0, 0);
  $('navigation').value = value;
  keys.clear();
}

scene.add(spark);
const objects = new Map();
let busy = false,
  homePosition = camera.position.clone(),
  homeTarget = controls.target.clone(),
  homeQuaternion = camera.quaternion.clone();
// Scene metadata lives in scenes.js so publishers can add datasets without editing the renderer.
let activeSceneId = '';
let sceneSelection = 0;
let manifestController = new AbortController();

function populateSceneSelectors() {
  $('scenePicker').replaceChildren();
  const empty = new Option('Scene tùy chọn', '');
  empty.disabled = true;
  $('scenePicker').append(empty);
  for (const item of sceneCatalog) $('scenePicker').append(new Option(item.name, item.id));
  $('demo').replaceChildren(new Option('Chọn cảnh mẫu…', ''));
  for (const item of sceneCatalog.filter((item) => item.type === 'static')) {
    $('demo').append(new Option(item.name, item.id));
  }
}

function updateSceneUrl(resolution) {
  const url = new URL(location.href);
  if (activeSceneId) url.searchParams.set('scene', activeSceneId);
  else url.searchParams.delete('scene');
  if (resolution) url.searchParams.set('res', resolution);
  else url.searchParams.delete('res');
  history.replaceState(null, '', url);
}

function renderSequenceState(state) {
  const visible = state.visible && state.frameCount > 0;
  if (visible) {
    if (state.error) status('Không mở được chuỗi: ' + state.error, true);
    else if (state.switching && !state.ready) status('Đang tải frame đầu tiên…');
    else if (state.ready)
      status(
        `${state.sourceName} · ${state.resolution} · ${state.playing ? 'đang phát' : 'tạm dừng'}`,
      );
  }
}

function activateSequence(source) {
  if (!source.id) {
    sceneSelection += 1;
    manifestController.abort();
  }
  activeSceneId = source.id;
  for (const id of [...objects.keys()]) removeObject(id);
  $('scenePicker').value = activeSceneId;
  $('demo').value = '';
  $('loadDemo').disabled = true;
  $('sceneTitle').textContent = source.name;
  $('credit').textContent = 'Dynamic 3DGS · chọn resolution và điều khiển phát bên dưới';
  scene.background.set('#101719');
  $('background').value = '#101719';
  controls.autoRotate = false;
  $('orbit').classList.remove('active');
  setNavigation('orbit');
  camera.position.set(0, 1, 4);
  controls.target.set(0, 1, 0);
  controls.update();
  updateSceneUrl();
}

async function selectScene(id, { startup = false, resolution, preserveNotice = false } = {}) {
  if (busy) return;
  const item = sceneCatalog.find((entry) => entry.id === id);
  if (!item) return;
  const ticket = ++sceneSelection;
  manifestController.abort();
  manifestController = new AbortController();
  const manifestSignal = manifestController.signal;
  activeSceneId = id;
  $('scenePicker').value = id;
  if (!preserveNotice) $('datasetNotice').hidden = true;
  updateSceneUrl(resolution);
  if (item.type === 'sequence') {
    $('sequencePanel').open = true;
    let available = false;
    try {
      if (item.sequence.format === 'tiles') {
        sequence.deactivate();
        status('Đang đọc danh sách frame và tile…');
        const manifestUrl = new URL(item.sequence.manifestUrl, location.href).href;
        const response = await fetch(manifestUrl, { signal: manifestSignal, cache: 'no-cache' });
        if (!response.ok)
          throw new Error(
            `HTTP ${response.status} — ${manifestUrl}. Chạy py configure_tiles.py trước.`,
          );
        const manifest = await response.json();
        if (ticket !== sceneSelection) return;
        const groups = buildTileGroups(manifest, response.url || manifestUrl);
        $('tileManifest').value = item.sequence.manifestUrl;
        available = await sequence.loadGroups(groups, {
          id,
          name: item.name,
          format: 'tiles',
          autoplay: item.autoplay,
          resolution: groups[resolution] ? resolution : manifest.defaultLayer,
          fps: manifest.fps || 30,
          rotationX: manifest.rotationX || 0,
          buffer: 2,
        });
      } else {
        available = await sequence.loadRemote(item.sequence, {
          id,
          name: item.name,
          autoplay: item.autoplay,
          resolution: (
            item.sequence.resolutions || Object.keys(item.sequence.framesByResolution || {})
          ).includes(resolution)
            ? resolution
            : item.sequence.defaultResolution,
        });
      }
    } catch (error) {
      if (ticket !== sceneSelection || manifestSignal.aborted) return;
      status('Không mở được chuỗi: ' + error.message, !startup);
    }
    if (ticket !== sceneSelection) return;
    if (available) updateSceneUrl(sequence.state().resolution);
    else if (startup) {
      const previous =
        item.id === 'redandblack-tiles'
          ? 'redandblack-rad'
          : item.id === 'redandblack-rad'
            ? 'redandblack'
            : viewerSettings.fallbackSceneId;
      $('datasetNotice').hidden = false;
      $('datasetNotice').textContent =
        `${item.name} chưa sẵn sàng trên máy chủ này. ` +
        'Đang thử cảnh có sẵn tiếp theo. Với dữ liệu tile, chạy py configure_tiles.py; với RAD/PLY nguyên frame, chạy py configure_dataset.py.';
      await selectScene(previous, {
        startup: previous !== viewerSettings.fallbackSceneId,
        preserveNotice: true,
      });
    }
  } else {
    sequence.deactivate();
    $('sequencePanel').open = false;
    $('demo').value = id;
    await load({ ...item, demo: item, replace: true });
  }
}

function status(message, error = false) {
  const changed = $('message').textContent !== message;
  $('message').textContent = message;
  $('message').classList.toggle('error', error);
  if (error && changed) window.dispatchEvent(new Event('viewer-error'));
}
function removeObject(id) {
  const obj = objects.get(id);
  if (!obj) return;
  scene.remove(obj.mesh);
  obj.mesh.dispose();
  obj.element.remove();
  objects.delete(id);
  if (!objects.size) {
    $('sceneTitle').textContent = 'Mở scene của bạn.';
    $('credit').textContent = 'Chọn file PLY/SPZ hoặc nhập URL RAD để bắt đầu.';
    status('Chưa có dữ liệu. Mở file từ máy hoặc thêm URL ở bảng bên phải.');
  }
}
function saveHome() {
  homePosition.copy(camera.position);
  homeTarget.copy(controls.target);
  homeQuaternion.copy(camera.quaternion);
}
function fitMesh(mesh) {
  if (mesh.paged && !mesh.paged.numSplats) {
    status('Chờ RAD tải splat rồi bấm Vừa khung.');
    return false;
  }
  mesh.updateWorldMatrix(true, false);
  const bounds = mesh.getBoundingBox().clone().applyMatrix4(mesh.matrixWorld);
  if (bounds.isEmpty() || !Number.isFinite(bounds.min.x)) return false;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.1);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(0, size * 0.15, size * 1.15));
  camera.far = Math.max(10000, size * 10);
  camera.updateProjectionMatrix();
  controls.update();
  saveHome();
  return true;
}
function addObjectUI(mesh, name, paged) {
  const el = document.createElement('div');
  el.className = 'object';
  const top = document.createElement('div');
  top.className = 'name';
  const title = document.createElement('span');
  title.textContent = name;
  const remove = document.createElement('button');
  remove.textContent = '×';
  remove.title = 'Xóa đối tượng';
  remove.onclick = () => removeObject(mesh.uuid);
  top.append(title, remove);
  el.append(top);
  const caption = document.createElement('p');
  caption.className = 'hint';
  caption.textContent = paged
    ? 'RAD · streaming / GPU paging'
    : 'Local LoD · dữ liệu đầy đủ trong bộ nhớ';
  el.append(caption);
  const visible = document.createElement('label');
  visible.textContent = 'Hiển thị';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = true;
  check.onchange = () => (mesh.visible = check.checked);
  visible.append(check);
  el.append(visible);
  function slider(text, min, max, step, value, onChange) {
    const label = document.createElement('label');
    label.textContent = text;
    const input = document.createElement('input');
    input.type = 'range';
    Object.assign(input, { min, max, step, value });
    input.setAttribute('aria-label', text + ' ' + name);
    input.oninput = () => onChange(Number(input.value));
    el.append(label, input);
  }
  slider('Opacity', 0, 1, 0.01, 1, (v) => (mesh.opacity = v));
  slider('Ưu tiên LoD', 0.25, 3, 0.05, 1, (v) => (mesh.lodScale = v));
  slider(
    'Xoay X (độ)',
    -180,
    180,
    1,
    THREE.MathUtils.radToDeg(mesh.rotation.x),
    (v) => (mesh.rotation.x = THREE.MathUtils.degToRad(v)),
  );
  const transformLabel = document.createElement('label');
  transformLabel.textContent = 'Vị trí X / Y / Z';
  el.append(transformLabel);
  const transforms = document.createElement('div');
  transforms.className = 'transforms';
  for (const axis of ['x', 'y', 'z']) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.value = mesh.position[axis];
    input.setAttribute('aria-label', 'Vị trí ' + axis + ' ' + name);
    input.onchange = () => {
      if (Number.isFinite(input.valueAsNumber)) mesh.position[axis] = input.valueAsNumber;
    };
    transforms.append(input);
  }
  el.append(transforms);
  const colorLabel = document.createElement('label');
  colorLabel.textContent = 'Nhân màu';
  const color = document.createElement('input');
  color.type = 'color';
  color.value = '#ffffff';
  color.oninput = () => mesh.recolor.set(color.value);
  colorLabel.append(color);
  el.append(colorLabel);
  if (!paged) {
    const fit = document.createElement('button');
    fit.textContent = 'Đưa vào khung nhìn';
    fit.onclick = () => fitMesh(mesh);
    el.append(fit);
  }
  $('objects').append(el);
  objects.set(mesh.uuid, { mesh, element: el, name });
}
async function load({ url, file, name, mode = 'auto', demo, replace = false }) {
  if (busy) {
    status('Đang khởi tạo dữ liệu; hãy chờ thao tác hiện tại hoàn tất.');
    return;
  }
  busy = true;
  for (const id of ['seqFolder', 'seqFiles', 'seqRemote', 'files', 'loadTileManifest'])
    $(id).disabled = true;
  $('scenePicker').disabled = $('demo').disabled = true;
  $('loadDemo').disabled = $('loadUrl').disabled = true;
  const started = performance.now();
  let mesh;
  try {
    const isRad = file
      ? /\.rad$/i.test(file.name)
      : /\.rad$/i.test(new URL(url, location.href).pathname);
    const paged = !file && (mode === 'paged' || (mode === 'auto' && isRad));
    if (file && isRad)
      throw new Error(
        'Để giữ streaming, hãy phục vụ RAD qua HTTP rồi dùng URL. RAD chia chunk cần kèm tất cả .radc.',
      );
    status('Đang tải và khởi tạo ' + name + '…');
    const options = {
      lod: !paged,
      paged,
      onProgress: (event) => {
        if (event.total)
          status('Đang tải ' + name + ' · ' + Math.round((event.loaded / event.total) * 100) + '%');
      },
    };
    if (file) {
      options.fileBytes = await file.arrayBuffer();
      options.fileName = file.name;
    } else options.url = new URL(url, location.href).href;
    mesh = new SplatMesh(options);
    if (demo?.quaternion) mesh.quaternion.fromArray(demo.quaternion);
    if (demo?.position) mesh.position.fromArray(demo.position);
    if (demo?.scale) mesh.scale.setScalar(demo.scale);
    if (replace) for (const id of [...objects.keys()]) removeObject(id);
    scene.add(mesh);
    await mesh.initialized;
    addObjectUI(mesh, name, paged);
    $('sceneTitle').textContent = name;
    $('credit').textContent =
      demo?.credit || 'Dữ liệu của bạn · ' + (paged ? 'RAD streaming' : 'Tiny-LoD tại client');
    if (demo) {
      scene.background.set(demo.background || '#101719');
      $('background').value = demo.background || '#101719';
    }
    if (demo?.camera) {
      camera.position.fromArray(demo.camera);
      if (demo.cameraQuaternion) {
        camera.quaternion.fromArray(demo.cameraQuaternion).normalize();
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        controls.target.copy(camera.position).add(dir);
      } else controls.target.fromArray(demo.target || [0, 0, -1]);
      controls.update();
      saveHome();
    } else if (!paged) fitMesh(mesh);
    if (demo?.cameraQuaternion) {
      camera.quaternion.fromArray(demo.cameraQuaternion).normalize();
      saveHome();
    }
    if (demo) {
      setNavigation(paged ? 'fly' : 'orbit');
      spark.lodSplatScale = demo.lodSplatScale ?? 1;
      $('budget').value = spark.lodSplatScale;
      $('budgetOut').textContent = spark.lodSplatScale.toFixed(2) + '×';
    }
    renderer.domElement.focus();
    $('loadtime').textContent = ((performance.now() - started) / 1000).toFixed(2) + ' s';
    status(paged ? 'RAD đã khởi tạo · chi tiết tiếp tục tải theo góc nhìn.' : 'LoD đã sẵn sàng.');
  } catch (error) {
    if (mesh) {
      scene.remove(mesh);
      mesh.dispose();
    }
    status(
      'Không mở được: ' +
        error.message +
        ' Kiểm tra URL, CORS và dữ liệu; có thể thử cảnh Butterfly hoặc file PLY trên máy.',
      true,
    );
    console.error(error);
  } finally {
    busy = false;
    for (const id of ['seqFolder', 'seqFiles', 'seqRemote', 'files', 'loadTileManifest'])
      $(id).disabled = false;
    $('scenePicker').disabled = $('demo').disabled = false;
    $('loadUrl').disabled = false;
    $('loadDemo').disabled = !$('demo').value;
  }
}
$('demo').onchange = () => selectScene($('demo').value);
$('scenePicker').onchange = () => selectScene($('scenePicker').value);
$('reloadScene').onclick = () =>
  selectScene($('scenePicker').value || viewerSettings.defaultSceneId);
$('navigation').onchange = () => {
  if ($('navigation').value === 'orbit') {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    controls.target.copy(camera.position).addScaledVector(dir, 2);
    controls.update();
  }
  setNavigation($('navigation').value);
};
$('loadDemo').onclick = () => selectScene($('demo').value);
$('loadTileManifest').onclick = () => {
  try {
    const url = new URL($('tileManifest').value.trim(), location.href);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Cần URL HTTP/HTTPS.');
    let custom = sceneCatalog.find((item) => item.id === 'custom-tiles');
    if (!custom) {
      custom = { id: 'custom-tiles', type: 'sequence', name: 'Chuỗi tile từ URL', autoplay: true };
      sceneCatalog.push(custom);
    }
    custom.sequence = { format: 'tiles', manifestUrl: url.href };
    populateSceneSelectors();
    selectScene(custom.id);
  } catch (error) {
    status(error.message, true);
  }
};
$('loadUrl').onclick = () => {
  const url = $('url').value.trim();
  if (!url) {
    status('Nhập URL dữ liệu trước.');
    return;
  }
  try {
    const parsed = new URL(url, location.href);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL cần dùng HTTP/HTTPS');
    load({
      url: parsed.href,
      name: decodeURIComponent(parsed.pathname.split('/').pop()) || 'Remote scene',
      mode: $('mode').value,
    });
  } catch (e) {
    status(e.message, true);
  }
};
$('files').onchange = async (event) => {
  for (const file of event.target.files) await load({ file, name: file.name });
  event.target.value = '';
};
function bindSlider(id, out, apply, format = (v) => v.toFixed(2)) {
  const input = $(id);
  input.oninput = () => {
    const v = Number(input.value);
    $(out).textContent = format(v);
    apply(v);
  };
}
bindSlider(
  'budget',
  'budgetOut',
  (v) => (spark.lodSplatScale = v),
  (v) => v.toFixed(2) + '×',
);
function foveate() {
  const on = $('foveation').checked;
  spark.coneFov0 = Number($('cone').value);
  spark.coneFov = Math.min(180, spark.coneFov0 + 50);
  spark.coneFoveate = on ? 0.4 : 1;
  spark.behindFoveate = on ? Number($('behind').value) : 1;
}
bindSlider('cone', 'coneOut', foveate, (v) => v + '°');
bindSlider('behind', 'behindOut', foveate);
$('foveation').onchange = foveate;
$('fetch').onchange = () => (spark.enableLodFetching = $('fetch').checked);
bindSlider(
  'pixel',
  'pixelOut',
  (v) => {
    renderer.setPixelRatio(v);
    resize();
  },
  (v) => v.toFixed(2) + '×',
);
bindSlider(
  'std',
  'stdOut',
  (v) => (spark.maxStdDev = v),
  (v) => v.toFixed(2) + 'σ',
);
bindSlider(
  'speed',
  'speedOut',
  () => {},
  (v) => v.toFixed(1),
);
$('background').oninput = () => scene.background.set($('background').value);
$('home').onclick = () => {
  camera.position.copy(homePosition);
  controls.target.copy(homeTarget);
  if (navigation === 'fly') camera.quaternion.copy(homeQuaternion);
  else controls.update();
};
$('orbit').onclick = () => {
  setNavigation('orbit');
  controls.autoRotate = !controls.autoRotate;
  $('orbit').classList.toggle('active', controls.autoRotate);
};
$('full').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('workspace').requestFullscreen();
  } catch (e) {
    status('Không bật được toàn màn hình: ' + e.message, true);
  }
};
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('guide').open) return;
  if (e.code === 'Space' && e.target === renderer.domElement) {
    e.preventDefault();
    sequence.togglePlayback();
  }
  if ('wasdqe'.includes(e.key.toLowerCase())) keys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
function move(delta) {
  if (!keys.size) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
  const step = Number($('speed').value) * delta;
  const offset = new THREE.Vector3();
  if (keys.has('w')) offset.addScaledVector(dir, step);
  if (keys.has('s')) offset.addScaledVector(dir, -step);
  if (keys.has('a')) offset.addScaledVector(right, -step);
  if (keys.has('d')) offset.addScaledVector(right, step);
  if (keys.has('q')) offset.y -= step;
  if (keys.has('e')) offset.y += step;
  camera.position.add(offset);
  controls.target.add(offset);
}
function resize() {
  const w = viewport.clientWidth,
    h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  renderer.setAnimationLoop(null);
  status('WebGL context bị mất. Hãy tải lại trang và giảm ngân sách/độ phân giải.', true);
});
const sequence = initSequence({
  THREE,
  SplatMesh,
  scene,
  fitMesh,
  setNavigation,
  loadTileFrame: createTileLoader({
    THREE,
    SplatMesh,
    concurrency: () => $('tileConcurrency').value,
  }),
  onOpen: activateSequence,
  onState: renderSequenceState,
});
$('seqResolution').addEventListener('change', () => updateSceneUrl($('seqResolution').value));
const samples = [];
let last = performance.now(),
  period = last,
  frames = 0;
const fmt = (n) =>
  Number.isFinite(n)
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : '—';
renderer.setAnimationLoop(() => {
  const now = performance.now(),
    delta = Math.min((now - last) / 1000, 0.1);
  last = now;
  sequence.tick(now);
  if (navigation === 'fly') {
    flyControls.fpsMovement.enable =
      !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName) &&
      !$('guide').open;
    flyControls.update(camera);
  } else {
    move(delta);
    controls.update(delta);
  }
  renderer.render(scene, camera);
  frames++;
  if (now - period >= 1000) {
    const fps = (frames * 1000) / (now - period),
      frameMs = (now - period) / frames;
    const pager = spark.pager;
    const used = pager ? pager.pageToSplatsChunk.filter(Boolean).length : 0;
    const active = spark.activeSplats;
    const workers = pager?.fetchers.length || 0;
    const target = (spark.lodSplatCount ?? 0) * spark.lodSplatScale;
    $('fps').textContent = fps.toFixed(0);
    $('splats').textContent = fmt(active);
    $('pages').textContent = pager ? used + ' / ' + pager.maxPages : '—';
    $('frametime').textContent = frameMs.toFixed(1) + ' ms';
    $('workers').textContent = workers;
    $('target').textContent = target ? fmt(target) : 'Tự động';
    samples.push({
      ...sequence.metrics(),
      seconds: Math.round(now / 1000),
      fps: +fps.toFixed(2),
      frame_ms: +frameMs.toFixed(2),
      active_splats: active,
      pages: used,
      page_capacity: pager?.maxPages || 0,
      fetch_workers: workers,
      budget_scale: spark.lodSplatScale,
      pixel_ratio: renderer.getPixelRatio(),
    });
    if (samples.length > 3600) samples.shift();
    period = now;
    frames = 0;
  }
});
$('csv').onclick = () => {
  if (!samples.length) {
    status('Chưa có số đo.');
    return;
  }
  const fields = Object.keys(samples[0]);
  const csv = [fields.join(','), ...samples.map((s) => fields.map((k) => s[k]).join(','))].join(
    '\n',
  );
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'splat-lab-metrics.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('unhandledrejection', (event) =>
  status('Tác vụ nền gặp lỗi: ' + (event.reason?.message || String(event.reason)), true),
);
status('Chọn cảnh trong bảng Công cụ.');

// A publisher can generate this small index from the actual filenames once.
// Directory listing and uploads are never required from viewers.
async function start() {
  try {
    const response = await fetch(viewerSettings.datasetIndexUrl, { cache: 'no-cache' });
    if (response.ok) {
      const index = await response.json();
      for (const entry of sceneCatalog.filter((item) => item.type === 'sequence')) {
        const config = index.sequences?.[entry.sequence.format];
        if (config) entry.sequence = { ...entry.sequence, ...config };
      }
    }
  } catch (error) {
    console.warn('Không đọc được danh sách dữ liệu; dùng scenes.js.', error);
  }
  populateSceneSelectors();
  const requestedScene = new URLSearchParams(location.search);
  const initialScene = sceneCatalog.some((item) => item.id === requestedScene.get('scene'))
    ? requestedScene.get('scene')
    : viewerSettings.defaultSceneId;
  await selectScene(initialScene, { startup: true, resolution: requestedScene.get('res') });
}
start().catch((error) => status('Không mở được scene: ' + error.message, true));
