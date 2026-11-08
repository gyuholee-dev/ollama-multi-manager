import { useState } from 'react';
import { log } from '@/app/log';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useIsGuest, useMonitorStore } from '@/stores/monitorStore';

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch { // no clipboard permission (plain http page): the old way
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/** The address other devices open to see this page (web access), shown only while that is switched on. */
function Address() {
  const t = useT();
  const info = useMonitorStore((s) => s.info);
  const [pressed, setPressed] = useState(false);
  const web = info?.external_monitoring;
  if (!info || !web?.active) return null;
  const address = `http://${info.lan_ip}:${web.port}`;
  const copy = () => {
    void copyText(address);
    log('Serving address copied');
    setPressed(true);
    setTimeout(() => setPressed(false), 150);
  };
  return (
    <div id="srv" className={pressed ? 'pressed' : undefined} role="button" tabIndex={0} title={t('srv.title', { a: address })}
      onClick={copy} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } }}>
      <code className="d">{address}</code><span className="cp">Copy</span>
    </div>
  );
}

export function Header() {
  const t = useT();
  const guest = useIsGuest();
  const isGuestPage = useMonitorStore((s) => s.info?.guest === true);
  const open = useDialogStore((s) => s.open);
  return (
    <header>
      <h1 id="app-title">Ollama Multi Manager</h1>
      {isGuestPage && <span className="badge" id="gst">{t('guest.badge')}</span>}
      <Address />
      {!guest && (
        <div className="btns">
          <button className="primary" onClick={() => open({ kind: 'new' })} aria-label={t('hdr.new')} title={t('hdr.new')}>
            <i className="material-icons">add</i><span>{t('hdr.new')}</span>
          </button>
          <button onClick={() => open({ kind: 'models' })} aria-label={t('hdr.models')} title={t('hdr.models')}>
            <i className="material-icons">storage</i><span>{t('hdr.models')}</span>
          </button>
          <button onClick={() => open({ kind: 'settings' })} aria-label={t('hdr.settings')} title={t('hdr.settings')}>
            <i className="material-icons">settings</i><span>{t('hdr.settings')}</span>
          </button>
        </div>
      )}
    </header>
  );
}
