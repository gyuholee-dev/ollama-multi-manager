import { useState, type ReactNode } from 'react';

/** A section of a form that opens and closes (closed at first). */
export function Fold({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fold">
      <label className="fold__head"><span className="fold__title">{title}</span>
        <input type="checkbox" className="fold__check" aria-label={hint} checked={open} onChange={(e) => setOpen(e.target.checked)} />
        <span className="material-icons fold__icon">expand_more</span>
      </label>
      <div className="fold__panel"><div className="fold__inner"><div className="card fold__card">{children}</div></div></div>
    </div>
  );
}
