import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useIsGuest, useMonitorStore } from '@/stores/monitorStore';

export function Header() {
  const t = useT();
  const guest = useIsGuest();
  const isGuestPage = useMonitorStore((s) => s.info?.guest === true);
  const open = useDialogStore((s) => s.open);
  return (
    <header>
      <h1 id="app-title">Ollama Multi Manager</h1>
      {isGuestPage && <span className="badge" id="gst">{t('guest.badge')}</span>}
      {!guest && (
        <div className="btns">
          <button onClick={() => open({ kind: 'new' })} aria-label={t('hdr.new')} title={t('hdr.new')}>
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
