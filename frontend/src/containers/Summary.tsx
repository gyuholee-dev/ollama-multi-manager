import type { ReactNode } from 'react';
import { useDevices, useExternal, useViews } from '@/app/hooks';
import { Section } from '@/components/common/Section';
import { perfAll, vramByGpu } from '@/lib/derive';
import { hms, memoryLabel } from '@/lib/format';
import { useT } from '@/locales/useT';
import { useLogStore } from '@/stores/logStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useUiStore } from '@/stores/uiStore';

const SUMS = ['ins', 'usage', 'perf', 'status'] as const;
const VRAM_WARN_PERCENT = 85;

interface CellProps {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: '--warn' | '--ok' | '--err';
}

function Cell({ label, value, unit, tone }: CellProps) {
  return (
    <div>
      <div className="sub">{label}</div>
      <span className="val" style={tone ? { color: `var(${tone})` } : undefined}>{value}{unit ? <small>{unit}</small> : null}</span>
    </div>
  );
}

function Box({ id, children }: { id: (typeof SUMS)[number]; children: ReactNode }) {
  const t = useT();
  const on = useUiStore((s) => s.sumOn.includes(id));
  if (!on) return null;
  return <div className="sb"><span className="ti">{t(`sum.${id}`)}</span><div className="sc">{children}</div></div>;
}

export function Summary() {
  const t = useT();
  const views = useViews();
  const external = useExternal();
  const devices = useDevices();
  const snap = useMonitorStore((s) => s.snap);
  const web = useMonitorStore((s) => s.info?.external_monitoring);
  const warnings = useLogStore((s) => s.lines.filter((x) => x.level === 'warn').length);
  const sumOn = useUiStore((s) => s.sumOn);
  const toggleSum = useUiStore((s) => s.toggleSum);

  const count = (state: string) => views.filter((i) => i.state === state).length;
  const bad = count('crashed') + count('unreachable');
  const usage = vramByGpu(views, devices);
  const readable = usage.filter((g) => g.device.supports.mem);
  const vramPct = readable.length ? Math.max(...readable.map((g) => g.pct)) : null;
  const sys = snap?.system;
  const memPct = sys ? Math.round((sys.mem_used / sys.mem_total) * 100) : null;
  const models = views.reduce((n, i) => n + i.loaded.length, 0) + (external ? external.loaded.length : 0);
  const warn = bad + (vramPct !== null && vramPct > VRAM_WARN_PERCENT ? 1 : 0);
  const perf = perfAll(snap);
  const anyBox = SUMS.some((k) => sumOn.includes(k));

  const tabs = (
    <div id="utabs">
      {SUMS.map((k) => <button key={k} className={`small${sumOn.includes(k) ? ' on' : ''}`} onClick={() => toggleSum(k)}>{t(`sum.${k}`)}</button>)}
    </div>
  );

  return (
    <Section id="sum" tabs={tabs}>
      <div id="sum">
        <Box id="ins">
          <Cell label={t('c.total')} value={views.length} />
          <Cell label={t('c.running')} value={count('running')} />
          <Cell label={t('c.stopped')} value={count('stopped')} />
          <Cell label={t('c.unreach')} value={bad} />
        </Box>
        <Box id="usage">
          <Cell label={memoryLabel(devices, t)} value={vramPct ?? '-'} unit={vramPct === null ? undefined : '%'} tone={vramPct !== null && vramPct > VRAM_WARN_PERCENT ? '--warn' : undefined} />
          <Cell label={t('c.mem')} value={memPct ?? '-'} unit={memPct === null ? undefined : '%'} />
          <Cell label={t('c.models')} value={models} unit={t('u.cnt')} />
        </Box>
        <Box id="perf">
          <Cell label={t('c.reqs')} value={perf ? perf.processing : '-'} unit={perf ? ` ${t('u.case')} · ${t('c.queued')} ${perf.queued}` : undefined} />
          <Cell label={t('c.latency')} value={perf?.latency != null ? perf.latency.toFixed(1) : '-'} unit={perf?.latency != null ? ' s' : undefined} />
          <Cell label={t('c.speed')} value={perf?.speed != null ? Math.round(perf.speed) : '-'} unit={perf?.speed != null ? ' tok/s' : undefined} />
          <Cell label={t('c.fail')} value={perf ? perf.errors : '-'} tone={perf?.errors ? '--err' : undefined}
            unit={perf ? ` ${t('u.case')}${perf.requests ? ` · ${Math.round((perf.errors / perf.requests) * 100)}%` : ''}` : undefined} />
        </Box>
        <Box id="status">
          <Cell label={t('c.warn')} value={warn ? warn : t('c.ok')} unit={warn ? t('u.case') : undefined} tone={warn ? '--warn' : '--ok'} />
          <Cell label={t('c.errs')} value={warnings} unit={t('u.case')} />
          <Cell label={t('c.mon')} value={web?.active ? t('c.on') : t('c.off')} unit={web?.active ? ` :${web.port}` : undefined} />
          <Cell label={t('c.updated')} value={snap ? hms(snap.ts * 1000).slice(0, 5) : '-'} />
        </Box>
        {!anyBox && <div className="sub" style={{ gridColumn: '1/-1' }}>{t('sum.empty')}</div>}
      </div>
    </Section>
  );
}
