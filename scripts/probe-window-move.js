// Window-move probe: drag the window between displays and read what Electron reports.
//   node_modules/.bin/electron scripts/probe-window-move.js [plain|ours]
// plain = a bare BrowserWindow; ours = the options the app uses (hidden until ready, background colour, minimum size).
const { app, BrowserWindow, screen } = require('electron');
const variant = process.argv.find(a => ['plain', 'ours'].includes(a)) || 'plain';
const t0 = Date.now(), ts = () => String(Date.now() - t0).padStart(6) + ' ms';
const show = d => `display ${d.id} bounds ${JSON.stringify(d.bounds)} scale ${d.scaleFactor}`;

app.whenReady().then(() => {
  console.log(`electron ${process.versions.electron}  chrome ${process.versions.chrome}  variant=${variant}`);
  screen.getAllDisplays().forEach(d => console.log('  ' + show(d)));
  const opts = variant === 'ours'
    ? { width: 580, height: 820, minWidth: 420, minHeight: 360, show: false, backgroundColor: '#1c1c1c', webPreferences: { sandbox: true, contextIsolation: true } }
    : { width: 580, height: 820 };
  const win = new BrowserWindow(opts);
  win.loadURL('data:text/html,<body style="font:16px sans-serif;background:%231c1c1c;color:%23eee"><h3>Drag me by the title bar to another display</h3><p>Watch the terminal.</p>');
  if (variant === 'ours') win.once('ready-to-show', () => win.show());
  let intended = null, moves = 0;
  win.on('will-move', (_e, b) => { intended = b; });
  win.on('move', () => { moves++; });
  win.on('moved', () => {
    const b = win.getBounds(), d = screen.getDisplayMatching(b);
    const off = intended ? `  (last will-move target ${intended.x},${intended.y} -> jump ${b.x - intended.x},${b.y - intended.y})` : '  (no will-move was reported)';
    console.log(`${ts()} moved: ${b.x},${b.y} ${b.width}x${b.height} on display ${d.id} scale ${d.scaleFactor}, ${moves} move events${off}`);
    intended = null; moves = 0;
  });
  win.on('maximize', () => console.log(`${ts()} maximize -> ${JSON.stringify(win.getBounds())}`));
  win.on('unmaximize', () => console.log(`${ts()} unmaximize -> ${JSON.stringify(win.getBounds())}`));
  win.on('closed', () => app.quit());
});
