// The log of a process of the app, by the rule that is usual: everything goes to a file, and the terminal shows only info, warnings and errors.
//   file      <logs folder>/<name>-YYYY-MM-DD.log, one file a day: "2026-11-23T08:33:20.687Z INFO  [main] Mockup served at http://127.0.0.1:5175/"
//   terminal  "2026-11-23T08:33:20.687Z [main] Mockup served at ..." (a warning or an error has its level after the name: "[main] WARN ...")
// Debug lines (`log.debug`) are in the file only. OMM_LOG_LEVEL (debug, info, warn, error) changes what the terminal shows.
// The files are kept 30 days (pruneLogs), without a limit in developer mode; OMM_RESET_LOGS=1 deletes them at start (resetLogs).
// A fact that is an event too (a server started) is logged in words by the process that made it, and the ones that receive the event log it at debug level (backend-events.js).

import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = n => String(n).padStart(2, '0');
/** "2026-11-23": the day of a file's name (the local date). */
export const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** What `log(a, b ...)` makes of its arguments: like console.log, an Error is its message. */
export const textOf = args => args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

/** The line in the file: time, level (always), process, text. */
export const fileLine = (now, level, name, text) => `${now.toISOString()} ${level.toUpperCase().padEnd(5)} [${name}] ${text}`;

/** The line on the terminal: time, process, text; a level only when it is not info. */
export const terminalLine = (now, level, name, text) => `${now.toISOString()} [${name}]${level === 'info' ? '' : ` ${level.toUpperCase()}`} ${text}`;

/** The lowest level the terminal shows: OMM_LOG_LEVEL when it names one, else info. */
export const terminalLevel = env => (LEVELS[String(env?.OMM_LOG_LEVEL || '').toLowerCase()] ? String(env.OMM_LOG_LEVEL).toLowerCase() : 'info');

/** A logger for the process `name`. `terminal` prints a line (console.log); `dir` is the logs folder (without it nothing is written to a file). */
export function createLogger({ dir, name, terminal = console.log, env = process.env, clock = () => new Date() }) {
  const shown = LEVELS[terminalLevel(env)];
  let stream = null, streamDay = null;
  const toFile = (level, text, now) => {
    if (!dir) return;
    try {
      const day = dayOf(now);
      if (streamDay !== day) {
        stream?.end();
        fs.mkdirSync(dir, { recursive: true });
        stream = fs.createWriteStream(path.join(dir, `${name}-${day}.log`), { flags: 'a' });
        stream.on('error', () => { /* a log that cannot be written must not stop the app */ });
        streamDay = day;
      }
      stream.write(`${fileLine(now, level, name, text)}\n`);
    } catch { /* not critical */ }
  };
  const write = (level, text) => {
    const now = clock();
    if (LEVELS[level] >= shown) terminal(terminalLine(now, level, name, text));
    toFile(level, text, now);
  };
  const log = (...args) => write('info', textOf(args));
  for (const level of Object.keys(LEVELS)) log[level] = (...args) => write(level, textOf(args));
  log.fileOnly = (level, text) => toFile(level, text, clock()); // for a line that was printed on the terminal already (what another process printed)
  log.close = () => new Promise(resolve => { if (!stream) return resolve(); stream.end(resolve); stream = null; streamDay = null; });
  return log;
}

const logFiles = dir => { try { return fs.readdirSync(dir).filter(f => /\.log(\.|$)/.test(f)).map(f => path.join(dir, f)); } catch { return []; } };

/** Deletes the log files not written to for `days` days. Resolves the names of the files deleted. */
export function pruneLogs(dir, days = KEEP_DAYS, now = new Date()) {
  const gone = [];
  for (const file of logFiles(dir)) {
    try {
      if (now.getTime() - fs.statSync(file).mtimeMs > days * DAY_MS) { fs.rmSync(file, { force: true }); gone.push(path.basename(file)); }
    } catch { /* not critical */ }
  }
  return gone;
}

/** Deletes every log file (OMM_RESET_LOGS). Resolves the names of the files deleted. */
export function resetLogs(dir) {
  const gone = [];
  for (const file of logFiles(dir)) { try { fs.rmSync(file, { force: true }); gone.push(path.basename(file)); } catch { /* not critical */ } }
  return gone;
}

const CONSOLE_LEVELS = { 0: 'debug', 1: 'info', 2: 'warn', 3: 'error', verbose: 'debug', debug: 'debug', info: 'info', warning: 'warn', error: 'error' };

/** What a page's console-message event is, as { level, text }: Electron 35 and later pass one object ({ level, message, lineNumber, sourceId }), before that the arguments
 * were (event, level, message, line, sourceId). `label` is the window. */
export function consoleEntry(args, label) {
  const d = args[0]?.message !== undefined ? args[0] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
  return { level: CONSOLE_LEVELS[d.level] || 'info', text: `(${label}) ${d.message}${d.sourceId ? ` [${d.sourceId}:${d.lineNumber ?? 0}]` : ''}` };
}
