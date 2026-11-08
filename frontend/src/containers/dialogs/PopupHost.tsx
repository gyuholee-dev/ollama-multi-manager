import { useEffect, useRef } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { Icon } from '@/components/common/Icon';
import { useDialogStore, type PopupKind } from '@/stores/dialogStore';

const ICON: Record<PopupKind, string> = { info: 'info', warn: 'warning', error: 'error', confirm: 'help_outline', danger: 'delete_outline' };

/** Messages and questions (see app/dialogs.ts); they appear above whatever dialog is open. */
export function PopupHost() {
  const popup = useDialogStore((s) => s.popup);
  const close = useDialogStore((s) => s.closePopup);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => { ok.current?.focus(); }, [popup]);
  if (!popup) return null;
  return (
    <Dialog id="pop" key={popup.title + popup.msg} data-k={popup.kind} aria-live="assertive" onClose={() => close(false)}>
      <div className="pb">
        <div className="pi"><Icon name={ICON[popup.kind]} /></div>
        <div className="pt"><h3>{popup.title}</h3><p>{popup.msg}</p></div>
      </div>
      <div className="btns">
        {popup.cancel && <button type="button" id="pc" onClick={() => close(false)}>{popup.cancel}</button>}
        {popup.alt && <button type="button" id="pa" onClick={() => close('alt')}>{popup.alt}</button>}
        <button type="button" id="po" ref={ok} className={`primary${popup.kind === 'danger' ? ' danger' : ''}`} onClick={() => close(true)}>{popup.ok}</button>
      </div>
    </Dialog>
  );
}
