import { useId } from 'react';
import { useT } from '@/locales/useT';
import { useUiStore } from '@/stores/uiStore';
import type { ReactNode } from 'react';

/** A sub-section of the instance monitor in the dialog: a row of the form look that opens and closes it, and the choice is remembered. */
/** `tools`: buttons in the header, before the arrow. The label names its checkbox (`htmlFor`): without that, a click on the title would press the first button instead, as buttons are labelable too. */
export function Collapse({ id, title, tools, children }: { id: string; title: string; tools?: ReactNode; children: ReactNode }) {
  const t = useT();
  const folded = useUiStore((s) => s.imFold.includes(id));
  const toggle = useUiStore((s) => s.toggleImFold);
  const check = useId();
  return (
    <div className="fold">
      <label className="fold__head" htmlFor={check}><span className="fold__title">{title}</span>
        {tools && <span className="fold__tools">{tools}</span>}
        <input id={check} type="checkbox" className="fold__check" aria-label={t('new.toggle', { n: title })} checked={!folded} onChange={() => toggle(id)} />
        <span className="material-icons fold__icon">expand_more</span>
      </label>
      <div className="fold__panel"><div className="fold__inner"><div className="card fold__card">{children}</div></div></div>
    </div>
  );
}
