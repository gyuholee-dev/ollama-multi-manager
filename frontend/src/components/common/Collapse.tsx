import type { ReactNode } from 'react';
import { useT } from '@/locales/useT';
import { useUiStore } from '@/stores/uiStore';

/**
 * A sub-section of the instance monitor (window and dialog): a row of the form look that opens and closes it, and the choice is remembered.
 * `fixed` makes it a plain part that is always open: the title only, no arrow, nothing to click. `boxed` keeps the panel (the box) of its content
 * in the monitor window, where the other parts have none.
 */
export function Collapse({ id, title, fixed, boxed, children }: { id: string; title: string; fixed?: boolean; boxed?: boolean; children: ReactNode }) {
  const t = useT();
  const folded = useUiStore((s) => s.imFold.includes(id));
  const toggle = useUiStore((s) => s.toggleImFold);
  return (
    <div className={`fold${fixed ? ' fold--fixed' : ''}${boxed ? ' fold--boxed' : ''}`}>
      {fixed ? <div className="fold__head"><span className="fold__title">{title}</span></div> : (
        <label className="fold__head"><span className="fold__title">{title}</span>
          <input type="checkbox" className="fold__check" aria-label={t('new.toggle', { n: title })} checked={!folded} onChange={() => toggle(id)} />
          <span className="material-icons fold__icon">expand_more</span>
        </label>
      )}
      <div className="fold__panel"><div className="fold__inner"><div className="card fold__card">{children}</div></div></div>
    </div>
  );
}
