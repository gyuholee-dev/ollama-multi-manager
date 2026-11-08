// Window-move probe: drag the window between displays and read what Electron reports.
//   node_modules/.bin/electron scripts/probe-window-move.js [plain|ours|hidden]
// plain  = a bare BrowserWindow (native title bar)
// ours   = the options the app uses (hidden until ready, background colour, minimum size)
// hidden = no native title bar: traffic lights inset into the page, and the page's own header is the drag region
//          (the way many Electron apps do it; the window is then dragged by Chromium's drag region, not by the system title bar)
const { app, BrowserWindow, screen } = require('electron');
const variant = process.argv.find(a => ['plain', 'ours', 'hidden'].includes(a)) || 'plain';
const t0 = Date.now(), ts = () => String(Date.now() - t0).padStart(6) + ' ms';
const show = d => `display ${d.id} bounds ${JSON.stringify(d.bounds)} scale ${d.scaleFactor}`;

app.whenReady().then(() => {
  console.log(`electron ${process.versions.electron}  chrome ${process.versions.chrome}  variant=${variant}`);
  screen.getAllDisplays().forEach(d => console.log('  ' + show(d)));
  const opts = variant === 'ours'
    ? { width: 580, height: 820, minWidth: 420, minHeight: 360, show: false, backgroundColor: '#1c1c1c', webPreferences: { sandbox: true, contextIsolation: true } }
    : { width: 580, height: 820 };
  if (variant === 'hidden') Object.assign(opts, { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 }, backgroundColor: '#1c1c1c' });
  const win = new BrowserWindow(opts);
  const page = variant === 'hidden'
    ? '<body style="margin:0;font:16px sans-serif;background:#1c1c1c;color:#eee"><div style="-webkit-app-region:drag;height:44px;padding:0 0 0 90px;display:flex;align-items:center">Drag me here</div><p style="padding:0 16px">Drag the header to another display. Watch the terminal.</p>'
    : '<body style="font:16px sans-serif;background:#1c1c1c;color:#eee"><h3>Drag me by the title bar to another display</h3><p>Watch the terminal.</p>';
  win.loadURL('data:text/html,' + encodeURIComponent(page));
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
