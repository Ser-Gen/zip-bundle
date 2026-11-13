// Generates a test application that exercises the ways a page loads files.
// main.js reports results in window.__results and sets document.title = 'done'.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const MAIN_JS = `import { add, lazy } from './lib/util.js';
const r = {};
const hex = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
try {
  r.module = add(2, 3) === 5;
  r.lazy = await lazy() === 'lazy-ok';
  r.json = (await (await fetch('data/info.json')).json()).hello === 'json-ok';
  r.worker = await new Promise(res => { const w = new Worker('worker.js'); w.onmessage = e => res(e.data === 'worker-ok'); w.onerror = () => res(false); });
  const img = new Image(); img.src = 'data/pixel.png'; await img.decode(); r.image = img.width === 1;
  r.cssBg = getComputedStyle(document.getElementById('bg')).backgroundImage.includes('pixel.png');
  r.unicode = (await (await fetch('ünï cödé/fïle 1.txt')).text()).trim() === 'unicode-ok';
  const big = await (await fetch('data/big.bin')).arrayBuffer();
  r.bigSize = big.byteLength === 5000000;
  r.bigHash = await hex(big) === (await (await fetch('data/big.sha')).text()).trim();
  const part = await fetch('data/big.bin', { headers: { Range: 'bytes=1000-1999' } });
  r.rangeStatus = part.status === 206 && part.headers.get('Content-Range') === 'bytes 1000-1999/5000000';
  r.rangeBytes = (await hex(await part.arrayBuffer())) === (await hex(big.slice(1000, 2000)));
  const texts = await Promise.all(Array.from({ length: 300 }, (_, i) => fetch(\`many/f\${i + 1}.txt\`).then(x => x.text())));
  r.many = texts.every((t, i) => t.trim() === \`file \${i + 1}\`);
  r.notFound = (await fetch('nope.txt')).status === 404;
  const docs = await fetch('docs');
  r.dirRedirect = docs.redirected && docs.url.endsWith('/docs/') && (await docs.text()).includes('docs-ok');
  r.mime = (await fetch('lib/util.js')).headers.get('Content-Type').startsWith('text/javascript');
  r.isolated = self.crossOriginIsolated;
  r.location = location.pathname;
} catch (e) { r.error = String(e.stack || e); }
window.__results = r;
document.title = 'done';
`;

// A page written for the site root (absolute paths); works only with rewriting.
// Reports in window.__abs and sets document.title = 'abs-done'.
const ABS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>abs</title><link rel="stylesheet" href="/abs/abs.css"></head>
<body><div id="bg" class="bg2"></div><img id="img" src=/data/pixel.png><script type="module" src="/abs/abs.js"></script></body></html>
`;
const ABS_JS = `import { add } from '/lib/util.js';
const r = {};
try {
  r.module = add(1, 2) === 3;
  r.fetch = (await (await fetch('/data/info.json')).json()).hello === 'json-ok';
  const dir = 'lib';
  r.importMap = (await import('/' + dir + '/lazy.js')).value === 'lazy-ok';
  const img = document.getElementById('img');
  await img.decode();
  r.img = img.naturalWidth === 1;
  r.css = getComputedStyle(document.getElementById('bg')).backgroundImage.includes('/app.zip/data/pixel.png');
} catch (e) { r.error = String(e.stack || e); }
window.__abs = r;
document.title = 'abs-done';
`;

export function makeFixture(dir) {
  const big = randomBytes(5000000);
  const files = {
    'index.html': '<!doctype html>\n<html><head><meta charset="utf-8"><title>Test app</title><link rel="stylesheet" href="style.css"></head>\n'
      + '<body><h1>Test app</h1><div class="bg" id="bg"></div><script type="module" src="main.js"></script></body></html>\n',
    'style.css': '@font-face { font-family: T; src: url("data/font.woff2"); }\n.bg { width: 10px; height: 10px; background: url("data/pixel.png"); }\n',
    'main.js': MAIN_JS,
    'lib/util.js': "export const add = (a, b) => a + b;\nexport async function lazy() { return (await import('./lazy.js')).value; }\n",
    'lib/lazy.js': "export const value = 'lazy-ok';\n",
    'lib/classic.js': "self.classicValue = 'worker-ok';\n",
    'worker.js': "importScripts('lib/classic.js');\npostMessage(classicValue);\n",
    'data/info.json': '{"hello":"json-ok"}\n',
    'data/pixel.png': Buffer.from(PIXEL_PNG, 'base64'),
    'data/font.woff2': randomBytes(3000),  // never requested: the font is unused
    'data/big.bin': big,
    'data/big.sha': createHash('sha256').update(big).digest('hex') + '\n',
    'docs/index.html': '<!doctype html><title>docs</title><p id=p>docs-ok</p>\n',
    'ünï cödé/fïle 1.txt': 'unicode-ok\n',
    'abs.html': ABS_HTML,
    'abs/abs.css': '.bg2 { width: 10px; height: 10px; background: url(/data/pixel.png); }\n',
    'abs/abs.js': ABS_JS,
  };
  for (let i = 1; i <= 300; i++) files[`many/f${i}.txt`] = `file ${i}\n`;
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return Object.keys(files).sort();
}
