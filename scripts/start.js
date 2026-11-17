// `yarn start`: builds the frontend, then starts the desktop shell. (A launcher of our own instead of
// "yarn build:frontend && electron ." so that Ctrl+C can be handled properly: see lib/interrupt.js.)

import path from 'node:path';
import electronPath from 'electron'; // (outside Electron the package is the path of the executable)
import { spawn, spawnSync } from 'node:child_process';
import { onInterrupt } from './lib/interrupt.js';

const root = path.join(import.meta.dirname, '..');
const build = spawnSync('yarn', ['build:frontend'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) process.exit(build.status ?? 1);

const electron = spawn(electronPath, ['.'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
onInterrupt(() => {
  if (stopping) return;
  stopping = true;
  if (electron.exitCode === null && electron.signalCode === null) electron.kill('SIGTERM');
  setTimeout(() => process.exit(0), 15000).unref(); // the shell saves and stops the instances before it ends
});
electron.on('exit', code => process.exit(code ?? 0));
