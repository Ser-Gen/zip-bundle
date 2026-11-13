# Zip Bundle

Run a web application that consists of many files from **one zip archive** on static hosting.
A release is three files:

```
launcher.html   the page users open
sw.js           service worker that serves files out of the zip
app.zip         the application
```

The launcher registers `sw.js` and shows `app.zip/index.html` in a full-window frame. Every request under `app.zip/…`
(scripts, ES module imports, CSS `url()`, `fetch`, workers, wasm, media) is answered by the service
worker from the archive, so the application runs unmodified.

## Building a bundle

Open `builder.html` in Chrome (from `http://localhost` or any HTTPS host; it uses the File System
Access API), choose the application folder, set the options, and click **Save zip…**.

| Option | Effect |
|---|---|
| Entry page | Page the launcher opens (default `index.html`). |
| Loading: **On demand** | The launcher reads only the archive index; files are fetched with range requests when requested, then cached. |
| Loading: **Download the whole archive** | The launcher downloads the archive with a progress bar into the browser's disk storage (OPFS); afterwards nothing is fetched, and it also works offline. |
| Address bar: **Keep the launcher's URL** | On by default. The app runs in a frame and its URL is mirrored into the launcher's (see below). Off: the launcher redirects to `app.zip/…`. |
| Preload | On-demand mode only: matching files are put at the start of the archive and fetched in one request before the app opens. |
| Exclude | Files left out of the archive. |
| SharedArrayBuffer | Adds `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` to every response (Godot 4, Emscripten pthreads). |
| Response headers | Any other headers to add. |
| Absolute paths | The builder reports references like `"/assets/x.png"` that point to the site root instead of into the archive, and can have them rewritten (see below). |

Settings are stored as JSON in the zip comment, so the launcher and service worker are the same for
every application. Entries are stored uncompressed.

Any ordinary zip also works (e.g. `zip -r app.zip .`), including deflate-compressed ones; it is then
served on demand with `index.html` as the entry page.

## Deploying

Upload the three files into one folder. If the archive has another name, change
`<meta name="zip-bundle" content="app.zip">` in `launcher.html`. Share the launcher's URL.

Requirements for the hosting:

- HTTPS (service workers do not run on plain HTTP except on localhost, and never from `file://`).
- `sw.js` served with a JavaScript MIME type.
- Range requests for on-demand mode. Check with
  `curl -sI -H "Range: bytes=0-99" https://host/path/app.zip`: expect `206 Partial Content`.
  If the server ignores ranges, the launcher falls back to downloading the whole archive.

## Updating

Upload a new `app.zip` under the same name. On the next start the launcher sees a new
`ETag`/`Last-Modified`, drops the cached copy and reads the new archive. If the archive is replaced
while someone has the app open, the next uncached read notices it (via `If-Range`) and switches to
the new version. Files already loaded by the page stay old, so for strict consistency publish
versioned names (`app-1.4.zip`) and point the launcher's meta tag at the new one.

## Clearing stored data

Open `launcher.html?zip-bundle-reset`. It deletes the downloaded archives and cached files of all
bundles on the site, unregisters the service worker, and reports how much space was freed. The
launcher's error screen also has a **Clear downloaded data** button. (DevTools can't browse or
delete OPFS files.)

## Address bar and shared links

A link to `…/app.zip/…` works only in a browser where the launcher has already installed the service
worker; anywhere else the server answers it directly (404). So by default the launcher keeps its own
URL in the address bar and runs the app in a full-window iframe, mirroring the app's URL:

- `launcher.html?q#h` is the entry page with that query and hash (`app.zip/?q#h`). Hash and
  `pushState` changes in the app show up in the address bar; editing the hash there reaches the app.
- Other pages of the app appear as `launcher.html?zip-bundle-page=docs/page.html%3Fq#h`.
- Back/Forward work through the app's history; the tab shows the app's title and icon.
- Navigations to pages outside the archive (other sites, other paths of the host) open in the whole tab.

Apps that need SharedArrayBuffer (COOP/COEP headers set) run without the frame, because the launcher
page itself is served by the hosting without those headers. Apps that refuse to run in a frame
(`if (top !== self) top.location = …`) replace the launcher with `app.zip/…`.

## Behaviour details

- On-demand requests for small files that arrive together are merged into one range request when the
  files sit close together in the archive (the builder keeps each folder's files together).
- Files are cached in Cache Storage per archive version; a second visit costs one small request (the
  version check). Without network, the last stored version is used.
- Range requests from the page (`<video>`, `<audio>`, `fetch` with `Range`) are answered with exactly
  the requested bytes, also from the network in on-demand mode.
- `app.zip/some/dir` redirects to `app.zip/some/dir/`, which serves `index.html` from that folder.
  An `index.html` entry page is opened the same way (`app.zip/`), because some apps build their URLs
  from the page's path. The launcher passes its own query and hash on, so `launcher.html#x` opens `app.zip/#x`.

## Limitations

- Opening `…/app.zip/index.html` directly works only after the launcher has run once in that browser
  (the service worker must be installed); Shift+Reload bypasses the service worker. Always share the
  launcher URL.
- An application that registers its own service worker will not work: the browser loads service
  worker scripts from the network, not through `sw.js`.
- Absolute URLs are only partly fixable, see below. Building the app with relative URLs is better.

## Absolute paths

An app built for the site root references `/assets/x.png`. On the hosting that points outside
`app.zip/` and outside the service worker's folder, so the worker never sees the request.

After choosing a folder, the builder scans the text files and lists such references whose first
segment is a top-level folder or file of the archive, with a count and an example for each prefix.
Strings that only look like paths are listed too, so check the examples. With **Rewrite absolute
paths** on, the service worker rewrites the listed prefixes to the archive's real location
(`/assets/` → `/path/on/host/app.zip/assets/`) while serving:

- HTML and SVG attributes (quoted or not, including `srcset`), CSS `url()` and `@import`, and string
  literals in JS/JSON;
- module specifiers built at runtime (`import("/" + dir + "/x.js")`), through an import map
  inserted at the start of every HTML page.

Not handled: other URLs built at runtime from parts, for example webpack's `publicPath: "/"`, and
routers that read real URL paths (they expect to be at `/`). For those, rebuild the app with a
relative base: Vite `base: './'`, Create React App `"homepage": "."`, webpack `publicPath: 'auto'`,
Angular `--base-href ./`.

## Local testing

```
node dev/serve.mjs path/to/site --port 8080          # static server with Range support
node dev/serve.mjs path/to/site --port 8080 --no-range
```

Then open `http://localhost:8080/launcher.html`.

`npm install && npm test` runs the end-to-end suite in headless Chrome.
