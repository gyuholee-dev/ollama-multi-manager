import { useEffect } from 'react';
import { startApp } from '@/app/bootstrap';
import { DialogHost } from '@/containers/DialogHost';
import { Footer } from '@/containers/Footer';
import { Header } from '@/containers/Header';
import { MonitorWindow } from '@/containers/MonitorWindow';
import { Logs } from '@/containers/Logs';
import { Monitor } from '@/containers/Monitor';
import { ServerInstances } from '@/containers/ServerInstances';
import { Summary } from '@/containers/Summary';
import { translate } from '@/locales';
import { useT } from '@/locales/useT';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** `monitor`: show only that instance's monitor (a window of its own) instead of the whole page. */
export default function App({ monitor }: { monitor?: number }) {
  const t = useT();
  const ready = useUiStore((s) => s.ready);
  const theme = useSettingsStore((s) => s.cfg.theme);
  const lang = useSettingsStore((s) => s.cfg.lang);

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
      {ready ? (
        // Until the first load is over only a note is shown, so no empty template and no controls flash by.
        <main><Summary /><Monitor /><ServerInstances /><Logs /></main>
      ) : (
        <div id="boot" role="status">{t('boot.loading')}</div>
      )}
      <Footer />
      <DialogHost />
    </>
  );
}
