import { useState, type ReactNode } from 'react';

/** A section of a form that opens and closes (closed at first). */
export function Fold({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cat nc">
      <label className="ch"><span className="ti">{title}</span>
        <input type="checkbox" className="cc" aria-label={hint} checked={open} onChange={(e) => setOpen(e.target.checked)} />
        <span className="tog"><span className="material-icons">expand_more</span></span>
      </label>
      <div className="cb"><div><div className="card" style={{ marginTop: 8, padding: 14 }}>{children}</div></div></div>
    </div>
  );
}
