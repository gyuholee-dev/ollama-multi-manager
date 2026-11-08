import { useEffect } from 'react';
import { useViews } from '@/app/hooks';
import { CategoryButtons, MonitorBody } from '@/containers/MonitorBody';
import { translate } from '@/locales';
import { useT } from '@/locales/useT';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

const CLOSE_AFTER_MS = 2500;

/** One instance's monitor on a page of its own (opened with #monitor=<id>): the header stays, the body below scrolls. */
export function MonitorWindow({ id }: { id: number }) {
  const t = useT();
  const lang = useSettingsStore((s) => s.cfg.lang);
  const ready = useUiStore((s) => s.ready);
  const view = useViews().find((v) => v.id === id);
  const gone = ready && !view;

  useEffect(() => {
    document.title = view ? translate(lang, 'im.title', { n: view.name }) : translate(lang, 'app.title');
  }, [lang, view?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(() => window.close(), CLOSE_AFTER_MS); // the instance was deleted
    return () => clearTimeout(timer);
  }, [gone]);

  const note = (text: string) => (
    <div id="det" className="mwin">
      <div className="dh"><h3>{t('app.title')}</h3></div>
      <div id="boot" role="status">{text}</div>
    </div>
  );
  if (!ready) return note(t('boot.loading'));
  if (!view) return note(t('im.removed'));
  // laid out and styled like the dialogs: a header (title and category buttons) that stays, and a body that scrolls
  return (
    <div id="det" className="mwin">
      <div className="dh">
        <h3>{t('im.title', { n: view.name })}</h3>
        <div className="btns"><CategoryButtons /></div>
      </div>
      <div className="dbody"><MonitorBody id={id} view={view} /></div>
    </div>
  );
}
