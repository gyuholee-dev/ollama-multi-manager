import { useEffect, useRef, type ReactNode } from 'react';

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

/** The title bar of a big dialog: heading and the close button. */
export function DialogTitle({ children, id, onClose }: { children: ReactNode; id?: string; onClose: () => void }) {
  return (
    <h3 id={id}>{children} <button type="button" style={{ float: 'right' }} onClick={onClose}><span className="material-icons">close</span></button></h3>
  );
}

/** What sits below the title of a big dialog: the part that scrolls. */
export function DialogBody({ children }: { children: ReactNode }) {
  return <div className="dbody">{children}</div>;
}
