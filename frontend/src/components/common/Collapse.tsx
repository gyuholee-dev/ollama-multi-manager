import type { ReactNode } from 'react';
import { useT } from '@/locales/useT';
import { useUiStore } from '@/stores/uiStore';

/** A sub-section of the instance monitor window: its header opens and closes it, and the choice is remembered. */
export function Collapse({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const t = useT();
  const folded = useUiStore((s) => s.imFold.includes(id));
  const toggle = useUiStore((s) => s.toggleImFold);
  return (
    <div className="fold fold--pill">
      <label className="fold__head"><span className="fold__title">{title}</span>
        <input type="checkbox" className="fold__check" aria-label={t('new.toggle', { n: title })} checked={!folded} onChange={() => toggle(id)} />
        <span className="material-icons fold__icon">expand_more</span>
      </label>
      <div className="fold__panel"><div className="fold__inner"><div className="card fold__card">{children}</div></div></div>
    </div>
  );
}
