import type { ReactNode } from 'react';
import { useT } from '@/locales/useT';
import { useUiStore } from '@/stores/uiStore';

/** A sub-section of the instance monitor window: its header opens and closes it, and the choice is remembered. */
export function Collapse({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const t = useT();
  const folded = useUiStore((s) => s.imFold.includes(id));
  const toggle = useUiStore((s) => s.toggleImFold);
  return (
    <div className="cat nc">
      <label className="ch"><b>{title}</b>
        <input type="checkbox" className="cc" aria-label={t('new.toggle', { n: title })} checked={!folded} onChange={() => toggle(id)} />
        <span className="tog"><span className="material-icons">expand_more</span></span>
      </label>
      <div className="cb"><div><div className="card" style={{ marginTop: 8, padding: 14 }}>{children}</div></div></div>
    </div>
  );
}
