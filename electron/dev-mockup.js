'use strict';
// Developer mode only: serves the design mockup (frontend/mockup) on a fixed local port, so it is always at the
// same address next to the app. It listens on this PC only and is never started in a normal run.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_PORT = 5175;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

/** Starts the server; resolves with it (or null when there is no mockup folder or the port is taken). */
function startMockupServer({ dir, port = Number(process.env.OMM_MOCKUP_PORT) || DEFAULT_PORT, log = () => {} }) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    log(`Mockup not served: no ${dir}`);
    return Promise.resolve(null);
  }
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.resolve(root, '.' + (url.endsWith('/') ? url + 'index.html' : url));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(resolve => {
    server.once('error', e => { log(`Mockup not served on port ${port}: ${e.message}`); resolve(null); });
    server.listen(port, '127.0.0.1', () => { log(`Mockup served at http://127.0.0.1:${port}/`); resolve(server); });
  });
}

module.exports = { startMockupServer, DEFAULT_PORT };
