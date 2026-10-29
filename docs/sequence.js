/** Natural ordering for PLY sequences selected from disk. No files are uploaded. */
export function groupFiles(files, fallback = 'res8') {
  const groups = {};
  for (const file of files) {
    if (!/\.ply$/i.test(file.name)) continue;
    const path = file.webkitRelativePath || file.name;
    if (/(?:^|\/)layer_\d+\/frame_\d+\/voxels_new\//i.test(path)) {
      throw new Error(
        'Đây là dữ liệu tile. Chạy configure_tiles.py rồi chọn Redandblack · PLY tiles.',
      );
    }
    const match = path.match(/(?:^|\/)res(1|2|4|8)(?:\/|$)/i);
    const resolution = match ? `res${match[1]}` : fallback;
    (groups[resolution] ??= []).push({ name: file.name, file });
  }
  for (const frames of Object.values(groups)) {
    frames.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (new Set(frames.map((frame) => frame.name)).size !== frames.length) {
      throw new Error('Tên frame trùng trong cùng resolution. Chọn một bộ dữ liệu.');
    }
  }
  return groups;
}

/** Resolve the catalogue's explicit names or its numbered file pattern. */
export function buildRemoteGroups(config, pageUrl) {
  const { firstFrame, lastFrame, padding = 6, resolutions } = config;
  const format = config.format || 'ply';
  if (!['rad', 'ply'].includes(format)) throw new Error('Định dạng phải là RAD hoặc PLY.');
  const listed = config.framesByResolution;
  if (
    !listed &&
    (!Number.isInteger(firstFrame) ||
      !Number.isInteger(lastFrame) ||
      firstFrame < 0 ||
      lastFrame < firstFrame ||
      lastFrame - firstFrame > 9999)
  )
    throw new Error('Khoảng frame không hợp lệ.');
  const keys = listed ? Object.keys(listed) : resolutions;
  if (!keys?.length || !keys.every((res) => /^[a-zA-Z0-9_-]+$/.test(res))) {
    throw new Error('Danh sách resolution không hợp lệ.');
  }
  const base = new URL(config.baseUrl.replace(/\/?$/, '/'), pageUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Cần URL HTTP/HTTPS.');
  const pattern = config.filePattern || (format === 'rad' ? '{frame}-lod.rad' : '{frame}.ply');
  if (!listed && !pattern.includes('{frame}')) throw new Error('Mẫu tên file phải có {frame}.');
  const result = Object.fromEntries(
    keys.map((resolution) => {
      const names = listed
        ? listed[resolution]
        : Array.from({ length: lastFrame - firstFrame + 1 }, (_, offset) =>
            pattern.replaceAll('{frame}', String(firstFrame + offset).padStart(padding, '0')),
          );
      if (
        !Array.isArray(names) ||
        !names.length ||
        names.length > 10000 ||
        new Set(names).size !== names.length
      )
        throw new Error('Danh sách frame không hợp lệ.');
      return [
        resolution,
        names.map((name) => {
          if (
            typeof name !== 'string' ||
            /[\/\\]/.test(name) ||
            !name.toLowerCase().endsWith('.' + format)
          ) {
            throw new Error('Tên frame phải là tên file .' + format + ', không chứa đường dẫn.');
          }
          return {
            name,
            format,
            url: new URL(`${resolution}/${encodeURIComponent(name)}`, base).href,
          };
        }),
      ];
    }),
  );
  // Changing resolution must keep the same temporal frame, not just a numeric index.
  const reference = result[keys[0]].map((entry) => entry.name).join('\n');
  if (keys.some((key) => result[key].map((entry) => entry.name).join('\n') !== reference)) {
    throw new Error('Các resolution phải có cùng danh sách tên frame.');
  }
  return result;
}

/**
 * Spark 2.3.1 paged meshes initialize before any chunk is resident. Keep a warm
 * frame in the LoD traversal with zero opacity, then wait for selected indices.
 * This is readiness to display a coarse LoD, NOT completion of every chunk or a
 * GPU-present fence. At most the bounded temporal window participates in LoD.
 */
export async function prepareRadFrame(mesh, { root, signal, wanted, timeoutMs = 45000 }) {
  const started = performance.now();
  const assertActive = () => {
    if (signal.aborted || !wanted()) throw new Error('Frame đã bị hủy.');
    if (performance.now() - started > timeoutMs) {
      throw new Error(
        'RAD chưa có splat sau 45 giây. Kiểm tra RADC, HTTP Range/CORS và bật tải chunk.',
      );
    }
  };
  // A failed/stalled header must not prevent changing scene or resolution.
  const cancellable = (promise) =>
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          assertActive();
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, 25);
      Promise.resolve(promise).then(
        (value) => {
          clearInterval(timer);
          resolve(value);
        },
        (error) => {
          clearInterval(timer);
          reject(error);
        },
      );
    });
  assertActive();
  await cancellable(mesh.initialized);
  const { meta } = await cancellable(mesh.paged.getRadMeta());
  if (!meta.lodTree || !meta.chunks?.length || !meta.count) {
    throw new Error('RAD không có cây LoD hợp lệ; hãy tạo lại bằng build-lod.');
  }
  assertActive();
  mesh.opacity = 0;
  mesh.visible = true;
  root.add(mesh);
  await cancellable(
    new Promise((resolve) => {
      const poll = () => {
        if (signal.aborted || !wanted() || performance.now() - started > timeoutMs)
          return resolve();
        if (mesh.paged.numSplats > 0) return resolve();
        setTimeout(poll, 16);
      };
      poll();
    }),
  );
  assertActive();
}

/**
 * One opaque temporal frame; a bounded warm-frame window; serial preparation.
 * Playback stalls on a missing frame. Content FPS measures mesh changes, not GPU
 * presentation. PLY frames do not build a spatial LoD tree during playback.
 */
export function initSequence({
  THREE,
  SplatMesh,
  scene,
  fitMesh,
  setNavigation,
  preparePagedFrame = prepareRadFrame,
  loadTileFrame,
  onOpen = () => {},
  onState = () => {},
}) {
  const $ = (id) => document.getElementById(id);
  const root = new THREE.Group();
  scene.add(root);

  let groups = {};
  let resolution = '';
  let index = 0;
  let requestedIndex = 0;
  let current = null;
  let playing = false;
  let switching = false;
  let generation = 0;
  let requestId = 0;
  let needsFit = true;
  let lastStep = 0;
  let lastUiUpdate = 0;
  let error = '';
  let sourceName = '';
  let sourceId = '';
  let format = 'ply';
  let lastPreparationMs = 0;
  let tileProgress = null;
  let contentFps = 0;
  let changes = 0;
  let sampleStart = performance.now();
  let controller = new AbortController();
  let serial = Promise.resolve();
  const cache = new Map();
  const pending = new Map();

  const frames = () => groups[resolution] || [];
  const capacity = () => Math.max(2, Math.min(10, Number($('seqBuffer').value) || 4));
  const targetFps = () => Math.max(1, Math.min(60, Number($('seqFPS').value) || 30));
  const disposed = new WeakSet();
  const dispose = (mesh) => {
    if (disposed.has(mesh)) return;
    disposed.add(mesh);
    root.remove(mesh);
    mesh.dispose();
  };

  function state() {
    return {
      sourceId,
      sourceName,
      format,
      lastPreparationMs,
      resolution,
      resolutions: Object.keys(groups),
      index,
      frameName: current ? frames()[index]?.name : '',
      frameCount: frames().length,
      playing,
      switching,
      ready: Boolean(current),
      visible: root.visible,
      buffered: cache.size,
      capacity: capacity(),
      contentFps,
      error,
      tileProgress,
      tileCount: current?.tileCount || 0,
      emptyTiles: current?.emptyTiles || 0,
    };
  }

  function emit() {
    $('seqPlay').textContent = playing ? '❚❚ Tạm dừng' : '▶ Phát';
    $('seqFrame').textContent = current
      ? `${index + 1}/${frames().length} · ${frames()[index].name}`
      : frames().length
        ? `${frames().length} frame · đang chờ`
        : 'Chưa có chuỗi';
    $('seqStats').textContent =
      `Buffer ${cache.size}/${capacity()} · nội dung ${contentFps.toFixed(1)} fps · chuẩn bị ${lastPreparationMs.toFixed(0)} ms`;
    $('tileStats').hidden = format !== 'tiles' || !root.visible;
    if (format === 'tiles') {
      const shown = current
        ? `Đang xem: ${current.tileCount} tile · bỏ qua ${current.emptyTiles} tile rỗng.`
        : 'Chưa có frame hoàn chỉnh.';
      $('tileStats').textContent =
        shown +
        (tileProgress
          ? ` Chuẩn bị ${tileProgress.frame}: ${tileProgress.loaded}/${tileProgress.total} tile · ${(tileProgress.bytes / 1048576).toFixed(2)} MiB đã tải.`
          : '');
    }
    onState(state());
  }

  function pause() {
    playing = false;
    contentFps = 0;
    emit();
  }

  function reset(keepPlaying = false) {
    controller.abort();
    controller = new AbortController();
    generation += 1;
    requestId += 1;
    for (const mesh of cache.values()) dispose(mesh);
    cache.clear();
    pending.clear();
    serial = Promise.resolve();
    current = null;
    switching = false;
    playing = keepPlaying;
    needsFit = true;
    error = '';
    tileProgress = null;
    changes = 0;
    contentFps = 0;
    sampleStart = performance.now();
  }

  function desiredFrames() {
    const count = frames().length;
    const wanted = new Set();
    for (let offset = 0; offset < Math.min(capacity(), count); offset += 1) {
      const next = requestedIndex + offset;
      if (next >= count && !$('seqLoop').checked) break;
      wanted.add(next % count);
    }
    return wanted;
  }

  function trim() {
    const wanted = desiredFrames();
    for (const [frameIndex, mesh] of cache) {
      if (!wanted.has(frameIndex) && mesh !== current) {
        dispose(mesh);
        cache.delete(frameIndex);
      }
    }
    // During a seek, retain the displayed frame until its replacement is ready.
    for (const [frameIndex, mesh] of [...cache].reverse()) {
      if (cache.size <= capacity()) break;
      if (mesh !== current && frameIndex !== requestedIndex) {
        dispose(mesh);
        cache.delete(frameIndex);
      }
    }
  }

  function ensureFrame(frameIndex) {
    const cached = cache.get(frameIndex);
    if (cached && (!cached.paged || cached.paged.numSplats > 0)) {
      return Promise.resolve(cached);
    }
    if (pending.has(frameIndex)) return pending.get(frameIndex);
    const entry = frames()[frameIndex];
    const session = generation;
    const signal = controller.signal;
    if (!entry) return Promise.reject(new Error('Không có frame này.'));

    const job = serial.then(async () => {
      if (session !== generation || !desiredFrames().has(frameIndex)) return null;
      const started = performance.now();
      let mesh = cache.get(frameIndex);
      try {
        const isRad = entry.format === 'rad';
        if (entry.format === 'tiles') {
          if (!loadTileFrame) throw new Error('Bộ đọc tile chưa được khởi tạo.');
          mesh = await loadTileFrame(entry, {
            signal,
            wanted: () => session === generation && desiredFrames().has(frameIndex),
            onProgress: (progress) => {
              if (session === generation) tileProgress = progress;
            },
          });
          root.add(mesh);
        } else if (isRad) {
          // The URL is essential: Spark resolves each RADC against this header URL.
          mesh ??= new SplatMesh({ url: entry.url, paged: true, lodScale: 1 });
          await preparePagedFrame(mesh, {
            root,
            signal,
            wanted: () => session === generation && desiredFrames().has(frameIndex),
          });
        } else {
          let bytes;
          if (entry.file) {
            bytes = await entry.file.arrayBuffer();
          } else {
            const response = await fetch(entry.url, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status} — ${entry.url}`);
            bytes = await response.arrayBuffer();
          }
          if (session !== generation || !desiredFrames().has(frameIndex)) return null;
          mesh = new SplatMesh({ fileBytes: bytes, fileName: entry.name, lod: false });
          await mesh.initialized;
          mesh.visible = false;
          root.add(mesh);
        }
        if (session !== generation || !desiredFrames().has(frameIndex)) {
          dispose(mesh);
          return null;
        }
        lastPreparationMs = performance.now() - started;
        cache.set(frameIndex, mesh);
        trim();
        return cache.get(frameIndex) || null;
      } catch (cause) {
        if (mesh) dispose(mesh);
        if (session === generation && cache.get(frameIndex) === mesh) cache.delete(frameIndex);
        if (session !== generation || signal.aborted || !desiredFrames().has(frameIndex))
          return null;
        throw new Error(`${entry.name}: ${cause.message}`);
      }
    });
    pending.set(frameIndex, job);
    serial = job.catch(() => {});
    const removePending = () => {
      if (session === generation) pending.delete(frameIndex);
    };
    job.then(removePending, removePending);
    return job;
  }

  function prefetch() {
    trim();
    for (const frameIndex of desiredFrames()) {
      // A prefetch failure is reported if that frame becomes the playback target.
      ensureFrame(frameIndex).catch(() => {});
    }
  }

  async function showFrame(frameIndex) {
    const session = generation;
    const ticket = ++requestId;
    requestedIndex = frameIndex;
    switching = true;
    error = '';
    $('seqStatus').textContent = `Đang chuẩn bị ${frames()[frameIndex]?.name}…`;
    trim();
    emit();
    try {
      const mesh = await ensureFrame(frameIndex);
      if (session !== generation || ticket !== requestId || !mesh) return false;
      if (current) {
        if (current.paged) current.opacity = 0;
        else current.visible = false;
      }
      current = mesh;
      current.visible = true;
      current.opacity = 1;
      index = frameIndex;
      root.rotation.x = THREE.MathUtils.degToRad(Number($('seqRotation').value) || 0);
      if (needsFit) {
        setNavigation('orbit');
        needsFit = fitMesh(mesh) === false;
      }
      $('seqSeek').value = index;
      const now = performance.now();
      lastStep = playing ? Math.max(lastStep + 1000 / targetFps(), now - 1000 / targetFps()) : now;
      changes += 1;
      $('seqStatus').textContent =
        `${format.toUpperCase()} · ${resolution} · ${frames().length} frame${format === 'rad' ? ' · chi tiết tải theo góc nhìn' : ' · sẵn sàng'}`;
      prefetch();
      return true;
    } catch (cause) {
      if (session === generation && ticket === requestId) {
        error = cause.message;
        playing = false;
        $('seqStatus').textContent = `Lỗi: ${error} — nhấn Phát để thử lại.`;
      }
      return false;
    } finally {
      if (session === generation && ticket === requestId) {
        switching = false;
        emit();
      }
    }
  }

  function updateResolutionOptions() {
    $('seqResolution').replaceChildren();
    for (const key of Object.keys(groups).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = `${key}${format === 'tiles' ? ' (resolution)' : ''} · ${groups[key].length} frame`;
      $('seqResolution').append(option);
    }
    $('seqResolution').value = resolution;
    $('seqSeek').max = Math.max(0, frames().length - 1);
  }

  function selectResolution(value) {
    if (!groups[value]?.length) return Promise.resolve(false);
    const frameName = frames()[index]?.name;
    const wasPlaying = playing;
    const hadCamera = Boolean(current) && !needsFit;
    reset(wasPlaying);
    resolution = value;
    index = Math.max(
      0,
      frames().findIndex((frame) => frame.name === frameName),
    );
    requestedIndex = index;
    needsFit = !hadCamera;
    updateResolutionOptions();
    return showFrame(index);
  }

  function install(nextGroups, options = {}) {
    if (!Object.keys(nextGroups).length) throw new Error('Không tìm thấy frame.');
    reset(Boolean(options.autoplay));
    groups = nextGroups;
    format = options.format || 'ply';
    sourceId = options.id || '';
    sourceName = options.name || 'Chuỗi PLY của bạn';
    resolution = groups[options.resolution]
      ? options.resolution
      : groups.res8
        ? 'res8'
        : Object.keys(groups)[0];
    index = 0;
    requestedIndex = 0;
    root.visible = true;
    if (options.buffer !== undefined) $('seqBuffer').value = options.buffer;
    if (options.rotationX !== undefined) $('seqRotation').value = options.rotationX;
    if (options.fps !== undefined) $('seqFPS').value = options.fps;
    root.rotation.x = THREE.MathUtils.degToRad(Number($('seqRotation').value) || 0);
    lastStep = performance.now();
    updateResolutionOptions();
    onOpen({ id: sourceId, name: sourceName });
    return showFrame(0);
  }

  function loadRemote(config, options = {}) {
    const next = buildRemoteGroups(config, location.href);
    $('seqBase').value = config.baseUrl;
    $('seqStart').value = config.firstFrame;
    $('seqEnd').value = config.lastFrame;
    $('seqFormat').value = config.format || 'ply';
    $('seqPattern').value = config.filePattern || '{frame}.ply';
    $('seqResList').value = Object.keys(next).join(',');
    return install(next, {
      resolution: config.defaultResolution,
      fps: config.fps,
      buffer: config.buffer,
      format: config.format,
      rotationX: config.rotationX,
      ...options,
    });
  }

  function togglePlayback() {
    if (!frames().length) {
      $('seqStatus').textContent = 'Chọn cảnh Redandblack Tiles/RAD/PLY hoặc mở một chuỗi riêng.';
      return;
    }
    if (playing) {
      pause();
      return;
    }
    if (!root.visible) {
      root.visible = true;
      onOpen({ id: sourceId, name: sourceName });
    }
    playing = true;
    lastStep = performance.now();
    sampleStart = lastStep;
    changes = 0;
    if (!current || error) showFrame(requestedIndex);
    else prefetch();
    emit();
  }

  function clear() {
    reset();
    groups = {};
    resolution = '';
    sourceId = '';
    sourceName = '';
    index = 0;
    requestedIndex = 0;
    updateResolutionOptions();
    $('seqSeek').value = 0;
    $('seqStatus').textContent = 'Đã đóng chuỗi.';
    emit();
  }

  $('seqFolder').onchange = (event) => {
    try {
      install(groupFiles([...event.target.files]), { name: 'Chuỗi PLY từ thư mục' });
    } catch (cause) {
      $('seqStatus').textContent = cause.message;
    }
    event.target.value = '';
  };
  $('seqFiles').onchange = (event) => {
    try {
      const added = groupFiles([...event.target.files], $('seqAssign').value);
      if (!Object.keys(added).length) throw new Error('Chưa chọn file PLY.');
      install(
        { ...(format === 'ply' ? groups : {}), ...added },
        { resolution: $('seqAssign').value },
      );
    } catch (cause) {
      $('seqStatus').textContent = cause.message;
    }
    event.target.value = '';
  };
  $('seqRemote').onclick = () => {
    try {
      loadRemote(
        {
          baseUrl: $('seqBase').value,
          firstFrame: Number($('seqStart').value),
          lastFrame: Number($('seqEnd').value),
          resolutions: $('seqResList')
            .value.split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          format: $('seqFormat').value,
          filePattern: $('seqPattern').value.trim(),
          defaultResolution: 'res8',
        },
        { name: `Chuỗi ${$('seqFormat').value.toUpperCase()} từ URL`, autoplay: true },
      );
    } catch (cause) {
      $('seqStatus').textContent = cause.message;
    }
  };
  $('seqFormat').onchange = () => {
    $('seqPattern').value = $('seqFormat').value === 'rad' ? '{frame}-lod.rad' : '{frame}.ply';
  };
  $('seqResolution').onchange = () => selectResolution($('seqResolution').value);
  $('seqPlay').onclick = togglePlayback;
  $('seqSeek').oninput = () => {
    pause();
    if (frames().length) showFrame(Math.min(frames().length - 1, Number($('seqSeek').value)));
  };
  $('seqRotation').onchange = () => {
    root.rotation.x = THREE.MathUtils.degToRad(Number($('seqRotation').value) || 0);
  };
  $('seqFit').onclick = () => {
    if (current) {
      setNavigation('orbit');
      fitMesh(current);
    }
  };
  $('seqBuffer').onchange = () => {
    if (frames().length) prefetch();
  };
  $('seqLoop').onchange = () => {
    if (frames().length) prefetch();
  };
  $('seqClear').onclick = clear;

  function tick(now) {
    if (playing && !switching && current && now - lastStep >= 1000 / targetFps()) {
      let next = index + 1;
      if (next >= frames().length) {
        if (!$('seqLoop').checked) {
          pause();
          return;
        }
        next = 0;
      }
      showFrame(next);
    }
    if (now - sampleStart >= 1000) {
      contentFps = playing ? (changes * 1000) / (now - sampleStart) : 0;
      changes = 0;
      sampleStart = now;
    }
    if (now - lastUiUpdate >= 250) {
      emit();
      lastUiUpdate = now;
    }
  }

  return {
    tick,
    pause,
    clear,
    loadRemote,
    loadGroups: install,
    selectResolution,
    togglePlayback,
    state,
    deactivate() {
      reset();
      root.visible = false;
      emit();
    },
    metrics() {
      return {
        content_fps: contentFps,
        sequence_format: format,
        preparation_ms: +lastPreparationMs.toFixed(2),
        sequence_resolution: resolution,
        sequence_frame: index,
        buffered_frames: cache.size,
        tiles_in_frame: current?.tileCount || 0,
        tile_load_frame: tileProgress?.frame || '',
        tile_ready: tileProgress?.loaded || 0,
        tile_total: tileProgress?.total || 0,
        tile_fetched_bytes: tileProgress?.bytes || 0,
      };
    },
  };
}
