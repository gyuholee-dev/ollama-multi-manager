import type { ReactNode } from 'react';
import { MonitorBody } from '@/containers/MonitorBody';
import type { InstanceView } from '@/lib/derive';

/**
 * The monitor of one instance: a header (the name on the left, `buttons` on the right) that stays while the body below scrolls. It is the same in a window of
 * its own, in the panel beside the main view and in the page a narrow screen shows it as; only the buttons differ.
 * `embedded`: it sits in the main window, under the main header, so its header does not keep the left end free for the window's buttons.
 * `view` is undefined until the instance is known (or when it is gone: `removed` then says so, once `ready`).
 */
export function MonitorFrame({ id, view, ready, removed, buttons, embedded = false }: { id: number; view?: InstanceView; ready: boolean; removed: string; buttons?: ReactNode; embedded?: boolean }) {
  const cls = embedded ? 'mwin mwin--embedded' : 'mwin'; // embedded (in the main window, under its header): no room to keep free for the window buttons
  const note = (text?: string) => (
    <div id="det" className={cls}>
      <header className="mwh"><h1 /><div className="btns">{buttons}</div></header> {/* (no title until the instance is known: the app's name would flash before its name) */}
      {text && <div id="boot" role="status">{text}</div>}
    </div>
  );
  if (!ready) return note(); // (no loading message for now: the header alone, until the instance is known)
  if (!view) return note(removed);
  return (
    <div id="det" className={cls}>
      <header className="mwh">
        <h1>{view.name}</h1>
        <div className="btns">{buttons}</div>
      </header>
      <div className="dbody"><MonitorBody id={id} view={view} folds={false} /></div>
    </div>
  );
}
