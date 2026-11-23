import { useEffect } from 'react';
import { closePanel, detachMonitor } from '@/app/monitorActions';
import { useViews } from '@/app/hooks';
import { Icon } from '@/components/common/Icon';
import { usePanelFull } from '@/lib/panel';
import { MonitorFrame } from '@/containers/MonitorFrame';
import { panelShows } from '@/desktop';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useUiStore } from '@/stores/uiStore';

const CLOSE_AFTER_MS = 2500;

/**
 * The monitor of an instance in the main window: a panel beside the main view, or, in a viewport narrower than 768, a panel that covers it (then without the buttons that move it
 * to the other side and detach it, which have no meaning there). It closes when the instance is deleted, and on Escape where it covers the main view.
 */
export function MonitorPanel({ id }: { id: number }) {
  const t = useT();
  const ready = useUiStore((s) => s.ready);
  const side = useUiStore((s) => s.panelSide);
  const full = usePanelFull();
  const view = useViews().find((v) => v.id === id);
  const gone = ready && !view;

  // the shell is told what the panel shows (its screenshots for the MCP server look for the monitor there)
  useEffect(() => {
    panelShows(id);
    return () => panelShows(null);
  }, [id]);
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(closePanel, CLOSE_AFTER_MS); // the instance was deleted
    return () => clearTimeout(timer);
  }, [gone]);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useDialogStore.getState().popup && !useDialogStore.getState().active) closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const buttons = (
    <>
      {!full && <button type="button" className="inline" aria-label={t('im.side')} title={t('im.side')} onClick={() => useUiStore.getState().setPanelSide(side === 'left' ? 'right' : 'left')}><Icon name="swap_horiz" /></button>}
      {!full && <button type="button" className="inline" aria-label={t('im.detach')} title={t('im.detach')} onClick={() => detachMonitor(id)}><Icon name="open_in_new" /></button>}
      <button type="button" className="inline" aria-label={t('btn.close')} title={t('btn.close')} onClick={closePanel}><Icon name="close" /></button>
    </>
  );
  return <MonitorFrame id={id} view={view} ready={ready} removed={t('im.removedPanel')} buttons={buttons} embedded />;
}
