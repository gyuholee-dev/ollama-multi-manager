'use strict';
const path = require('node:path');
const { Menu, Tray, nativeImage } = require('electron');

const LABELS = {
  en: { open: 'Open Ollama Multi Manager', quit: 'Quit' },
  ko: { open: 'Ollama Multi Manager 열기', quit: '종료' },
};
const labelsFor = lang => LABELS[String(lang || '').split('-')[0]] || LABELS.en;

function icon() {
  const dir = path.join(__dirname, 'assets');
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
    img.setTemplateImage(true);  // adapts to the light/dark menu bar; picks up trayTemplate@2x.png on retina
    return img;
  }
  return nativeImage.createFromPath(path.join(dir, 'tray.png'));
}

class AppTray {
  constructor({ onOpen, onQuit, lang }) {
    this.onOpen = onOpen;
    this.onQuit = onQuit;
    this.tray = new Tray(icon());
    this.tray.setToolTip('Ollama Multi Manager');
    this.tray.on('click', onOpen);
    this.setLang(lang);
  }

  setLang(lang) {
    const l = labelsFor(lang);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: l.open, click: this.onOpen },
      { type: 'separator' },
      { label: l.quit, click: this.onQuit },
    ]));
  }

  destroy() { this.tray.destroy(); }
}

module.exports = { AppTray };
