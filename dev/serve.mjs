// Static file server with HTTP range support, for testing zip bundles locally.
//   node dev/serve.mjs [root] [--port 8080] [--no-range] [--log]
// Without --port, the first free port from 8080 up is used.
// --no-range simulates hosting that ignores Range headers.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = resolve(args.find((a, i) => !a.startsWith('--') && !['--port'].includes(args[i - 1])) || '.');
const fixedPort = args.includes('--port');
let port = Number(option('--port', 8080));
const noRange = flag('--no-range');
const log = flag('--log');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.zip': 'application/zip', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  let file = path, info = null;
  try {
    info = await stat(file);
    if (info.isDirectory()) info = await stat(file = join(file, 'index.html'));
  } catch { info = null; }
  if (!info) {
    if (log) console.log(404, req.url);
    return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }

  const size = info.size;
  const etag = `"${info.mtimeMs.toString(36)}-${size.toString(36)}"`;
  const headers = {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'ETag': etag,
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
  };
  if (!noRange) headers['Accept-Ranges'] = 'bytes';

  let start = 0, end = size;
  let status = 200;
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (range && !noRange && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1]); end = m[2] ? Math.min(size, Number(m[2]) + 1) : size; }
      if (start >= size || start >= end) {
        return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end - 1}/${size}`;
    }
  }
  headers['Content-Length'] = end - start;
  if (log) console.log(status, req.method, req.url, range || '', ifRange ? `If-Range ${ifRange}` : '');
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || end === start) return res.end();
  createReadStream(file, { start, end: end - 1 }).pipe(res);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE' && !fixedPort && port < 8100) return server.listen(++port);
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : err.message);
  process.exit(1);
});
server.on('listening', () => {
  console.log(`Serving ${root} on http://localhost:${server.address().port}${noRange ? ' (no range support)' : ''}`);
});
server.listen(port);
