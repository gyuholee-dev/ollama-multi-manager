'use strict';
// `yarn start:dev`: the app in developer mode.
//   1. reads the environment variables of the mode from .env.dev (see .env.example for what can be set there),
//   2. keeps frontend/dist rebuilt while the sources change (`vite build --watch`),
//   3. starts the desktop shell once the first build is there.
// Save a source file, then use the menu's Reload in the app. Backend (Python) changes need a restart of the app.
// A variable that is already set in the shell wins over the file.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const { onInterrupt } = require('./lib/interrupt');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env.dev');

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[dev] ${path.basename(file)} not found: copy .env.example to it to choose the settings (continuing with none)`);
    return {};
  }
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

const env = { ...loadEnv(envFile), ...process.env };
const children = [];
let stopping = false;

// a child ended by a signal has no exit code, only a signal name
const ended = c => c.exitCode !== null || c.signalCode !== null;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (!ended(c)) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 15000).unref(); // the shell saves and stops the instances before it ends
  const wait = () => (children.every(ended) ? process.exit(code) : setTimeout(wait, 100));
  wait();
}

// by path: the package's exports do not list its bin file, so require.resolve cannot find it
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, 'build', '--watch', '--config', path.join('frontend', 'vite.config.mts')], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'],
});
children.push(vite);
vite.on('exit', code => { if (!stopping) { console.error(`[dev] the frontend build watcher ended (code ${code})`); stop(1); } });

let started = false;
vite.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  if (started || !/built in/.test(chunk.toString())) return;
  started = true;
  const electron = spawn(require('electron'), ['.'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] }); // (stdin is ours: Ctrl+C)
  children.push(electron);
  electron.on('exit', code => stop(code ?? 0)); // closing the app ends the watcher too
});

onInterrupt(() => stop(0)); // Ctrl+C: see lib/interrupt.js
