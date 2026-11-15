import { useEffect, useRef, useState } from 'react';
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
  return <button type="button" className="ibtn" title={label} aria-label={label} disabled={disabled} onClick={() => void copy()}><Icon name={done ? 'check' : 'content_copy'} /></button>;
}

/** Empties what a list shows (the stored record stays: see the stores). */
export function ClearButton({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
  const t = useT();
  return <button type="button" className="ibtn" title={t('btn.clear')} aria-label={t('btn.clear')} disabled={disabled} onClick={onClear}><Icon name="delete_sweep" /></button>;
}
