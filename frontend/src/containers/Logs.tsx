import { useEffect, useLayoutEffect, useRef } from 'react';
import { ClearButton, CopyButton } from '@/components/common/ListTools';
import { Section } from '@/components/common/Section';
import { hms } from '@/lib/format';
import { useT } from '@/locales/useT';
import { useLogStore, type StoredLine } from '@/stores/logStore';
import { useUiStore } from '@/stores/uiStore';

export function Logs() {
  const t = useT();
  const lines = useLogStore((s) => s.lines);
  const filter = useUiStore((s) => s.logFilter);
  const setFilter = useUiStore((s) => s.setLogFilter);
  const clear = useLogStore((s) => s.clear);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  const sources = ['app', ...new Set(lines.map((l) => l.src).filter((s) => s !== 'app'))];
  const active = filter === 'all' || sources.includes(filter) ? filter : 'all'; // a source that is gone falls back to "all"
  const shown = lines.filter((l) => active === 'all' || l.src === active);
  const lineText = (l: StoredLine): string => `[${hms(l.ts)}] ${active === 'all' ? `[${l.src}] ` : ''}${l.m}`;
  const text = shown.map(lineText).join('\n'); // what "copy" takes
  const newest = shown.at(-1)?.id;

  // Keep following the newest line only when the reader was already at the end.
  const el = box.current;
  if (el) atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  useLayoutEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [newest, shown.length]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight; // choosing a source jumps to its newest line
  }, [active]);

  const label = (name: string) => (name === 'all' ? t('log.all') : name === 'app' ? t('log.app') : name);
  const tabs = (
    <div id="ltabs">
      {['all', ...sources].map((name) => (
        <button key={name} className={`small${name === active ? ' on' : ''}`} onClick={() => setFilter(name)}>{label(name)}</button>
      ))}
    </div>
  );

  return (
    <Section id="logs" tabs={tabs} tools={<><CopyButton text={() => text} disabled={!text} /><ClearButton onClear={() => clear(active)} disabled={!text} /></>}>
      {/* a line is an element of its own: a selection in it survives new lines (and is what the shell's "Copy" menu takes) */}
      <div id="lbox"><div id="logs" ref={box} data-copy-area="">{shown.map((l) => <div className="logl" key={l.id}>{lineText(l)}</div>)}</div></div>
    </Section>
  );
}
