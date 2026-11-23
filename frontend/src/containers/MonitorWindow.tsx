import { useEffect } from 'react';
import { mergeMonitor } from '@/app/monitorActions';
import { useViews } from '@/app/hooks';
import { Icon } from '@/components/common/Icon';
import { canMergeMonitor } from '@/desktop';
import { MonitorFrame } from '@/containers/MonitorFrame';
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
    if (view) document.title = translate(lang, 'im.title', { n: view.name }); // (until it is known the page keeps the title it came with)
  }, [lang, view?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(() => window.close(), CLOSE_AFTER_MS); // the instance was deleted
    return () => clearTimeout(timer);
  }, [gone]);

  // "Merge": back into the panel of the main window
  const merge = canMergeMonitor()
    ? <button type="button" className="inline" aria-label={t('im.merge')} title={t('im.merge')} onClick={() => mergeMonitor(id)}><Icon name="vertical_split" /></button>
    : null;
  return <MonitorFrame id={id} view={view} ready={ready} removed={t('im.removed')} buttons={merge} />;
}
