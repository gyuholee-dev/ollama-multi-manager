import { useEffect } from 'react';
import { startApp } from '@/app/bootstrap';
import { openPanel } from '@/app/monitorActions';
import { onShowPanel } from '@/desktop';
import { usePanelFits } from '@/lib/panel';
import { DialogHost } from '@/containers/DialogHost';
import { Footer } from '@/containers/Footer';
import { Header } from '@/containers/Header';
import { MonitorPanel } from '@/containers/MonitorPanel';
import { MonitorWindow } from '@/containers/MonitorWindow';
import { PageHost } from '@/containers/PageHost';
import { Logs } from '@/containers/Logs';
import { Monitor } from '@/containers/Monitor';
import { ServerInstances } from '@/containers/ServerInstances';
import { Summary } from '@/containers/Summary';
import { translate } from '@/locales';
import { useDialogStore } from '@/stores/dialogStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** `monitor`: show only that instance's monitor (a window of its own) instead of the whole page. */
export default function App({ monitor }: { monitor?: number }) {
  const ready = useUiStore((s) => s.ready);
  const panelSide = useUiStore((s) => s.panelSide);
  const theme = useSettingsStore((s) => s.cfg.theme);
  const lang = useSettingsStore((s) => s.cfg.lang);
  const page = useDialogStore((s) => s.page);
  const closePage = useDialogStore((s) => s.close);
  const slide = useDialogStore((s) => s.slide);
  const monitorShown = useDialogStore((s) => s.monitor);
  const fits = usePanelFits();
  // the monitor of an instance in the main window: a panel beside the main view where there is room for it, else a page over the main view
  const panelId = fits ? monitorShown : null;
  const monitorPageId = fits ? null : monitorShown;

  useEffect(() => startApp(), []);
  // a monitor window merged into the panel (by the shell, or from a popup of this page): the panel is the way monitors open from now on
  useEffect(() => monitor ? undefined : onShowPanel((id) => { useUiStore.getState().setMonitorMode('panel'); openPanel(id); }), [monitor]);
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

  const panel = panelId != null && <aside className={`mpanel mpanel--${panelSide}`}><main className="mwm"><MonitorPanel id={panelId} /></main></aside>;

  return (
    <>
      <Header />
      {/* the main view and a page (settings, models) side by side: on a narrow window the main view slides out to the left and the page in from the right; on a wide one the page comes in as a panel over the main view (the scrim behind it closes it) */}
      <div className="workspace">
        {panelId != null && panelSide === 'left' && panel}
        <div className={`views${page || monitorPageId != null ? ' views--page' : ''}${slide ? ' views--slide' : ''}`}>
          <div className="views__scrim" onClick={closePage} />
          <div className="views__track">
            <div className="view" inert={!!page || monitorPageId != null}>
              {/* Until the first load is over nothing is shown (no loading note for now), so no empty template and no controls flash by. */}
              {ready ? <main><Summary /><Monitor /><ServerInstances /><Logs /></main> : null}
            </div>
            <div className="view" inert={!page && monitorPageId == null}><PageHost monitorAsPage={monitorPageId} /></div>
          </div>
        </div>
        {/* the monitor panel: beside the main view, not over it, on the side the user chose; a page (settings) opens over the main view only */}
        {panelId != null && panelSide === 'right' && panel}
      </div>
      <Footer />
      <DialogHost />
    </>
  );
}
