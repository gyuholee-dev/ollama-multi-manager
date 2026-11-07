'use strict';
// Builds the backend into build/backend/ollama-multi-manager-backend/ with PyInstaller (one folder, not one file:
// it starts faster, does not unpack to a temp directory on every launch, and trips antivirus heuristics less).
// Needs backend/.venv with backend/requirements-build.txt installed. Builds for the OS it runs on only.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const backend = path.join(root, 'backend');
const win = process.platform === 'win32';
const python = process.env.OMM_PYTHON || path.join(backend, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');

if (!fs.existsSync(python)) {
  console.error(`Python not found at ${python}.\nCreate the virtualenv first:  cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-build.txt`);
  process.exit(1);
}

const out = path.join(root, 'build');
const args = [
  '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'ollama-multi-manager-backend',
  '--distpath', path.join(out, 'backend'), '--workpath', path.join(out, 'pyinstaller'), '--specpath', path.join(out, 'pyinstaller'),
  '--add-data', `${path.join(backend, 'schema.sql')}${win ? ';' : ':'}.`,   // db.py reads schema.sql next to the app package
  '--collect-submodules', 'uvicorn', '--collect-submodules', 'app', '--hidden-import', 'pynvml',
  path.join(backend, 'run_backend.py'),
];
console.log(`> ${python} ${args.join(' ')}`);
const r = spawnSync(python, args, { cwd: backend, stdio: 'inherit' });
process.exit(r.status ?? 1);
