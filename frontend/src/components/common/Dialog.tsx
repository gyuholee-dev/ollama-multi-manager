import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '@/locales/useT';

interface Props {
  id: string;
  onClose: () => void;
  children: ReactNode;
  'data-k'?: string;
  'aria-live'?: 'assertive';
}

/**
 * A native modal <dialog> that opens when it is mounted. Escape and a click on the backdrop close it
 * (a press that starts inside the dialog and ends outside, such as a text selection, does not).
 */
export function Dialog({ id, onClose, children, ...rest }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const outside = (e: { clientX: number; clientY: number }) => {
    const r = ref.current?.getBoundingClientRect();
    return !!r && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  return (
    <dialog id={id} ref={ref} onClose={onClose} {...rest}
      onMouseDown={(e) => { pressedOutside.current = e.target === ref.current && outside(e); }}
      onClick={(e) => {
        if (pressedOutside.current && e.target === ref.current && outside(e)) ref.current?.close();
        pressedOutside.current = false;
      }}>
      {children}
    </dialog>
  );
}

/**
 * The header of a big dialog: heading and the close button. `actions` adds a row of buttons (right aligned) to the
 * header itself, so it stays in place while the body below scrolls.
 */
export function DialogTitle({ children, id, onClose, actions }: { children: ReactNode; id?: string; onClose: () => void; actions?: ReactNode }) {
  const title = (
    <h3 id={id}><span className="ttl">{children}</span> <button type="button" className="inline" style={{ float: 'right' }} onClick={onClose}><span className="material-icons">close</span></button></h3>
  );
  return actions ? <div className="dh">{title}<div className="btns">{actions}</div></div> : title;
}

/** What sits below the title of a big dialog: the part that scrolls. */
export function DialogBody({ children }: { children: ReactNode }) {
  return <div className="dbody">{children}</div>;
}

/**
 * The title of a page (settings, models): the heading and the close button at the right, like a dialog's. A screen under the page
 * (the edit screen of a model) also has a back button before the heading, which goes back to the page.
 */
export function PageTitle({ children, onClose, onBack }: { children: ReactNode; onClose: () => void; onBack?: () => void }) {
  const t = useT();
  return (
    <h3>
      {onBack && <button type="button" className="inline" aria-label={t('mdl.back')} title={t('mdl.back')} onClick={onBack}><span className="material-icons">chevron_left</span></button>}
      {onBack && ' '}<span className="ttl">{children}</span>
      {' '}<button type="button" className="inline" style={{ float: 'right' }} aria-label={t('btn.close')} title={t('btn.close')} onClick={onClose}><span className="material-icons">close</span></button>
    </h3>
  );
}
