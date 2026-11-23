import { useEffect } from 'react';
import { closePanel, detachMonitor } from '@/app/monitorActions';
import { useViews } from '@/app/hooks';
import { Icon } from '@/components/common/Icon';
import { MonitorFrame } from '@/containers/MonitorFrame';
import { panelShows } from '@/desktop';
import { useT } from '@/locales/useT';
import { useUiStore } from '@/stores/uiStore';

const CLOSE_AFTER_MS = 2500;

/**
 * The monitor of an instance in the main window: a panel beside the main view (the width of a monitor window), or, where there is no room beside it,
 * a page over it (`asPage`: without the detach button, which needs a window of its own). Both close when the instance is deleted.
 */
export function MonitorPanel({ id, asPage = false }: { id: number; asPage?: boolean }) {
  const t = useT();
  const ready = useUiStore((s) => s.ready);
  const view = useViews().find((v) => v.id === id);
  const gone = ready && !view;
  const side = useUiStore((s) => s.panelSide);

  // the shell is told what the panel shows (its screenshots for the MCP server look for the monitor there)
  // (only the panel tells: the page the monitor becomes on a narrow screen is kept a moment while it slides out, and must not take back what a new panel said)
  useEffect(() => {
    if (asPage) return;
    panelShows(id);
    return () => panelShows(null);
  }, [id, asPage]);
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(closePanel, CLOSE_AFTER_MS); // the instance was deleted
    return () => clearTimeout(timer);
  }, [gone]);

  const buttons = (
    <>
      {!asPage && <button type="button" className="inline" aria-label={t('im.side')} title={t('im.side')} onClick={() => useUiStore.getState().setPanelSide(side === 'left' ? 'right' : 'left')}><Icon name="swap_horiz" /></button>}
      {!asPage && <button type="button" className="inline" aria-label={t('im.detach')} title={t('im.detach')} onClick={() => detachMonitor(id)}><Icon name="open_in_new" /></button>}
      <button type="button" className="inline" aria-label={t('btn.close')} title={t('btn.close')} onClick={closePanel}><Icon name="close" /></button>
    </>
  );
  return <MonitorFrame id={id} view={view} ready={ready} removed={t('im.removedPanel')} buttons={buttons} embedded />;
}
