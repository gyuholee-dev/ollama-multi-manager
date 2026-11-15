import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/locales/useT';

/** Copies what a list shows; the label says "Copied" for a moment when it worked. `text` is read when the button is pressed. */
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
  return <button type="button" className="small" disabled={disabled} onClick={() => void copy()}>{done ? t('btn.copied') : t('btn.copy')}</button>;
}

/** Empties what a list shows (the stored record stays: see the stores). */
export function ClearButton({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
  const t = useT();
  return <button type="button" className="small" disabled={disabled} onClick={onClear}>{t('btn.clear')}</button>;
}

/** A row of buttons above a list, at its right edge. */
export function ListTools({ children }: { children: ReactNode }) {
  return <div className="listtools">{children}</div>;
}
