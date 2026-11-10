'use strict';
// The only bridge between the page and the desktop shell. The page has no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omm', {
  desktop: true,
  // the shell hides the system title bar (macOS); the page's header is then the drag region and leaves room for the buttons
  customTitleBar: process.argv.includes('--omm-custom-titlebar'),
  // 'file' | 'dir' (+ the path now in the field, where the dialog opens) -> chosen path, or null when cancelled
  pickPath: (kind, current) => ipcRenderer.invoke('pick-path', kind === 'dir' ? 'dir' : 'file', typeof current === 'string' ? current : ''),
  // tell the shell that settings changed so it can apply tray / login / theme
  settingsChanged: () => ipcRenderer.send('settings-changed'),
  // open an instance's monitor in a window of its own
  openMonitor: id => ipcRenderer.send('open-monitor', Number(id)),
});
