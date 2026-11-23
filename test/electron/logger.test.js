import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consoleEntry, createLogger, dayOf, fileLine, pruneLogs, resetLogs, terminalLevel, terminalLine, textOf } from '../../electron/logger.js';

const at = new Date('2026-11-23T08:33:20.687Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omm-log-'));
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('the lines: a file line always has its level, a terminal line only when it is not info', () => {
  assert.equal(fileLine(at, 'info', 'main', 'hello'), '2026-11-23T08:33:20.687Z INFO  [main] hello');
  assert.equal(fileLine(at, 'warn', 'main', 'hmm'), '2026-11-23T08:33:20.687Z WARN  [main] hmm');
  assert.equal(terminalLine(at, 'info', 'main', 'hello'), '2026-11-23T08:33:20.687Z [main] hello');
  assert.equal(terminalLine(at, 'error', 'backend', 'bad'), '2026-11-23T08:33:20.687Z [backend] ERROR bad');
});

test('the arguments become text like console.log does it', () => {
  assert.equal(textOf(['Could not save:', new Error('disk full'), { a: 1 }, 5]), 'Could not save: disk full {"a":1} 5');
});

test('everything goes to the file, the terminal shows info, warnings and errors only', async () => {
  const dir = tmp(), shown = [];
  const log = createLogger({ dir, name: 'main', terminal: l => shown.push(l), env: {}, clock: () => at });
  log.debug('detail'); log('info line'); log.warn('careful'); log.error('broken');
  await log.close();
  assert.deepEqual(shown.map(l => l.split('] ')[1]), ['info line', 'WARN careful', 'ERROR broken']);
  const file = read(dir, `main-${dayOf(at)}.log`).trim().split('\n');
  assert.equal(file.length, 4);
  assert.match(file[0], /DEBUG \[main\] detail$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OMM_LOG_LEVEL changes what the terminal shows, never what the file has', async () => {
  assert.equal(terminalLevel({}), 'info');
  assert.equal(terminalLevel({ OMM_LOG_LEVEL: 'DEBUG' }), 'debug');
  assert.equal(terminalLevel({ OMM_LOG_LEVEL: 'loud' }), 'info');
  const dir = tmp(), shown = [];
  const log = createLogger({ dir, name: 'x', terminal: l => shown.push(l), env: { OMM_LOG_LEVEL: 'error' }, clock: () => at });
  log('i'); log.warn('w'); log.error('e');
  await log.close();
  assert.equal(shown.length, 1);
  assert.equal(read(dir, `x-${dayOf(at)}.log`).trim().split('\n').length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a new day is a new file', async () => {
  const dir = tmp();
  let now = new Date(2026, 10, 23, 23, 59, 0);
  const log = createLogger({ dir, name: 'main', terminal: () => {}, env: {}, clock: () => now });
  log('before midnight');
  now = new Date(2026, 10, 24, 0, 1, 0);
  log('after midnight');
  await log.close();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['main-2026-11-23.log', 'main-2026-11-24.log']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('files older than 30 days are deleted, newer ones and other files stay; a reset deletes every log', () => {
  const dir = tmp(), now = new Date('2026-11-23T12:00:00Z');
  const make = (name, daysAgo) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); const t = new Date(now.getTime() - daysAgo * 86400000); fs.utimesSync(f, t, t); };
  make('backend.log', 1); make('backend.log.2026-10-01', 50); make('main-2026-10-01.log', 45); make('main-2026-11-20.log', 3); make('note.txt', 90);
  assert.deepEqual(pruneLogs(dir, 30, now).sort(), ['backend.log.2026-10-01', 'main-2026-10-01.log']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['backend.log', 'main-2026-11-20.log', 'note.txt']);
  assert.deepEqual(resetLogs(dir).sort(), ['backend.log', 'main-2026-11-20.log']);
  assert.deepEqual(fs.readdirSync(dir), ['note.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder that is not there is no error', () => {
  assert.deepEqual(pruneLogs('/nonexistent/omm-logs'), []);
  assert.deepEqual(resetLogs('/nonexistent/omm-logs'), []);
});

test('a page console message, in the form of Electron 35 and later and in the older one', () => {
  assert.deepEqual(consoleEntry([{ level: 'warning', message: 'slow', lineNumber: 7, sourceId: 'app.js' }], 'main'), { level: 'warn', text: '(main) slow [app.js:7]' });
  assert.deepEqual(consoleEntry([{}, 3, 'broken', 12, 'x.js'], 'monitor 1'), { level: 'error', text: '(monitor 1) broken [x.js:12]' });
  assert.deepEqual(consoleEntry([{ level: 'info', message: 'plain' }], 'main'), { level: 'info', text: '(main) plain' });
});
