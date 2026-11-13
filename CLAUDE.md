# Zip Bundle

Runs a many-file web app from one zip on static hosting: `launcher.html` + `sw.js` + `app.zip`.
The service worker answers requests for `<scope>/<name>.zip/<path>` from the archive using HTTP
range requests. Chrome only; no build step, no runtime dependencies.

## Structure

- `builder.html` — bundler UI (File System Access API); contains the zip writer (`writeZip`, stored entries, ZIP64).
  `favicon.svg` is its tab icon.
- `runtime/sw.js` — service worker: zip index parsing, request routing, range reads, caching.
- `runtime/launcher.html` — registers the worker, mounts the archive, downloads into OPFS when needed, redirects into `app.zip/`. `?zip-bundle-reset` clears all stored data.
- `dev/serve.mjs` — static server with Range/ETag support (`--no-range`, `--log`).
- `test/e2e.mjs` — headless Chrome tests via puppeteer-core; `test/fixture.mjs` generates the test app into `test/.tmp/`.

## Commands

- `npm test` — full end-to-end suite (needs Chrome; `CHROME_PATH` overrides the path).
- `node dev/serve.mjs <dir>` — serve a site locally (first free port from 8080; `--port N` to fix it).

## Non-obvious parts

- Bundle settings (`mode`, `entry`, `preload`, `headers`, `rewrite`, `frame`) are JSON in the zip comment, read from the
  same tail request that finds the central directory. The builder writes a placeholder number and
  patches the real preload offset into the comment at the end of the file (padded with spaces).
- Mount path is derived from the URL (`….zip/`), so the worker needs no config and survives restarts.
  Index/meta live in Cache Storage (`zipbundle:<zipUrl>`), downloaded archive bytes in OPFS
  (`zipbundle/<sha256(zipUrl)>.bin`). Version = ETag|Last-Modified|size; a change wipes both.
- Large downloads are done by the launcher page, not the worker (Chrome kills long-running workers).
- `entry.span` = distance to the next local header, so one request fetches header + data (local extra
  fields differ from central ones). Small concurrent reads are coalesced into one range request.
- Stale detection: `If-Range` with strong ETags plus validator/size checks on every 206; on mismatch
  the worker remounts and retries once.
- File names: tools often write UTF-8 without the UTF-8 flag; names and request paths are NFC-normalized.
- Absolute-path rewriting (`config.rewrite` prefixes): the worker can't see `/assets/…` requests
  (outside its scope; hosting allows subfolders only), so it rewrites text files it serves
  (`serveRewritten`, delimiter rules per file kind in `URL_START`) and injects an import map after
  `<head>`. The builder's detector (`findAbsolutePaths`) proposes the prefixes; false positives are expected.
- Frame mode (`config.frame`, default on): the launcher keeps its URL and shows the app in an iframe,
  syncing URLs both ways via the frame's Navigation API (`currententrychange`, `navigate`) and
  `?zip-bundle-page=` for non-entry pages, so copied links work without an installed worker.
  Falls back to a redirect when COEP is configured (the launcher can't be cross-origin isolated).
- Entries are uncompressed by design (builder); deflate is still readable for foreign zips but can't
  serve byte ranges.
