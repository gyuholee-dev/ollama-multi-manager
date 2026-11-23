'use strict';
// The only bridge between the page and the desktop shell. The page has no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omm', {
  desktop: true,
  // the shell hides the system title bar (macOS); the page's header is then the drag region and leaves room for the buttons
  customTitleBar: process.argv.includes('--omm-custom-titlebar'),
  // Windows: the shell draws only the three window buttons over the right end of the page's header
  // the height of the header row the shell sized its window buttons for (px); the page takes it as --header-h
  headerHeight: Number((process.argv.find(a => a.startsWith('--omm-header-height=')) || '').split('=')[1]) || 0,
  overlayTitleBar: process.argv.includes('--omm-titlebar-overlay'),
  // 'file' | 'dir' (+ the path now in the field, where the dialog opens) -> chosen path, or null when cancelled
  pickPath: (kind, current) => ipcRenderer.invoke('pick-path', kind === 'dir' ? 'dir' : 'file', typeof current === 'string' ? current : ''),
  // tell the shell that settings changed so it can apply tray / login / theme
  settingsChanged: () => ipcRenderer.send('settings-changed'),
  // open an instance's monitor in a window of its own (`dock`: 'left' or 'right' when it is detached from the panel on that side)
  openMonitor: (id, dock) => ipcRenderer.send('open-monitor', Number(id), dock),
  // the monitor panel of the main window: the page tells which monitor it shows; a monitor window is merged into it
  panelShows: id => ipcRenderer.send('monitor-panel-changed', id == null ? null : Number(id)),
  mergeMonitor: id => ipcRenderer.send('merge-monitor', Number(id)),
  onShowPanel: callback => {
    const handler = (_event, id) => callback(Number(id));
    ipcRenderer.on('show-monitor-panel', handler);
    return () => ipcRenderer.removeListener('show-monitor-panel', handler);
  },
});
