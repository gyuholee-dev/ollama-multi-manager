'use strict';
// Desktop shell: starts the backend, shows the UI the backend serves, and applies the settings that only
// the shell can apply (tray, launch at login, native theme).
//
// Lifetime policy: the app's running state is the instances' running state. Quitting the app stops the
// backend, which saves each instance's state and stops them; the next launch brings them back.
// "Minimize to tray" is how to keep instances running with the window closed.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, shell } = require('electron');
const { Backend } = require('./backend-launcher');
const { AppTray } = require('./tray');

const log = (...a) => console.log(new Date().toISOString(), '[shell]', ...a);

// Developer mode: OMM_DEV=1 (or true/yes/on). Works for `yarn start` and for a packaged app alike.
const DEV = /^(1|true|yes|on)$/i.test(process.env.OMM_DEV || '');
const MENU_LABEL = {
  ko: { reload: '새로고침', freeze: '화면 갱신 중지', resume: '화면 갱신 재개', inspect: '검사' },
  en: { reload: 'Reload', freeze: 'Pause updates', resume: 'Resume updates', inspect: 'Inspect' },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null, backend = null, tray = null, settings = {}, quitting = false;
  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

  // ---- window state
  function loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      const visible = screen.getAllDisplays().some(d => {
        const b = d.workArea;
        return s.x < b.x + b.width - 40 && s.x + s.width > b.x + 40 && s.y < b.y + b.height - 40 && s.y + 40 > b.y;
      });
      return { ...s, ...(visible ? {} : { x: undefined, y: undefined }) };
    } catch { return {}; }
  }
  function saveState() {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* not critical */ }
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
  }

  function createWindow() {
    const st = loadState();
    win = new BrowserWindow({
      width: st.width || 1100, height: st.height || 760, x: st.x, y: st.y, minWidth: 480, minHeight: 480,
      show: false, title: 'Ollama Multi Manager', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#ebebeb',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    if (st.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.loadURL(`${backend.url}/#token=${backend.token}`);

    // The page may only ever be the backend's own UI; everything else opens in the system browser.
    const isOwn = u => { try { return new URL(u).origin === backend.url; } catch { return false; } };
    const external = u => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    win.webContents.on('will-navigate', (e, u) => { if (!isOwn(u)) { e.preventDefault(); external(u); } });
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });

    if (DEV) {
      win.webContents.on('context-menu', async (_e, p) => {
        const l = MENU_LABEL[String(settings.language || app.getLocale()).slice(0, 2)] || MENU_LABEL.en;
        const frozen = await win.webContents.executeJavaScript('window.__omm?.isFrozen() === true').catch(() => false);
        Menu.buildFromTemplate([
          { label: l.reload, click: () => win.webContents.reload() },
          { label: frozen ? l.resume : l.freeze, click: () => win.webContents.executeJavaScript(`window.__omm?.setFrozen(${!frozen})`) },
          { label: l.inspect, click: () => win.webContents.inspectElement(p.x, p.y) },
        ]).popup({ window: win });
      });
    }

    win.on('resize', saveState);
    win.on('move', saveState);
    win.on('close', e => {
      saveState();
      if (!quitting && settings.minimize_to_tray && tray) { e.preventDefault(); win.hide(); }
    });
    win.on('closed', () => { win = null; });
  }

  // ---- IPC
  ipcMain.handle('pick-path', async (_e, kind) => {
    const r = await dialog.showOpenDialog(win, { properties: kind === 'dir' ? ['openDirectory', 'createDirectory'] : ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('settings-changed', () => refreshSettings());

  // ---- lifecycle
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', e => e.preventDefault()));

  app.on('before-quit', e => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    log('Quitting: stopping the backend (this stops the instances)');
    backend.stop().catch(err => log('Backend stop failed:', err.message)).finally(() => app.quit());
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
    if (DEV) log('Developer mode is on (OMM_DEV)');
    await refreshSettings();
    createWindow();
  });
}
