// Zip Bundle service worker.
// Serves requests for <scope>/<name>.zip/<path> out of the zip archive <scope>/<name>.zip,
// reading only the needed bytes with HTTP range requests.
'use strict';

const TAIL_SIZE = 22 + 0xffff + 20;  // EOCD + longest comment + ZIP64 locator
const SMALL_ENTRY = 2 << 20;         // entries up to this size are fetched whole (and coalesced)
const CACHE_ENTRY_MAX = 64 << 20;    // larger entries are streamed but not cached
const COALESCE_SPAN = 8 << 20;       // max size of one merged range request
const COALESCE_GAP = 64 << 10;       // max unused bytes between merged entries
const COALESCE_DELAY = 4;            // ms to collect concurrent requests before fetching
const CACHE_PREFIX = 'zipbundle:';
const OPFS_DIR = 'zipbundle';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const target = splitUrl(req.url);
  if (!target) return;
  e.respondWith(handle(req, target, e).catch(err => {
    console.error('[zip-bundle]', err);
    return textResponse(500, `Zip bundle error: ${err.message}`);
  }));
});

self.addEventListener('message', e => {
  const port = e.ports[0];
  const { type, zip } = e.data || {};
  e.waitUntil((async () => {
    try {
      if (!port) return;
      if (type === 'reset') {
        await resetAll();
        port.postMessage({ ok: true, result: null });
        return;
      }
      const target = splitUrl(zip + '/');
      if (!target) throw new Error(`Not a zip inside the service worker scope: ${zip}`);
      let mount;
      if (type === 'mount') mount = await getMount(target.zipUrl, true);
      else if (type === 'prefix-ready') mount = await attachPrefix(target.zipUrl);
      else throw new Error(`Unknown message: ${type}`);
      port.postMessage({ ok: true, result: summary(mount) });
    } catch (err) {
      console.error('[zip-bundle]', err);
      port.postMessage({ ok: false, error: err.message });
    }
  })());
});

// ---------------------------------------------------------------- requests

// "https://host/dir/app.zip/a/b.js?x" -> { zipUrl: "https://host/dir/app.zip", path: "a/b.js" }
function splitUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== self.location.origin) return null;
  const m = /^(.+?\.zip)\/(.*)$/i.exec(u.pathname);
  if (!m) return null;
  const zipUrl = u.origin + m[1];
  if (!zipUrl.startsWith(self.registration.scope)) return null;
  return { zipUrl, rawPath: m[2], url: u };
}

async function handle(req, target, event) {
  let path;
  try { path = target.rawPath.split('/').map(decodeURIComponent).join('/').normalize('NFC'); }
  catch { return textResponse(400, 'Bad URL encoding'); }

  for (let attempt = 0; ; attempt++) {
    const mount = await getMount(target.zipUrl);
    if (!mount.entries) {
      return textResponse(503, 'The archive is not downloaded yet. Open the launcher page first.');
    }
    try {
      return await route(req, mount, path, target.url, event);
    } catch (err) {
      // The archive changed on the server: re-read its index and try again once.
      if (!(err instanceof StaleError) || attempt > 0) throw err;
      await getMount(target.zipUrl, true);
    }
  }
}

async function route(req, mount, path, url, event) {
  let entry = mount.entries.get(path);
  if (!entry && (path === '' || path.endsWith('/'))) {
    entry = mount.entries.get(path + 'index.html');
    if (!entry && path === '' && mount.entryName) {
      return Response.redirect(entryUrl(mount, mount.entryName), 302);
    }
  }
  if (!entry) {
    if (path !== '' && !path.endsWith('/') && mount.dirs.has(path)) {
      return Response.redirect(url.origin + url.pathname + '/' + url.search, 301);
    }
    return textResponse(404, `Not found in archive: ${path}`);
  }
  return serve(req, mount, entry, event);
}

async function serve(req, mount, entry, event) {
  const headers = new Headers(mount.config.headers || {});
  headers.set('Content-Type', mimeType(entry.name));
  const total = entry.usize;
  const head = req.method === 'HEAD';

  if (entry.method !== 0 && entry.method !== 8) {
    return textResponse(501, `Unsupported compression method ${entry.method}: ${entry.name}`);
  }
  const kind = mount.rewriter && REWRITE_KINDS[extension(entry.name)];
  if (kind) return serveRewritten(req, mount, entry, event, headers, kind);

  if (entry.method === 0) {
    headers.set('Accept-Ranges', 'bytes');
    const range = parseRange(req.headers.get('Range'), total);
    if (range === false) {
      headers.set('Content-Range', `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const [start, end] = range;
      headers.set('Content-Range', `bytes ${start}-${end - 1}/${total}`);
      headers.set('Content-Length', String(end - start));
      const body = head ? null : await readRange(mount, entry, start, end, event);
      return new Response(body, { status: 206, headers });
    }
  }

  headers.set('Content-Length', String(total));
  const body = head ? null : await readWhole(mount, entry, event);
  return new Response(body, { status: 200, headers });
}

// Text files are served whole after rewriting (no ranges: their length changes).
async function serveRewritten(req, mount, entry, event, headers, kind) {
  let body = new Uint8Array(await new Response(await readWhole(mount, entry, event)).arrayBuffer());
  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    // not UTF-8: served unchanged
  }
  if (text !== null) {
    const out = rewriteText(mount.rewriter, kind, text);
    if (out !== text) body = new TextEncoder().encode(out);
  }
  headers.set('Content-Length', String(body.length));
  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
}

// Returns [start, endExclusive], null for "no usable range" (serve whole), false for unsatisfiable.
function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;  // multi-range etc.: ignore, serve 200
  let start, end;
  if (m[1] === '') {
    start = Math.max(0, total - Number(m[2]));
    end = total;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total : Math.min(total, Number(m[2]) + 1);
  }
  if (start >= total || start >= end) return total === 0 && start === 0 ? null : false;
  return [start, end];
}

function textResponse(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function entryUrl(mount, name) {
  return mount.zipUrl + '/' + name.split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------- reading entries

async function readWhole(mount, entry, event) {
  if (inPrefix(mount, entry)) {
    const start = await dataStart(mount, entry);
    const raw = mount.prefix.slice(start, start + entry.csize);
    return entry.method === 0 ? raw : inflate(raw.stream());
  }

  const cache = await caches.open(mount.cacheName);
  const key = entryKey(mount.zipUrl, entry.name);
  const hit = await cache.match(key);
  if (hit) return hit.body;

  if (entry.csize <= SMALL_ENTRY) return readSmall(mount, entry, cache, key, event);

  const start = await dataStart(mount, entry);
  const res = await fetchRange(mount, start, start + entry.csize);
  const body = entry.method === 0 ? res.body : inflate(res.body);
  if (entry.usize > CACHE_ENTRY_MAX) return body;
  const [toPage, toCache] = body.tee();
  event.waitUntil(cache.put(key, new Response(toCache)).catch(() => {}));
  return toPage;
}

async function readRange(mount, entry, start, end, event) {
  if (inPrefix(mount, entry)) {
    const ds = await dataStart(mount, entry);
    return mount.prefix.slice(ds + start, ds + end);
  }
  const cache = await caches.open(mount.cacheName);
  const key = entryKey(mount.zipUrl, entry.name);
  const hit = await cache.match(key);
  if (hit) return (await hit.blob()).slice(start, end);

  if (entry.csize <= SMALL_ENTRY) {
    const data = await readSmall(mount, entry, cache, key, event);
    return data.slice(start, end);
  }
  const ds = await dataStart(mount, entry);
  return (await fetchRange(mount, ds + start, ds + end)).body;
}

async function readSmall(mount, entry, cache, key, event) {
  let data = await coalescedFetch(mount, entry);
  if (entry.method !== 0) data = new Uint8Array(await new Response(inflate(new Blob([data]).stream())).arrayBuffer());
  event.waitUntil(cache.put(key, new Response(data)).catch(() => {}));
  return data;
}

function inflate(stream) {
  return stream.pipeThrough(new DecompressionStream('deflate-raw'));
}

function inPrefix(mount, entry) {
  return mount.prefix && entry.lho + entry.span <= mount.prefixLen;
}

// Absolute offset of the entry's data (after its local header, whose extra field may differ from
// the central directory's).
async function dataStart(mount, entry) {
  if (entry.dataStart == null) {
    const header = inPrefix(mount, entry)
      ? new Uint8Array(await mount.prefix.slice(entry.lho, entry.lho + 30).arrayBuffer())
      : await fetchBytes(mount, entry.lho, entry.lho + 30);
    entry.dataStart = entry.lho + localHeaderLength(header);
  }
  return entry.dataStart;
}

function localHeaderLength(bytes) {
  const dv = view(bytes);
  if (bytes.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new Error('Corrupt local file header');
  return 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

// Small entries requested at about the same time are fetched with one range request when they
// lie close together in the archive (which they do when files from the same folder are loaded).
const queue = new Map();  // mount -> [{ entry, resolve, reject }]
let queueTimer = 0;

function coalescedFetch(mount, entry) {
  if (entry.pending) return entry.pending;
  const promise = new Promise((resolve, reject) => {
    let list = queue.get(mount);
    if (!list) queue.set(mount, list = []);
    list.push({ entry, resolve, reject });
    if (!queueTimer) queueTimer = setTimeout(flushQueue, COALESCE_DELAY);
  });
  entry.pending = promise;
  const clear = () => { entry.pending = null; };
  promise.then(clear, clear);
  return promise;
}

function flushQueue() {
  queueTimer = 0;
  const batches = [...queue];
  queue.clear();
  for (const [mount, list] of batches) {
    list.sort((a, b) => a.entry.lho - b.entry.lho);
    let group = [], start = 0, end = 0;
    for (const item of list) {
      const s = item.entry.lho, e = s + item.entry.span;
      if (group.length && s - end <= COALESCE_GAP && Math.max(end, e) - start <= COALESCE_SPAN) {
        group.push(item);
        end = Math.max(end, e);
      } else {
        if (group.length) fetchGroup(mount, group, start, end);
        group = [item];
        start = s;
        end = e;
      }
    }
    if (group.length) fetchGroup(mount, group, start, end);
  }
}

async function fetchGroup(mount, group, start, end) {
  let buf;
  try {
    buf = await fetchBytes(mount, start, end);
  } catch (err) {
    for (const item of group) item.reject(err);
    return;
  }
  for (const { entry, resolve, reject } of group) {
    try {
      const off = entry.lho - start;
      const headerLength = localHeaderLength(buf.subarray(off, off + 30));
      entry.dataStart = entry.lho + headerLength;
      const dataOff = off + headerLength;
      if (dataOff + entry.csize <= buf.length) resolve(buf.slice(dataOff, dataOff + entry.csize));
      else resolve(fetchBytes(mount, entry.dataStart, entry.dataStart + entry.csize));
    } catch (err) {
      reject(err);
    }
  }
}

// ---------------------------------------------------------------- network

class StaleError extends Error {
  constructor() { super('The archive changed on the server'); }
}

async function fetchRange(mount, start, end) {
  const headers = { Range: `bytes=${start}-${end - 1}` };
  if (mount.meta.ifRange) headers['If-Range'] = mount.meta.ifRange;
  const res = await fetch(mount.zipUrl, { headers, cache: 'no-store', credentials: 'same-origin' });
  if (res.status === 206) {
    const range = parseContentRange(res.headers.get('Content-Range'));
    if ((!range || range.total === mount.meta.size) && sameValidators(res, mount.meta)) return res;
  } else if (!res.ok) {
    throw new Error(`HTTP ${res.status} while reading ${mount.zipUrl}`);
  }
  // 200 (If-Range mismatch) or a 206 of a different file version.
  res.body?.cancel();
  mount.stale = true;
  throw new StaleError();
}

async function fetchBytes(mount, start, end) {
  const res = await fetchRange(mount, start, end);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== end - start) throw new Error(`Short read from ${mount.zipUrl}`);
  return bytes;
}

function sameValidators(res, meta) {
  const etag = res.headers.get('ETag');
  const lastModified = res.headers.get('Last-Modified');
  return (!etag || !meta.etag || etag === meta.etag) &&
    (!lastModified || !meta.lastModified || lastModified === meta.lastModified);
}

function parseContentRange(value) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) + 1, total: m[3] === '*' ? null : Number(m[3]) };
}

// ---------------------------------------------------------------- mounts

const mounts = new Map();  // zipUrl -> Promise<mount>

// fresh: check the archive on the server (the launcher does this on every start). Otherwise use
// what is in memory or persisted, so service worker restarts cost no requests.
function getMount(zipUrl, fresh = false) {
  const previous = mounts.get(zipUrl);
  if (previous && !fresh) return previous;
  const promise = fresh ? mountFresh(zipUrl, previous) : restoreOrMount(zipUrl);
  mounts.set(zipUrl, promise);
  promise.catch(() => { if (mounts.get(zipUrl) === promise) mounts.delete(zipUrl); });
  return promise;
}

async function restoreOrMount(zipUrl) {
  const meta = await loadMeta(zipUrl);
  return meta ? restore(zipUrl, meta) : mountFresh(zipUrl, null);
}

async function mountFresh(zipUrl, previous) {
  const old = previous && await previous.catch(() => null);
  const stored = await loadMeta(zipUrl);
  let probe;
  try {
    probe = await probeArchive(zipUrl);
  } catch (err) {
    // Offline: keep using what is stored.
    if (old && !old.stale) return old;
    if (stored) return restore(zipUrl, stored);
    throw err;
  }
  if (old && !old.stale && old.meta.version === probe.version) return old;
  if (stored && stored.version === probe.version) return restore(zipUrl, stored);

  await wipe(zipUrl);
  const meta = {
    version: probe.version,
    etag: probe.etag,
    lastModified: probe.lastModified,
    ifRange: probe.etag && !probe.etag.startsWith('W/') ? probe.etag : null,
    size: probe.size,
    rangeless: probe.rangeless,
    storeKey: await storeKey(zipUrl),
    prefixLen: 0,
    cdOffset: 0,
    config: null,
  };
  if (probe.rangeless) {
    // The server ignores Range: the launcher downloads the whole archive and the index is read
    // from that copy.
    await saveMeta(zipUrl, meta);
    return makeMount(zipUrl, meta, null, null);
  }

  const reader = (s, e) => fetchBytes({ zipUrl, meta }, s, e);
  const index = await readIndex(reader, probe.size, probe.tail, probe.tailStart);
  meta.config = index.config;
  meta.cdOffset = index.cdOffset;
  await saveIndex(zipUrl, meta, index.cd);
  return makeMount(zipUrl, meta, index.cd, null);
}

async function probeArchive(zipUrl) {
  const res = await fetch(zipUrl, {
    headers: { Range: `bytes=-${TAIL_SIZE}` }, cache: 'no-store', credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Cannot load ${zipUrl}: HTTP ${res.status}`);
  const etag = res.headers.get('ETag');
  const lastModified = res.headers.get('Last-Modified');
  let size, tail = null, tailStart = 0, rangeless = false, tailHash = '';
  if (res.status === 206) {
    const range = parseContentRange(res.headers.get('Content-Range'));
    if (!range || range.total == null) throw new Error('Server sent an unusable Content-Range');
    tail = new Uint8Array(await res.arrayBuffer());
    size = range.total;
    tailStart = range.start;
    if (!etag && !lastModified) tailHash = await sha256(tail);
  } else {
    res.body?.cancel();
    size = Number(res.headers.get('Content-Length')) || null;
    rangeless = true;
  }
  const version = [etag, lastModified, size, tailHash].join('|');
  return { size, tail, tailStart, rangeless, etag, lastModified, version };
}

async function restore(zipUrl, meta) {
  let cd = null, prefix = null;
  if (meta.config) {
    const res = await (await caches.open(CACHE_PREFIX + zipUrl)).match(indexKey(zipUrl));
    if (!res) return mountFresh(zipUrl, null);
    cd = new Uint8Array(await res.arrayBuffer());
  }
  if (meta.prefixLen) {
    prefix = await openPrefix(meta.storeKey);
    if (!prefix || prefix.size < meta.prefixLen) {
      prefix = null;
      meta.prefixLen = 0;
    }
  }
  return makeMount(zipUrl, meta, cd, prefix);
}

// Called by the launcher after it has downloaded bytes [0, n) of the archive into OPFS.
async function attachPrefix(zipUrl) {
  const mount = await getMount(zipUrl);
  const { meta } = mount;
  const file = await openPrefix(meta.storeKey);
  if (!file) throw new Error('Downloaded archive copy not found');
  let cd = mount.cd;
  if (meta.rangeless) {
    meta.size = file.size;
    const reader = async (s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer());
    const tailStart = Math.max(0, file.size - TAIL_SIZE);
    const index = await readIndex(reader, file.size, await reader(tailStart, file.size), tailStart);
    meta.config = index.config;
    meta.cdOffset = index.cdOffset;
    cd = index.cd;
  } else if (file.size < wantedPrefix(meta)) {
    throw new Error('Downloaded archive copy is incomplete');
  }
  meta.prefixLen = file.size;
  await saveIndex(zipUrl, meta, cd);
  const updated = makeMount(zipUrl, meta, cd, file);
  mounts.set(zipUrl, Promise.resolve(updated));
  return updated;
}

function makeMount(zipUrl, meta, cd, prefix) {
  const mount = {
    zipUrl, meta, cd, prefix,
    prefixLen: prefix ? meta.prefixLen : 0,
    config: meta.config || { headers: {} },
    cacheName: CACHE_PREFIX + zipUrl,
    entries: null, dirs: null, entryName: null, stale: false,
  };
  if (cd) {
    const { entries, dirs } = parseCentralDirectory(cd, meta.cdOffset);
    mount.entries = entries;
    mount.dirs = dirs;
    mount.entryName = pickEntry(entries, mount.config.entry);
  }
  mount.rewriter = makeRewriter(new URL(zipUrl).pathname, mount.config.rewrite || []);
  return mount;
}

function wantedPrefix(meta) {
  if (meta.rangeless || meta.config?.mode === 'full') return meta.size;
  return Math.min(meta.config?.preload || 0, meta.size);
}

function summary(mount) {
  const { meta } = mount;
  return {
    entry: mount.entryName,
    mode: meta.rangeless ? 'full' : mount.config.mode || 'range',
    size: meta.size,
    rangeless: meta.rangeless,
    want: wantedPrefix(meta),
    have: mount.prefixLen,
    storeKey: meta.storeKey,
    ifRange: meta.ifRange,
    etag: meta.etag,
    lastModified: meta.lastModified,
    files: mount.entries ? mount.entries.size : null,
    frame: mount.config.frame !== false,  // also for metadata stored before this option existed
    isolated: Object.keys(mount.config.headers || {}).some(h => h.toLowerCase() === 'cross-origin-embedder-policy'),
  };
}

function pickEntry(entries, configured) {
  if (configured && entries.has(configured)) return configured;
  if (entries.has('index.html')) return 'index.html';
  let best = null;
  for (const name of entries.keys()) {
    if (!/(^|\/)index\.html?$/i.test(name)) continue;
    if (!best || name.split('/').length < best.split('/').length) best = name;
  }
  return best;
}

// ---------------------------------------------------------------- zip format

async function readIndex(read, size, tail, tailStart) {
  const dv = view(tail);
  let pos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) === tail.length) {
      pos = i;
      break;
    }
  }
  if (pos < 0) throw new Error('Not a zip archive (end of central directory not found)');

  let count = dv.getUint16(pos + 10, true);
  let cdSize = dv.getUint32(pos + 12, true);
  let cdOffset = dv.getUint32(pos + 16, true);
  const comment = tail.subarray(pos + 22, pos + 22 + dv.getUint16(pos + 20, true));

  if (pos >= 20 && dv.getUint32(pos - 20, true) === 0x07064b50) {
    const at = Number(dv.getBigUint64(pos - 20 + 8, true));
    const rec = at >= tailStart ? tail.subarray(at - tailStart, at - tailStart + 56) : await read(at, at + 56);
    const rv = view(rec);
    if (rv.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt ZIP64 end record');
    count = Number(rv.getBigUint64(32, true));
    cdSize = Number(rv.getBigUint64(40, true));
    cdOffset = Number(rv.getBigUint64(48, true));
  }
  if (cdOffset + cdSize > size) throw new Error('Corrupt zip: central directory outside the file');

  const cd = cdOffset >= tailStart
    ? tail.slice(cdOffset - tailStart, cdOffset - tailStart + cdSize)
    : await read(cdOffset, cdOffset + cdSize);
  return { cd, count, cdOffset, cdSize, config: parseConfig(comment) };
}

function parseConfig(comment) {
  const config = { mode: 'range', entry: null, preload: 0, headers: {}, rewrite: [], frame: true };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(comment));
    if (parsed && parsed.zipbundle) {
      if (parsed.mode === 'full') config.mode = 'full';
      if (typeof parsed.entry === 'string') config.entry = parsed.entry;
      if (Number.isSafeInteger(parsed.preload) && parsed.preload > 0) config.preload = parsed.preload;
      if (parsed.headers && typeof parsed.headers === 'object') config.headers = parsed.headers;
      if (Array.isArray(parsed.rewrite)) config.rewrite = parsed.rewrite;
      if (parsed.frame === false) config.frame = false;
    }
  } catch {
    // not our comment: defaults
  }
  return config;
}

function parseCentralDirectory(cd, cdOffset) {
  const dv = view(cd);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const latin1 = new TextDecoder('latin1');
  const entries = new Map();
  const dirs = new Set();
  const list = [];
  let p = 0;
  while (p + 46 <= cd.length && dv.getUint32(p, true) === 0x02014b50) {
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const n = dv.getUint16(p + 28, true);
    const m = dv.getUint16(p + 30, true);
    const k = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + n);

    for (let x = p + 46 + n; x + 4 <= p + 46 + n + m;) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(f, true)); f += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(f, true)); f += 8; }
        if (lho === 0xffffffff) { lho = Number(dv.getBigUint64(f, true)); }
      }
      x += 4 + len;
    }
    p += 46 + n + m + k;

    // Many tools write UTF-8 names without setting the UTF-8 flag, so try UTF-8 first.
    let name;
    try { name = utf8.decode(nameBytes); } catch { name = latin1.decode(nameBytes); }
    name = name.normalize('NFC').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    const isDir = name.endsWith('/');
    if (isDir) name = name.slice(0, -1);
    for (let i = name.indexOf('/'); i > 0; i = name.indexOf('/', i + 1)) dirs.add(name.slice(0, i));
    if (isDir) { dirs.add(name); continue; }
    if (flags & 1) continue;  // encrypted

    const entry = { name, method, csize, usize, lho, span: 0, dataStart: null, pending: null };
    entries.set(name, entry);
    list.push(entry);
  }

  // span: bytes from the local header to the next record, so one request gets header + data.
  list.sort((a, b) => a.lho - b.lho);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const next = i + 1 < list.length ? list[i + 1].lho : cdOffset;
    e.span = next > e.lho ? next - e.lho : Math.max(0, cdOffset - e.lho);
  }
  return { entries, dirs };
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------- persistence

const metaKey = zipUrl => zipUrl + '?zipbundle=meta';
const indexKey = zipUrl => zipUrl + '?zipbundle=index';
const entryKey = (zipUrl, name) => zipUrl + '?zipbundle=entry&path=' + encodeURIComponent(name);

async function loadMeta(zipUrl) {
  const res = await (await caches.open(CACHE_PREFIX + zipUrl)).match(metaKey(zipUrl));
  return res ? res.json() : null;
}

async function saveMeta(zipUrl, meta) {
  const cache = await caches.open(CACHE_PREFIX + zipUrl);
  await cache.put(metaKey(zipUrl), new Response(JSON.stringify(meta)));
}

async function saveIndex(zipUrl, meta, cd) {
  if (cd) {
    const cache = await caches.open(CACHE_PREFIX + zipUrl);
    await cache.put(indexKey(zipUrl), new Response(cd));
  }
  await saveMeta(zipUrl, meta);
}

async function wipe(zipUrl) {
  await caches.delete(CACHE_PREFIX + zipUrl);
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR);
    await dir.removeEntry((await storeKey(zipUrl)) + '.bin');
  } catch {
    // nothing stored
  }
}

// Deletes everything stored for every archive on this origin.
async function resetAll() {
  mounts.clear();
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX)) await caches.delete(name);
  }
  try {
    await (await navigator.storage.getDirectory()).removeEntry(OPFS_DIR, { recursive: true });
  } catch {
    // nothing stored
  }
}

async function openPrefix(key) {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR);
    return await (await dir.getFileHandle(key + '.bin')).getFile();
  } catch {
    return null;
  }
}

async function storeKey(zipUrl) {
  return (await sha256(new TextEncoder().encode(zipUrl))).slice(0, 32);
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- absolute path rewriting

// An app built for the site root references "/assets/x.png", which on the hosting points outside
// the archive (and outside the worker's scope, so the request is never seen here). For the prefixes
// listed in the bundle config, such references in text files are rewritten to
// "<path of app.zip>/assets/x.png". Best effort: URLs assembled at runtime are not found.

const REWRITE_KINDS = {
  html: 'html', htm: 'html', svg: 'markup', css: 'css',
  js: 'js', mjs: 'js', cjs: 'js', json: 'js', webmanifest: 'js',
};

// Characters after which a path starts a URL. Markup also has unquoted attributes and srcset
// lists; in JS only string literals are safe ("= /assets/" can be a regular expression literal).
const URL_START = { html: `"'=,(\\s`, markup: `"'=,(\\s`, css: `"'(\\s`, js: `"'\`` };

function makeRewriter(mountPath, prefixes) {
  prefixes = prefixes.filter(p => typeof p === 'string' && /^\/[^/]/.test(p));
  if (!prefixes.length) return null;
  // "/assets/" matches as a prefix; "/favicon.ico" only as a whole path.
  const alternatives = prefixes
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (p.endsWith('/') ? '' : '(?=[?#"\'`)\\s,;>]|$)'))
    .join('|');
  const patterns = {};
  for (const [kind, chars] of Object.entries(URL_START)) {
    patterns[kind] = new RegExp(`(^|[${chars}])(${alternatives})`, 'g');
  }
  // Module specifiers assembled at runtime ("/" + "assets/x.js") are caught by an import map.
  const imports = Object.fromEntries(prefixes.map(p => [p, mountPath + p]));
  const importMap = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
  return { mountPath, patterns, importMap };
}

function rewriteText(rewriter, kind, text) {
  const out = text.replace(rewriter.patterns[kind], (_, before, path) => before + rewriter.mountPath + path);
  if (kind !== 'html') return out;
  // The import map must come before any module script, so put it at the start of <head>
  // (after the doctype, so the page does not drop into quirks mode).
  const anchor = /<head(\s[^>]*)?>/i.exec(out) || /<html(\s[^>]*)?>/i.exec(out) || /<!doctype[^>]*>/i.exec(out);
  const at = anchor ? anchor.index + anchor[0].length : 0;
  return out.slice(0, at) + rewriter.importMap + out.slice(at);
}

// ---------------------------------------------------------------- MIME types

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json', xml: 'application/xml', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', ktx2: 'image/ktx2',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', pdf: 'application/pdf', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  zip: 'application/zip', pck: 'application/octet-stream', data: 'application/octet-stream',
};

function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot > name.lastIndexOf('/') ? name.slice(dot + 1).toLowerCase() : '';
}

function mimeType(name) {
  return MIME[extension(name)] || 'application/octet-stream';
}
