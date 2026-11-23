import { useEffect, useState } from 'react';
import { closePanel } from '@/app/monitorActions';
import { useIsGuest } from '@/stores/monitorStore';
import { useDialogStore, type Page } from '@/stores/dialogStore';
import { pageHandledBack } from './pageBack';
import { MonitorPanel } from './MonitorPanel';
import { ModelsPage } from './pages/ModelsPage';
import { SettingsPage } from './pages/SettingsPage';

const SLIDE_MS = 320; // a little more than the .3s of the slide in _views.scss

/**
 * The page the main view has slid over to (settings or models). It is kept until it has slid out of view again,
 * and in the look of the dialogs (.mwin). Escape goes back, unless a popup or a dialog is open; a page can take it first (usePageBack).
 */
export function PageHost({ monitorAsPage = null }: { monitorAsPage?: number | null }) {
  const pageStored = useDialogStore((s) => s.page);
  const page: Page | 'monitor' | null = pageStored ?? (monitorAsPage != null ? 'monitor' : null); // (on a narrow screen the monitor takes the place of a page)
  const close = useDialogStore((s) => s.close);
  const guest = useIsGuest();
  const [kept, setKept] = useState<Page | 'monitor' | null>(page);
  const [keptMonitor, setKeptMonitor] = useState<number | null>(monitorAsPage);
  useEffect(() => {
    if (page) { setKept(page); if (monitorAsPage != null) setKeptMonitor(monitorAsPage); return; }
    const timer = setTimeout(() => setKept(null), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [page, monitorAsPage]);
  useEffect(() => {
    if (!page) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useDialogStore.getState().popup || useDialogStore.getState().active) return;
      if (kept === 'monitor') closePanel();
      else if (!pageHandledBack()) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, close, kept]);
  if (!kept) return null;
  if (kept === 'monitor') return keptMonitor == null ? null : <main className="mwm"><MonitorPanel id={keptMonitor} asPage /></main>;
  if (guest) return null;
  return (
    // (<main class="mwm"> is only there so that the page's button styles, which look for <main>, apply: it has no box of its own)
    <main className="mwm">
      <div className="mwin page">
        {kept === 'models' ? <ModelsPage key="models" /> : <SettingsPage key="settings" />}
      </div>
    </main>
  );
}
