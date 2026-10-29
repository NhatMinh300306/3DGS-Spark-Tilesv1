/** Explicit HTTP tile manifests; layer identifiers are resolution choices. */
export function buildTileGroups(manifest, manifestUrl) {
  if (manifest?.schema !== 'splat-lab-tiles-v1' || manifest.coordinateSpace !== 'world') {
    throw new Error(
      'Manifest tile không hợp lệ. Chạy py configure_tiles.py; các tile cần chung hệ tọa độ.',
    );
  }
  if (!Array.isArray(manifest.layers) || !manifest.layers.length) {
    throw new Error('Manifest chưa có layer/resolution.');
  }
  const base = new URL('./', manifestUrl);
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Manifest cần URL HTTP/HTTPS.');
  const groups = Object.create(null);
  for (const layer of manifest.layers) {
    if (!/^layer_\d+$/i.test(layer.id) || groups[layer.id])
      throw new Error('Layer trùng hoặc không hợp lệ.');
    if (!Array.isArray(layer.frames) || !layer.frames.length)
      throw new Error(`${layer.id}: thiếu frame.`);
    const ids = new Set();
    groups[layer.id] = layer.frames
      .map((frame) => {
        if (
          !Number.isSafeInteger(frame.id) ||
          frame.id < 0 ||
          ids.has(frame.id) ||
          !Array.isArray(frame.tiles)
        ) {
          throw new Error(`${layer.id}: frame trùng hoặc không hợp lệ.`);
        }
        ids.add(frame.id);
        if (!frame.tiles.length && !(frame.emptyTiles > 0))
          throw new Error(`frame_${frame.id}: chưa có tile.`);
        const paths = new Set();
        const tiles = frame.tiles.map((tile) => {
          const path = tile.path;
          if (
            typeof path !== 'string' ||
            path.includes('\\') ||
            path.includes(':') ||
            path.startsWith('/') ||
            path.split('/').some((part) => !part || part === '.' || part === '..') ||
            !path.toLowerCase().endsWith('.ply') ||
            paths.has(path) ||
            !Number.isSafeInteger(tile.splats) ||
            tile.splats <= 0 ||
            !Number.isSafeInteger(tile.bytes) ||
            tile.bytes <= 0
          ) {
            throw new Error(`${layer.id}/frame_${frame.id}: thông tin tile không hợp lệ.`);
          }
          paths.add(path);
          return {
            ...tile,
            name: path.split('/').pop(),
            url: new URL(path.split('/').map(encodeURIComponent).join('/'), base).href,
          };
        });
        return {
          name: `frame_${frame.id}`,
          format: 'tiles',
          tiles,
          emptyTiles: frame.emptyTiles || 0,
          totalBytes: tiles.reduce((n, tile) => n + tile.bytes, 0),
          totalSplats: tiles.reduce((n, tile) => n + tile.splats, 0),
        };
      })
      .sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)));
  }
  const reference = Object.values(groups)[0]
    .map((f) => f.name)
    .join(',');
  for (const frames of Object.values(groups)) {
    if (frames.map((f) => f.name).join(',') !== reference) {
      throw new Error('Các layer/resolution phải có cùng danh sách frame.');
    }
  }
  return groups;
}

/**
 * One THREE.Group per temporal frame, one Spark SplatMesh per nonempty PLY tile.
 * Fetch slots also bound the number of pending byte buffers. Decodes are serial
 * across loads to avoid flooding Spark workers during resolution/scene changes.
 */
export function createTileLoader({
  THREE,
  SplatMesh,
  fetcher = (...args) => fetch(...args),
  concurrency = () => 3,
}) {
  let decodeTail = Promise.resolve();
  return async function loadTileFrame(entry, { signal, wanted, onProgress = () => {} }) {
    const group = new THREE.Group();
    group.name = entry.name;
    group.visible = false;
    group.tileCount = entry.tiles.length;
    group.emptyTiles = entry.emptyTiles;
    group.sourceBytes = entry.totalBytes;
    group.tileSplats = entry.totalSplats;
    const bounds = new THREE.Box3();
    group.getBoundingBox = () => bounds;
    let disposed = false;
    group.dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const mesh of [...group.children]) {
        group.remove(mesh);
        mesh.dispose();
      }
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    // A seek can supersede this frame without changing the whole sequence.
    const watcher = setInterval(() => {
      if (!wanted()) abort();
    }, 25);
    let next = 0,
      completed = 0,
      fetchedBytes = 0,
      firstError = null;
    const active = () => {
      if (signal.aborted || controller.signal.aborted || !wanted()) {
        throw new Error('Đã hủy tải nhóm tile.');
      }
    };
    const report = () =>
      onProgress({
        frame: entry.name,
        loaded: completed,
        total: entry.tiles.length,
        bytes: fetchedBytes,
        totalBytes: entry.totalBytes,
      });
    async function worker() {
      while (next < entry.tiles.length) {
        active();
        const tile = entry.tiles[next++];
        let mesh;
        try {
          const response = await fetcher(tile.url, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status} — ${tile.url}`);
          let bytes = await response.arrayBuffer();
          active();
          if (bytes.byteLength !== tile.bytes)
            throw new Error(
              'Kích thước tile đã thay đổi; chạy lại configure_tiles.py và tải lại cảnh.',
            );
          fetchedBytes += bytes.byteLength;
          report();
          const decoding = decodeTail.then(async () => {
            active();
            mesh = new SplatMesh({ fileBytes: bytes, fileName: tile.name, lod: false });
            bytes = null;
            await mesh.initialized;
            active();
            if (mesh.numSplats !== tile.splats)
              throw new Error('Số Gaussian khác manifest; chạy lại configure_tiles.py.');
            // Preserve world coordinates; never recenter individual tiles.
            bounds.union(mesh.getBoundingBox());
            group.add(mesh);
            mesh = null; // The group now owns disposal.
            completed += 1;
            report();
          });
          decodeTail = decoding.catch(() => {});
          await decoding;
        } catch (error) {
          if (mesh) mesh.dispose();
          if (!firstError) firstError = new Error(`${entry.name}/${tile.name}: ${error.message}`);
          controller.abort();
          throw firstError;
        }
      }
    }
    try {
      active();
      report();
      const slots = Math.max(1, Math.min(6, Math.floor(Number(concurrency()) || 3)));
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(slots, entry.tiles.length) }, worker),
      );
      if (firstError) throw firstError;
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      active();
      return group;
    } catch (error) {
      group.dispose();
      throw error;
    } finally {
      clearInterval(watcher);
      signal.removeEventListener('abort', abort);
    }
  };
}
