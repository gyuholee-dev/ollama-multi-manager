'use strict';
// `yarn start`: builds the frontend, then starts the desktop shell. (A launcher of our own instead of
// "yarn build:frontend && electron ." so that Ctrl+C can be handled properly: see lib/interrupt.js.)

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { onInterrupt } = require('./lib/interrupt');

const root = path.join(__dirname, '..');
const build = spawnSync('yarn', ['build:frontend'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) process.exit(build.status ?? 1);

const electron = spawn(require('electron'), ['.'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
onInterrupt(() => {
  if (stopping) return;
  stopping = true;
  if (electron.exitCode === null && electron.signalCode === null) electron.kill('SIGTERM');
  setTimeout(() => process.exit(0), 15000).unref(); // the shell saves and stops the instances before it ends
});
electron.on('exit', code => process.exit(code ?? 0));
