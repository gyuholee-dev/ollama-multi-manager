'use strict';
// Starts, watches and stops the Python backend.
//
//  * dev:       backend/.venv python  -m app --port N
//  * packaged:  <resources>/backend/ollama-multi-manager-backend --port N   (PyInstaller build)
//
// The backend's output goes to a log file, not a pipe, so it can never block or die because Electron went away.
// A pid file lets the next launch clean up a backend that survived an Electron crash.

const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WIN = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function pythonPath() {
  if (process.env.OMM_PYTHON) return process.env.OMM_PYTHON;
  const venv = WIN ? path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe') : path.join(ROOT, 'backend', '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : (WIN ? 'python' : 'python3');
}

function commandFor(isPackaged) {
  if (isPackaged) {
    const exe = path.join(process.resourcesPath, 'backend', WIN ? 'ollama-multi-manager-backend.exe' : 'ollama-multi-manager-backend');
    return { cmd: exe, args: [], cwd: path.dirname(exe), frontend: path.join(process.resourcesPath, 'frontend') };
  }
  return { cmd: pythonPath(), args: ['-m', 'app'], cwd: path.join(ROOT, 'backend'), frontend: path.join(ROOT, 'frontend', 'legacy') };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Guards against PID reuse: only treat the pid as ours if its command line looks like the backend.
function looksLikeBackend(pid) {
  try {
    if (WIN) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).toLowerCase();
      return out.includes('ollama-multi-manager-backend') || out.includes('python');
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return out.includes('ollama-multi-manager-backend') || / -m app\b/.test(out);
  } catch { return false; }
}

class Backend {
  constructor({ dataDir, isPackaged, log = console.log }) {
    this.dataDir = dataDir;
    this.isPackaged = isPackaged;
    this.log = log;
    this.child = null;
    this.exited = true;
    this.stopping = false;
    this.port = 0;
    this.token = '';
    this.onCrash = () => {};
    this.pidFile = path.join(dataDir, 'backend.pid');
    this.logFile = path.join(dataDir, 'logs', 'backend.log');
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  async api(method, route, body) {
    const r = await fetch(this.url + route, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${route} -> ${r.status}`);
    return r.status === 204 ? null : r.json();
  }

  async cleanupStale() {
    let info;
    try { info = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')); } catch { return; }
    fs.rmSync(this.pidFile, { force: true });
    if (!info.pid || !alive(info.pid) || !looksLikeBackend(info.pid)) return;
    this.log(`Stopping leftover backend (pid ${info.pid}) from a previous run`);
    try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 100 && alive(info.pid); i++) await sleep(100);
    if (alive(info.pid)) { try { process.kill(info.pid, 'SIGKILL'); } catch { /* ignore */ } }
  }

  tailLog(n = 15) {
    try { return fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
  }

  async start() {
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    await this.cleanupStale();
    if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 5 * 1024 * 1024) fs.writeFileSync(this.logFile, '');

    this.port = await freePort();
    this.token = crypto.randomBytes(24).toString('hex');
    const { cmd, args, cwd, frontend } = commandFor(this.isPackaged);
    const out = fs.openSync(this.logFile, 'a');
    this.log(`Starting backend: ${cmd} ${[...args, '--port', this.port].join(' ')}`);
    this.exited = false;
    this.stopping = false;
    this.child = spawn(cmd, [...args, '--port', String(this.port)], {
      cwd, windowsHide: true, stdio: ['ignore', out, out],
      env: { ...process.env, OMM_TOKEN: this.token, OMM_DATA_DIR: this.dataDir, OMM_FRONTEND_DIR: frontend, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    fs.closeSync(out);
    this.child.once('error', e => { this.exited = true; this.log(`Backend failed to start: ${e.message}`); });
    this.child.once('exit', (code, sig) => {
      this.exited = true;
      fs.rmSync(this.pidFile, { force: true });
      this.log(`Backend exited (code ${code}, signal ${sig})`);
      if (!this.stopping) this.onCrash(code, sig);
    });
    if (this.child.pid) fs.writeFileSync(this.pidFile, JSON.stringify({ pid: this.child.pid, port: this.port }));
    await this.waitReady();
  }

  async waitReady(timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.exited) throw new Error(`The backend exited during startup.\n\n${this.tailLog()}`);
      try { if ((await fetch(this.url + '/health')).ok) return; } catch { /* not listening yet */ }
      await sleep(200);
    }
    throw new Error(`The backend did not become ready within ${timeoutMs / 1000} s.\n\n${this.tailLog()}`);
  }

  async waitExit(ms) {
    const end = Date.now() + ms;
    while (!this.exited && Date.now() < end) await sleep(100);
    return this.exited;
  }

  // Graceful first: the backend stops every instance and saves their running state, then exits.
  async stop() {
    if (!this.child || this.exited) return;
    this.stopping = true;
    try { await this.api('POST', '/shutdown'); } catch { /* fall through to the signal */ }
    if (await this.waitExit(25000)) return;
    this.log('Backend did not exit in time; terminating it');
    if (WIN) { try { execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F']); } catch { /* ignore */ } } else this.child.kill('SIGTERM');
    if (!await this.waitExit(8000) && !WIN) this.child.kill('SIGKILL');
  }
}

module.exports = { Backend };
