'use strict';
// Ctrl+C for a launcher script (yarn start, yarn start:dev).
//
// A terminal sends Ctrl+C as SIGINT to the whole foreground group. yarn dies on the spot, so the shell shows its prompt
// again while the launcher and the app are still shutting down, and what they print then lands on the prompt line.
// So with a terminal the launcher takes Ctrl+C over: the terminal is put in raw mode, where Ctrl+C is only a key (no
// signal), and the launcher stops its children itself. yarn stays until the launcher is done, so everything the app
// prints while it stops is shown before the prompt. A second Ctrl+C ends the launcher at once.

/** Calls `stop` on Ctrl+C (and on SIGINT/SIGTERM from elsewhere, which is all there is without a terminal). */
function onInterrupt(stop) {
  let pressed = 0;
  const handler = () => {
    if (++pressed > 1) {
      restore();
      process.exit(130);
    }
    stop();
  };
  const restore = () => {
    try { process.stdin.setRawMode(false); } catch { /* not a terminal */ }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', chunk => { if (chunk.includes(3)) handler(); }); // 3 = ETX, what Ctrl+C types in raw mode
    process.on('exit', restore);
  }
}

module.exports = { onInterrupt };
