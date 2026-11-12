import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useIsGuest, useMonitorStore } from '@/stores/monitorStore';

export function Header() {
  const t = useT();
  const guest = useIsGuest();
  const isGuestPage = useMonitorStore((s) => s.info?.guest === true);
  const open = useDialogStore((s) => s.open);
  const page = useDialogStore((s) => s.page);
  const close = useDialogStore((s) => s.close);
  const active = useDialogStore((s) => s.active?.kind);
  // a page button slides to its page, and goes back to the main view when its page is the one in view
  const toggle = (target: 'models' | 'settings') => (page === target ? close() : open({ kind: target }));
  return (
    <header>
      <h1 id="app-title">Ollama Multi Manager</h1>
      {isGuestPage && <span className="badge" id="gst">{t('guest.badge')}</span>}
      {!guest && (
        <div className="btns">
          <button className={active === 'new' ? 'on' : undefined} onClick={() => open({ kind: 'new' })} aria-label={t('hdr.new')} title={t('hdr.new')}>
            <i className="material-icons">add</i><span>{t('hdr.new')}</span>
          </button>
          <button className={page === 'models' ? 'on' : undefined} onClick={() => toggle('models')} aria-label={t('hdr.models')} title={t('hdr.models')}>
            <i className="material-icons">storage</i><span>{t('hdr.models')}</span>
          </button>
          <button className={page === 'settings' ? 'on' : undefined} onClick={() => toggle('settings')} aria-label={t('hdr.settings')} title={t('hdr.settings')}>
            <i className="material-icons">settings</i><span>{t('hdr.settings')}</span>
          </button>
        </div>
      )}
    </header>
  );
}
