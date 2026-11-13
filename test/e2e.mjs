// End-to-end tests in headless Chrome: builds archives with builder.html's writeZip (and Info-ZIP),
// serves each variant from its own origin with dev/serve.mjs and runs the fixture app through the
// launcher. Run: npm test   (CHROME_PATH overrides the Chrome binary)
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, utimesSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture } from './fixture.mjs';

const PROJECT = new URL('..', import.meta.url).pathname;
const TMP = join(PROJECT, 'test/.tmp');
const APP = join(TMP, 'app');
const SITES = join(TMP, 'sites');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

rmSync(TMP, { recursive: true, force: true });
mkdirSync(SITES, { recursive: true });
const appFiles = makeFixture(APP);

const servers = [];
function serve(root, port, extra = []) {
  const p = spawn('node', [join(PROJECT, 'dev/serve.mjs'), root, '--port', String(port), '--log', ...extra]);
  const srv = { p, log: [] };
  p.stdout.on('data', d => srv.log.push(...d.toString().trim().split('\n')));
  p.stderr.on('data', d => process.stderr.write(d));
  servers.push(srv);
  return new Promise(r => setTimeout(() => r(srv), 300));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'zip-bundle-chrome-')),
});
let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
};

// The builder page serves as the zip writer: the project root is served so it can fetch the fixture.
await serve(PROJECT, 9100);
const builderPage = await browser.newPage();
await builderPage.goto('http://localhost:9100/builder.html');
const FIXTURE_URL = '/test/.tmp/app/';

// order: archive paths in archive order. config.preloadCount: number of leading files to preload.
async function buildZip(out, { order, config, synthetic = 0 }) {
  const b64 = await builderPage.evaluate(async (base, order, config, synthetic) => {
    const files = [];
    for (const path of order) {
      const blob = await (await fetch(base + path.split('/').map(encodeURIComponent).join('/'))).blob();
      files.push({ path, blob, lastModified: Date.now() });
    }
    for (let i = 0; i < synthetic; i++) files.push({ path: `gen/${Math.floor(i / 1000)}/n${i}.txt`, blob: new Blob([`n${i}`]), lastModified: 0 });
    const preloadCount = config.preloadCount || 0;
    delete config.preloadCount;
    let comment = JSON.stringify(config);
    if (preloadCount) {
      const { preloadEnd } = await window.zipBundle.writeZip(files, { comment, preloadCount }, { write: async () => {} });
      comment = JSON.stringify({ ...config, preload: preloadEnd });
    }
    const parts = [];
    await window.zipBundle.writeZip(files, { comment, preloadCount }, { write: async b => parts.push(b) });
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, FIXTURE_URL, order, config, synthetic);
  writeFileSync(out, Buffer.from(b64, 'base64'));
}

function site(name, zipPath) {
  const dir = join(SITES, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(PROJECT, 'runtime/launcher.html'), join(dir, 'launcher.html'));
  copyFileSync(join(PROJECT, 'runtime/sw.js'), join(dir, 'sw.js'));
  copyFileSync(zipPath, join(dir, 'app.zip'));
  return dir;
}

// The app's frame: the launcher's iframe in frame mode, else the page itself.
const app = page => page.frames().find(f => f.url().includes('/app.zip/')) || page.mainFrame();

async function run(url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => document.title === 'done' || document.body?.classList.contains('error'), { timeout: 30000 });
  const results = await app(page).evaluate(() => window.__results)
    || await page.evaluate(() => ({ launcherError: document.body.innerText }));
  await page.close();
  return { results, errors };
}

function verify(label, { results, errors }, { isolated = false, skip = [] } = {}) {
  const expected = ['module', 'lazy', 'json', 'worker', 'image', 'cssBg', 'unicode', 'bigSize', 'bigHash',
    'rangeStatus', 'rangeBytes', 'many', 'notFound', 'dirRedirect', 'mime'].filter(k => !skip.includes(k));
  const bad = expected.filter(k => results[k] !== true);
  if (results.isolated !== isolated) bad.push(`isolated=${results.isolated}`);
  check(label, bad.length === 0 && !results.error && !results.launcherError,
    [bad.join(','), results.error, results.launcherError, errors.join(' ')].filter(Boolean).join(' | '));
}

const entryFirst = ['index.html', ...appFiles.filter(f => f !== 'index.html')];

// 1. builder zip, on-demand mode, preload lib/**
{
  const preload = ['index.html', ...appFiles.filter(f => f.startsWith('lib/'))];
  const order = [...preload, ...appFiles.filter(f => !preload.includes(f))];
  const config = () => ({ zipbundle: 1, entry: 'index.html', mode: 'range', headers: {}, preloadCount: preload.length });
  await buildZip(join(TMP, 'range.zip'), { order, config: config() });
  execFileSync('unzip', ['-tq', join(TMP, 'range.zip')]);
  const srv = await serve(site('range', join(TMP, 'range.zip')), 9101);
  const r = await run('http://localhost:9101/launcher.html');
  verify('builder zip, on-demand + preload', r);
  check('app opens at the folder URL app.zip/', r.results.location === '/app.zip/', r.results.location);
  const zipReqs = srv.log.filter(l => l.includes('/app.zip'));
  check('coalescing: 300 small files took few requests', zipReqs.length < 40, `${zipReqs.length} archive requests`);
  check('preload fetched as one range from 0', zipReqs.some(l => / bytes=0-\d+/.test(l)));

  srv.log.length = 0;
  verify('second visit', await run('http://localhost:9101/launcher.html'));
  const again = srv.log.filter(l => l.includes('/app.zip'));
  check('second visit: only the version probe', again.length <= 1, again.join(' ; '));

  // new version uploaded: the launcher notices and serves new content
  writeFileSync(join(APP, 'data/info.json'), '{"hello":"json-ok","v":2}');
  await buildZip(join(SITES, 'range/app.zip'), { order, config: config() });
  utimesSync(join(SITES, 'range/app.zip'), new Date(), new Date(Date.now() + 5000));
  const page = await browser.newPage();
  await page.goto('http://localhost:9101/launcher.html');
  await page.waitForFunction(() => document.title === 'done', { timeout: 30000 });
  const v2 = await app(page).evaluate(async () => (await (await fetch('data/info.json')).json()).v);
  check('new archive version picked up', v2 === 2, `v=${v2}`);

  // archive replaced while the app is open: the next uncached read detects it and remounts
  writeFileSync(join(APP, 'data/info.json'), '{"hello":"json-ok","v":3}');
  await buildZip(join(SITES, 'range/app.zip'), { order, config: config() });
  utimesSync(join(SITES, 'range/app.zip'), new Date(), new Date(Date.now() + 10000));
  const v3 = await app(page).evaluate(async () => {
    const r = await fetch('data/font.woff2');  // never loaded by the app, so not cached
    return { status: r.status, size: (await r.arrayBuffer()).byteLength };
  });
  check('mid-session replacement detected, request still served', v3.status === 200 && v3.size === 3000, JSON.stringify(v3));
  await page.close();
  writeFileSync(join(APP, 'data/info.json'), '{"hello":"json-ok"}\n');
}

// 2. builder zip, full mode, COOP/COEP headers; then reset
{
  await buildZip(join(TMP, 'full.zip'), {
    order: entryFirst,
    config: { zipbundle: 1, entry: 'index.html', mode: 'full', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  });
  const srv = await serve(site('full', join(TMP, 'full.zip')), 9102);
  verify('builder zip, full download + COOP/COEP', await run('http://localhost:9102/launcher.html'), { isolated: true });
  const zipReqs = srv.log.filter(l => l.includes('/app.zip'));
  check('full mode: probe + one download only', zipReqs.length === 2, zipReqs.join(' ; '));

  const page = await browser.newPage();
  const stored = async () => page.evaluate(async () => {
    let opfs = 0;
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('zipbundle');
      for await (const _ of dir.keys()) opfs++;
    } catch { /* missing */ }
    const caches_ = (await caches.keys()).filter(k => k.startsWith('zipbundle:')).length;
    const sw = !!(await navigator.serviceWorker.getRegistration());
    return { opfs, caches: caches_, sw };
  });
  await page.goto('http://localhost:9102/launcher.html?zip-bundle-reset');
  await page.waitForFunction(() => /cleared|Could not/.test(document.body.innerText), { timeout: 15000 });
  const after = await stored();
  check('reset clears OPFS, caches and the service worker', !after.opfs && !after.caches && !after.sw,
    `${JSON.stringify(after)} ${await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))}`);
  await page.click('button');
  await page.waitForFunction(() => document.title === 'done', { timeout: 30000 });
  check('app starts again after reset', (await stored()).opfs === 1);
  await page.close();
}

// 3. Info-ZIP deflate archive (not made by the builder, no config)
{
  rmSync(join(TMP, 'deflate.zip'), { force: true });
  execFileSync('zip', ['-qr9', join(TMP, 'deflate.zip'), '.'], { cwd: APP });
  await serve(site('deflate', join(TMP, 'deflate.zip')), 9103);
  // ranges on deflated entries are answered with 200 + the whole body
  verify('Info-ZIP deflate archive', await run('http://localhost:9103/launcher.html'), { skip: ['rangeStatus', 'rangeBytes'] });
}

// 4. server without range support: the launcher downloads everything
{
  await serve(site('norange', join(TMP, 'range.zip')), 9104, ['--no-range']);
  verify('server ignoring Range', await run('http://localhost:9104/launcher.html'));
}

// 5. ZIP64: more than 65535 entries
{
  await buildZip(join(TMP, 'zip64.zip'), { order: entryFirst, config: { zipbundle: 1, entry: 'index.html', mode: 'range', headers: {} }, synthetic: 70000 });
  const py = execFileSync('python3', ['-I', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(len(z.namelist()), z.testzip())', join(TMP, 'zip64.zip')]).toString().trim();
  check('ZIP64 archive valid for Python zipfile', py === `${appFiles.length + 70000} None`, py);
  await serve(site('zip64', join(TMP, 'zip64.zip')), 9105);
  verify('ZIP64 archive in the launcher', await run('http://localhost:9105/launcher.html'));
  const page = await browser.newPage();
  await page.goto('http://localhost:9105/app.zip/index.html');
  const t = await page.evaluate(async () => (await (await fetch('gen/69/n69999.txt')).text()));
  check('ZIP64 entry readable', t === 'n69999', t);
  await page.close();
}

// 7. absolute paths rewritten, with the bundle in a subfolder (as on hosting without root access)
{
  const dir = join(SITES, 'rewrite/sub/folder');
  mkdirSync(dir, { recursive: true });
  await buildZip(join(TMP, 'rewrite.zip'), {
    order: entryFirst,
    config: { zipbundle: 1, entry: 'abs.html', mode: 'range', headers: {}, rewrite: ['/abs/', '/data/', '/lib/'] },
  });
  copyFileSync(join(PROJECT, 'runtime/launcher.html'), join(dir, 'launcher.html'));
  copyFileSync(join(PROJECT, 'runtime/sw.js'), join(dir, 'sw.js'));
  copyFileSync(join(TMP, 'rewrite.zip'), join(dir, 'app.zip'));
  await serve(join(SITES, 'rewrite'), 9106);
  const page = await browser.newPage();
  await page.goto('http://localhost:9106/sub/folder/launcher.html');
  await page.waitForFunction(() => document.title === 'abs-done' || document.body?.classList.contains('error'), { timeout: 30000 });
  const r = await app(page).evaluate(() => window.__abs) || await page.evaluate(() => ({ launcherError: document.body.innerText }));
  const bad = ['module', 'fetch', 'importMap', 'img', 'css'].filter(k => r[k] !== true);
  check('absolute paths rewritten in HTML, CSS, JS + import map', !bad.length && !r.error && !r.launcherError,
    [bad.join(','), r.error, r.launcherError].filter(Boolean).join(' | '));
  const html = await app(page).evaluate(async () => (await fetch(location.href)).text());
  check('rewritten HTML keeps the doctype first', html.startsWith('<!doctype html>') && html.includes('"/abs/":"/sub/folder/app.zip/abs/"'), html.slice(0, 120));
  await page.close();
}

// 8. frame mode: the address bar keeps the launcher URL and follows the app's URL
{
  const L = 'http://localhost:9101/launcher.html';
  const page = await browser.newPage();
  await page.goto(L + '#start');
  await page.waitForFunction(() => document.title === 'done', { timeout: 30000 });
  check('frame mode: app runs in a frame, address bar keeps the launcher URL',
    page.url() === L + '#start' && app(page).url() === 'http://localhost:9101/app.zip/#start', `${page.url()} | ${app(page).url()}`);

  const until = (cond, arg) => page.waitForFunction(cond, { timeout: 5000 }, arg).then(() => true, () => false);
  await app(page).evaluate(() => history.pushState(null, '', '#pushed'));
  check('frame mode: pushState in the app updates the address bar', await until(u => location.href === u, L + '#pushed'), page.url());

  await page.evaluate(() => { location.hash = '#typed'; });
  check('frame mode: editing the hash in the address bar reaches the app',
    await until(() => document.querySelector('iframe').contentWindow.location.hash === '#typed'), app(page).url());

  await app(page).evaluate(() => { location.href = 'docs/?q=1#sec'; });
  const shared = L + '?zip-bundle-page=docs/%3Fq%3D1#sec';
  check('frame mode: other pages go into ?zip-bundle-page', await until(u => location.href === u && document.title === 'docs', shared), page.url());

  await page.goBack();
  check('frame mode: Back returns to the entry page', await until(u => location.href === u, L + '#typed'), page.url());

  // the link works in a clean profile (no service worker yet)
  const context = await browser.createBrowserContext();
  const fresh = await context.newPage();
  await fresh.goto(shared);
  await fresh.waitForFunction(() => document.title === 'docs', { timeout: 30000 }).catch(() => {});
  const text = await app(fresh).evaluate(() => document.body.innerText + ' ' + location.search + location.hash).catch(e => String(e));
  check('frame mode: a copied link opens the same page in a clean profile', /docs-ok \?q=1#sec/.test(text), text);
  await context.close();

  await app(page).evaluate(() => { location.href = '/outside.txt'; });
  check('frame mode: pages outside the archive open in the whole tab',
    await until(() => location.pathname === '/outside.txt'), page.url());
  await page.close();
}

// 6. builder UI: folder scan, ordering and the preload offset patched into the comment
{
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('pageerror', e));
  await page.goto('http://localhost:9100/builder.html');
  const [b64, log] = await page.evaluate(async (base, paths) => {
    const tree = {};
    for (const p of paths) {
      const blob = await (await fetch(base + p.split('/').map(encodeURIComponent).join('/'))).blob();
      const parts = p.split('/');
      let node = tree;
      for (const d of parts.slice(0, -1)) node = node[d] ||= {};
      node[parts.at(-1)] = new File([blob], parts.at(-1));
    }
    const dirHandle = (name, node) => ({
      kind: 'directory', name,
      async *entries() {
        for (const [k, v] of Object.entries(node)) yield [k, v instanceof File ? { kind: 'file', name: k, getFile: async () => v } : dirHandle(k, v)];
      },
    });
    let bytes = new Uint8Array(0);
    window.showDirectoryPicker = async () => dirHandle('app', tree);
    window.showSaveFilePicker = async () => ({
      name: 'app.zip',
      createWritable: async () => ({
        async write(x) {
          if (x instanceof Blob) {
            const b = new Uint8Array(await x.arrayBuffer());
            const n = new Uint8Array(bytes.length + b.length);
            n.set(bytes);
            n.set(b, bytes.length);
            bytes = n;
          } else bytes.set(x.data, x.position);
        },
        async close() {}, async abort() {},
      }),
    });
    const until = cond => new Promise(r => { const t = setInterval(() => { if (cond()) { clearInterval(t); r(); } }, 50); });
    document.getElementById('pick').click();
    await until(() => !document.getElementById('options').hidden && !/Checking/.test(document.getElementById('abs-report').textContent));
    const pre = document.getElementById('preload');
    pre.value = 'lib/**\n*.css';
    pre.dispatchEvent(new Event('input'));
    document.getElementById('build').click();
    await until(() => /Done|Failed/.test(document.getElementById('log').textContent));
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return [btoa(s), document.getElementById('log').textContent + '\n' + document.getElementById('abs-report').textContent];
  }, FIXTURE_URL, appFiles);
  await page.close();
  writeFileSync(join(TMP, 'ui.zip'), Buffer.from(b64, 'base64'));
  const out = execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
c = json.loads(z.comment)
names = [i.filename for i in z.infolist()]
pre = [i for i in z.infolist() if i.header_offset < c['preload']]
last = max(pre, key=lambda i: i.header_offset)
end = last.header_offset + 30 + len(last.filename.encode()) + last.file_size
print(json.dumps({'test': z.testzip(), 'first': names[:5], 'preloaded': len(pre), 'endOk': end == c['preload'], 'rewrite': c['rewrite']}))
`, join(TMP, 'ui.zip')]).toString();
  const res = JSON.parse(out);
  check('builder UI produces a valid archive', /Done/.test(log) && res.test === null, log.split('\n')[0]);
  check('builder UI order and preload offset',
    res.first.join() === 'index.html,abs/abs.css,lib/classic.js,lib/lazy.js,lib/util.js' && res.preloaded === 6 && res.endOk, out.trim());
  // "/docs/" is a false positive (a string compared in main.js), which the report lets the user spot
  check('builder detects absolute paths and proposes rewriting them',
    res.rewrite.join() === '/abs/,/data/,/docs/,/lib/' && /\/data\/ 3× in 3 files/.test(log), `${res.rewrite} | ${log.split('\n').slice(1).join(' ')}`);
}

await browser.close();
for (const s of servers) s.p.kill();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
