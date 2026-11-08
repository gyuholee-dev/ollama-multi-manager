import { useEffect, useLayoutEffect, useRef } from 'react';
import { Section } from '@/components/common/Section';
import { hms } from '@/lib/format';
import { useT } from '@/locales/useT';
import { useLogStore } from '@/stores/logStore';
import { useUiStore } from '@/stores/uiStore';

export function Logs() {
  const t = useT();
  const lines = useLogStore((s) => s.lines);
  const filter = useUiStore((s) => s.logFilter);
  const setFilter = useUiStore((s) => s.setLogFilter);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  const sources = ['app', ...new Set(lines.map((l) => l.src).filter((s) => s !== 'app'))];
  const active = filter === 'all' || sources.includes(filter) ? filter : 'all'; // a source that is gone falls back to "all"
  const text = lines.filter((l) => active === 'all' || l.src === active)
    .map((l) => `[${hms(l.ts)}] ${active === 'all' ? `[${l.src}] ` : ''}${l.m}`).join('\n');

  // Keep following the newest line only when the reader was already at the end.
  const el = box.current;
  if (el) atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  useLayoutEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
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
    <Section id="logs" tabs={tabs}>
      <div id="lbox"><div id="logs" ref={box}>{text}</div></div>
    </Section>
  );
}
