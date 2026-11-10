'use strict';
// Desktop shell: starts the backend, shows the UI the backend serves, and applies the settings that only
// the shell can apply (tray, launch at login, native theme).
//
// Lifetime policy: the app's running state is the instances' running state. Quitting the app stops the
// backend, which saves each instance's state and stops them; the next launch brings them back.
// "Minimize to tray" is how to keep instances running with the window closed.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell } = require('electron');
const { Backend } = require('./backend-launcher');
const { AppTray } = require('./tray');
const { startMockupServer } = require('./dev-mockup');

const log = (...a) => console.log(new Date().toISOString(), '[shell]', ...a);

// Developer mode: OMM_DEV=1 (or true/yes/on). Works for `yarn start` and for a packaged app alike.
const DEV = /^(1|true|yes|on)$/i.test(process.env.OMM_DEV || '');
// OMM_MOCKUP=1: also serves the design mockup (frontend/mockup) on this PC, independent of developer mode.
const MOCKUP = /^(1|true|yes|on)$/i.test(process.env.OMM_MOCKUP || '');
const MENU_LABEL = {
  ko: { reload: '새로고침', freeze: '화면 갱신 중지', resume: '화면 갱신 재개', inspect: '검사' },
  en: { reload: 'Reload', freeze: 'Pause updates', resume: 'Resume updates', inspect: 'Inspect' },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null, backend = null, tray = null, settings = {}, quitting = false, mockup = null;
  const monitors = new Map(); // instance id -> its monitor window (one per instance)

  // macOS: no system title bar. With macOS 27.2 a window dragged by the system title bar from one display to another
  // is repositioned wrongly (the system loses the start of the move, "Window move completed without beginning"),
  // while a window dragged by a drag region of the page moves correctly. The page draws the header, which is the
  // drag region, and leaves room for the traffic-light buttons. OMM_NATIVE_TITLEBAR=1 brings the system one back.
  const CUSTOM_TITLEBAR = process.platform === 'darwin' && !/^(1|true|yes|on)$/i.test(process.env.OMM_NATIVE_TITLEBAR || '');
  const titleBar = lightsY => (CUSTOM_TITLEBAR ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: lightsY } } : {});
  const webPrefs = () => ({
    preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    additionalArguments: CUSTOM_TITLEBAR ? ['--omm-custom-titlebar'] : [],
  });
  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

  // ---- window state
  // OMM_NO_WINDOW_STATE=1: windows neither remember nor restore their place and size (to tell whether that is behind a
  // problem with moving windows between displays).
  const NO_STATE = /^(1|true|yes|on)$/i.test(process.env.OMM_NO_WINDOW_STATE || '');

  /**
   * Calls `save` when the user has finished moving or resizing the window. It must not run on every step of a drag:
   * asking the window for its geometry and writing a file while macOS is still tracking the mouse makes moving a
   * window between displays stutter and misbehave. macOS and Windows tell when a gesture ends ('moved', 'resized');
   * Linux only has the continuous events, so there a short pause stands for the end.
   */
  function trackBounds(w, save) {
    if (NO_STATE) return;
    let timer = null;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed()) save(); }, 600); };
    if (process.platform === 'linux') { w.on('move', soon); w.on('resize', soon); }
    else { w.on('moved', soon); w.on('resized', soon); }
    w.on('maximize', soon); w.on('unmaximize', soon);
    w.on('close', () => clearTimeout(timer));
  }

  // OMM_DEBUG_WINDOW=1: prints what the window reports while it is moved (for finding out why a window lands in the
  // wrong place after being dragged to another display).
  const DEBUG_WINDOW = /^(1|true|yes|on)$/i.test(process.env.OMM_DEBUG_WINDOW || '');
  function debugWindow(w, label) {
    if (!DEBUG_WINDOW) return;
    let intended = null, moves = 0;
    w.on('will-move', (_e, b) => { intended = b; });
    w.on('move', () => { moves++; });
    w.on('moved', () => {
      const b = w.getBounds(), d = screen.getDisplayMatching(b);
      const jump = intended ? `jump ${b.x - intended.x},${b.y - intended.y} from the last will-move target` : 'no will-move reported';
      log(`[window ${label}] moved to ${b.x},${b.y} ${b.width}x${b.height} on display ${d.id} (scale ${d.scaleFactor}); ${moves} move events; ${jump}`);
      intended = null; moves = 0;
    });
    w.on('maximize', () => log(`[window ${label}] maximize -> ${JSON.stringify(w.getBounds())}`));
    w.on('unmaximize', () => log(`[window ${label}] unmaximize -> ${JSON.stringify(w.getBounds())}`));
  }

  // true when the window's title bar area is still on some display (a display may have been unplugged since)
  const onScreen = s => Number.isFinite(s?.x) && Number.isFinite(s?.y) && screen.getAllDisplays().some(d => {
    const b = d.workArea;
    return s.x < b.x + b.width - 40 && s.x + s.width > b.x + 40 && s.y < b.y + b.height - 40 && s.y + 40 > b.y;
  });
  function loadState() {
    if (NO_STATE) return {};
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      return { ...s, ...(onScreen(s) ? {} : { x: undefined, y: undefined }) };
    } catch { return {}; }
  }
  function saveState() {
    if (NO_STATE || !win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    fs.writeFile(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }), () => { /* not critical */ });
  }
  function saveStateNow() { // while the window closes: the process may end right after
    if (NO_STATE || !win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* not critical */ }
  }

  // The monitor windows remember their place and size, per instance. A window of an instance that has none yet opens
  // where the last monitor window was (shifted a little so it does not hide that one).
  const monitorStateFile = () => path.join(app.getPath('userData'), 'monitor-window-state.json');
  const readMonitorState = () => { try { return JSON.parse(fs.readFileSync(monitorStateFile(), 'utf8')); } catch { return {}; } };
  function saveMonitorState(id, w, sync = false) {
    if (NO_STATE || w.isDestroyed()) return;
    const st = readMonitorState();
    const b = { ...w.getNormalBounds(), maximized: w.isMaximized() };
    st.byId = { ...st.byId, [id]: b };
    st.last = b;
    if (!sync) { fs.writeFile(monitorStateFile(), JSON.stringify(st), e => { if (e) log('Could not save the monitor window state:', e.message); }); return; }
    try { fs.writeFileSync(monitorStateFile(), JSON.stringify(st)); } catch (e) { log('Could not save the monitor window state:', e.message); }
  }
  function monitorBounds(id) {
    if (NO_STATE) return null;
    const st = readMonitorState();
    if (onScreen(st.byId?.[id])) return st.byId[id];
    if (onScreen(st.last)) {
      const shift = 28 * monitors.size; // the windows already open
      const moved = { ...st.last, x: st.last.x + shift, y: st.last.y + shift, maximized: false };
      return onScreen(moved) ? moved : { ...st.last, maximized: false };
    }
    return null;
  }

  // ---- settings only the shell can apply
  function applySettings(s) {
    settings = s;
    nativeTheme.themeSource = ['light', 'dark'].includes(s.theme) ? s.theme : 'system';
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!s.launch_at_login });
    else if (s.launch_at_login) log('Launch at login is only registered by packaged builds');
    if (s.minimize_to_tray && !tray) {
      tray = new AppTray({ onOpen: showWindow, onQuit: () => app.quit(), lang: s.language || app.getLocale() });
      log('Tray enabled');
    } else if (!s.minimize_to_tray && tray) {
      tray.destroy(); tray = null;
      log('Tray disabled');
    }
    tray?.setLang(s.language || app.getLocale());
  }
  async function refreshSettings() {
    try { applySettings(await backend.api('GET', '/settings')); } catch (e) { log('Could not read settings:', e.message); }
  }

  // ---- window
  function showWindow() {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    monitors.forEach(w => { if (!w.isVisible()) w.show(); });
  }

  // The page may only ever be the backend's own UI; everything else opens in the system browser.
  // In developer mode a right-click menu offers reload, pausing the page's live updates, and inspect.
  function guard(w, label = 'main') {
    debugWindow(w, label);
    const isOwn = u => { try { return new URL(u).origin === backend.url; } catch { return false; } };
    const external = u => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    const keepOwn = (e, u) => { if (!isOwn(u)) { e.preventDefault(); external(u); } };
    w.webContents.on('will-navigate', keepOwn);
    w.webContents.on('will-redirect', keepOwn); // a redirect must not take the window away either
    w.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    if (DEV) {
      w.webContents.on('context-menu', async (_e, p) => {
        const l = MENU_LABEL[String(settings.language || app.getLocale()).slice(0, 2)] || MENU_LABEL.en;
        const frozen = await w.webContents.executeJavaScript('window.__omm?.isFrozen() === true').catch(() => false);
        Menu.buildFromTemplate([
          { label: l.reload, click: () => w.webContents.reload() },
          { label: frozen ? l.resume : l.freeze, click: () => w.webContents.executeJavaScript(`window.__omm?.setFrozen(${!frozen})`) },
          { label: l.inspect, click: () => w.webContents.inspectElement(p.x, p.y) },
        ]).popup({ window: w });
      });
    }
  }

  // One monitor window per instance: a second request for the same instance brings the first to the front.
  function openMonitor(id) {
    if (!backend || !Number.isInteger(id) || id < 1) return;
    const open = monitors.get(id);
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore();
      open.show(); open.focus();
      return;
    }
    const saved = monitorBounds(id);
    const w = new BrowserWindow({
      width: saved?.width || 480, height: saved?.height || 820, x: saved?.x, y: saved?.y, minWidth: 420, minHeight: 360, show: false, title: 'Ollama Multi Manager',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#ebebeb', ...titleBar(16),
      webPreferences: webPrefs(),
    });
    monitors.set(id, w);
    w.once('ready-to-show', () => { w.show(); if (saved?.maximized) w.maximize(); }); // maximized only once it is on screen
    trackBounds(w, () => saveMonitorState(id, w));
    w.on('close', () => saveMonitorState(id, w, true));
    w.loadURL(`${backend.url}/#token=${backend.token}&monitor=${id}`);
    guard(w, `monitor ${id}`);
    w.on('closed', () => { if (monitors.get(id) === w) monitors.delete(id); });
  }
  const closeMonitors = () => { monitors.forEach(w => { if (!w.isDestroyed()) w.close(); }); monitors.clear(); };

  function createWindow() {
    const st = loadState();
    win = new BrowserWindow({
      width: st.width || 1100, height: st.height || 760, x: st.x, y: st.y, minWidth: 480, minHeight: 480,
      show: false, title: 'Ollama Multi Manager', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#ebebeb', ...titleBar(16),
      webPreferences: webPrefs(),
    });
    win.once('ready-to-show', () => { win.show(); if (st.maximized) win.maximize(); }); // maximized only once it is on screen
    win.loadURL(`${backend.url}/#token=${backend.token}`);

    guard(win);

    trackBounds(win, saveState);
    win.on('close', e => {
      saveStateNow();
      if (!quitting && settings.minimize_to_tray && tray) { e.preventDefault(); win.hide(); monitors.forEach(w => w.hide()); }
    });
    win.on('closed', () => { win = null; closeMonitors(); });
  }

  // ---- IPC
  // Only the backend's own UI may talk to the shell: a frame that came from anywhere else is ignored.
  const fromUi = e => { try { return new URL(e.senderFrame.url).origin === backend.url; } catch { return false; } };
  // where the picker opens: the path now in the field (or the nearest folder above it that exists), else the home directory
  const startPath = current => {
    let p = String(current || '').trim();
    if (p.startsWith('~')) p = path.join(app.getPath('home'), p.slice(1));
    while (p && path.isAbsolute(p) && !fs.existsSync(p)) {
      const up = path.dirname(p);
      if (up === p) { p = ''; break; }
      p = up;
    }
    return p && path.isAbsolute(p) ? p : app.getPath('home');
  };
  ipcMain.handle('pick-path', async (e, kind, current) => {
    if (!fromUi(e)) return null;
    const r = await dialog.showOpenDialog(win, {
      defaultPath: startPath(current),
      properties: kind === 'dir' ? ['openDirectory', 'createDirectory'] : ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('settings-changed', e => { if (fromUi(e)) refreshSettings(); });
  ipcMain.on('open-monitor', (e, id) => { if (fromUi(e)) openMonitor(Number(id)); });

  // ---- lifecycle
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', e => e.preventDefault()));

  app.on('before-quit', e => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    mockup?.close();
    log('Quitting: stopping the backend (this stops the instances)');
    backend.stop().catch(err => log('Backend stop failed:', err.message)).finally(() => app.quit());
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', e => e.preventDefault()); // no <webview>: it would be a second page with its own rights
  });

  app.whenReady().then(async () => {
    backend = new Backend({ dataDir: app.getPath('userData'), isPackaged: app.isPackaged, log });
    backend.onCrash = (code, sig) => {
      if (quitting) return;
      dialog.showErrorBox('Ollama Multi Manager', `The backend stopped unexpectedly (code ${code}, signal ${sig}).\n\n${backend.tailLog()}`);
      quitting = true;
      app.quit();
    };
    try {
      await backend.start();
    } catch (e) {
      log('Backend start failed:', e.message);
      dialog.showErrorBox('Ollama Multi Manager', e.message);
      quitting = true;
      app.exit(1);
      return;
    }
    log(`Backend ready on ${backend.url}`);
    // The app uses no camera, microphone, location, notifications or the like: every permission request is refused,
    // except copying text to the clipboard (the address and key buttons).
    const allowed = permission => permission === 'clipboard-sanitized-write';
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    if (DEV) {
      log('Developer mode is on (OMM_DEV)');
    }
    if (MOCKUP) mockup = await startMockupServer({ dir: path.join(__dirname, '..', 'frontend', 'mockup'), log });
    await refreshSettings();
    createWindow();
  });
}
