import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/locales/useT';
import { Icon } from './Icon';

/** Copies what a list shows; the icon turns into a check for a moment when it worked. `text` is read when the button is pressed. */
export function CopyButton({ text, disabled }: { text: () => string; disabled?: boolean }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await copyText(text()))) return;
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1500);
  };
  const label = done ? t('btn.copied') : t('btn.copy');
  return <button type="button" className="ovl__btn" title={label} aria-label={label} disabled={disabled} onClick={() => void copy()}><Icon name={done ? 'check' : 'content_copy'} /></button>;
}

/** Empties what a list shows (the stored record stays: see the stores). */
export function ClearButton({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
  const t = useT();
  return <button type="button" className="ovl__btn" title={t('btn.clear')} aria-label={t('btn.clear')} disabled={disabled} onClick={onClear}><Icon name="delete_sweep" /></button>;
}

interface OverlayProps {
  /** The buttons, laid over the top right corner. */
  tools: ReactNode;
  /** Keeps a strip free at the top for the buttons, where the list starts with a header row that they must not cover. */
  strip?: boolean;
  /** The list sits in a card with the usual 14px padding: the buttons go out to the card's corner, as in the main log box (which has that padding itself). */
  card?: boolean;
  id?: string;
  children: ReactNode;
}

/** A list with its copy and clear buttons laid over its corner: dim until the pointer is over the list (or a button has focus). */
export function Overlay({ tools, strip, card, id, children }: OverlayProps) {
  return (
    <div id={id} className={`ovl${strip ? ' ovl--strip' : ''}${card ? ' ovl--card' : ''}`}>
      {children}
      <div className="ovl__tools">{tools}</div>
    </div>
  );
}
