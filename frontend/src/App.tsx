import { useEffect } from 'react';
import { startApp } from '@/app/bootstrap';
import { DialogHost } from '@/containers/DialogHost';
import { Footer } from '@/containers/Footer';
import { Header } from '@/containers/Header';
import { MonitorWindow } from '@/containers/MonitorWindow';
import { PageHost } from '@/containers/PageHost';
import { Logs } from '@/containers/Logs';
import { Monitor } from '@/containers/Monitor';
import { ServerInstances } from '@/containers/ServerInstances';
import { Summary } from '@/containers/Summary';
import { translate } from '@/locales';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** `monitor`: show only that instance's monitor (a window of its own) instead of the whole page. */
export default function App({ monitor }: { monitor?: number }) {
  const t = useT();
  const ready = useUiStore((s) => s.ready);
  const theme = useSettingsStore((s) => s.cfg.theme);
  const lang = useSettingsStore((s) => s.cfg.lang);
  const page = useDialogStore((s) => s.page);
  const closePage = useDialogStore((s) => s.close);
  const slide = useDialogStore((s) => s.slide);

  useEffect(() => startApp(), []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang;
    if (!monitor) document.title = translate(lang, 'app.title');
  }, [lang, monitor]);

  if (monitor) {
    return (
      <>
        <main className="mwm"><MonitorWindow id={monitor} /></main>
        <DialogHost />
      </>
    );
  }

  return (
    <>
      <Header />
      {/* the main view and a page (settings, models) side by side: on a narrow window the main view slides out to the left and the page in from the right; on a wide one the page comes in as a panel over the main view (the scrim behind it closes it) */}
      <div className={`views${page ? ' views--page' : ''}${slide ? ' views--slide' : ''}`}>
        <div className="views__scrim" onClick={closePage} />
        <div className="views__track">
          <div className="view" inert={!!page}>
            {ready ? (
              // Until the first load is over only a note is shown, so no empty template and no controls flash by.
              <main><Summary /><Monitor /><ServerInstances /><Logs /></main>
            ) : (
              <div id="boot" role="status">{t('boot.loading')}</div>
            )}
          </div>
          <div className="view" inert={!page}><PageHost /></div>
        </div>
      </div>
      <Footer />
      <DialogHost />
    </>
  );
}
