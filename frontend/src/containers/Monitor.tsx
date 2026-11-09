import type { ReactNode } from 'react';
import { useDevices, useViews } from '@/app/hooks';
import { Bar, Legend, type Segment } from '@/components/common/Bar';
import { Section } from '@/components/common/Section';
import { instanceColor, vramByGpu } from '@/lib/derive';
import { gpuLabel, isUnified, memoryLabel } from '@/lib/format';
import { gb } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useMonitorStore } from '@/stores/monitorStore';
import { useUiStore } from '@/stores/uiStore';

const VRAM_WARN_PERCENT = 85;
const warnStyle = { color: 'var(--warn)' };

interface BoxProps {
  title: string;
  summary: string;
  warn?: boolean;
  children: ReactNode;
}

function MonitorBox({ title, summary, warn, children }: BoxProps) {
  return (
    <div className="sb">
      <div className="top" style={{ margin: 0 }}><span className="ti">{title}</span><span className="sub" style={warn ? warnStyle : undefined}>{summary}</span></div>
      {children}
    </div>
  );
}

/** A device's name and its figures, above its bar (rows after the first sit 14px lower). */
function DeviceHead({ n, name, figures, warn }: { n: number; name: string; figures: string; warn?: boolean }) {
  return (
    <div className="top" style={{ margin: `${n ? 14 : 8}px 0 0` }}><span>{name}</span><span className="sub" style={warn ? warnStyle : undefined}>{figures}</span></div>
  );
}

/** A bar that cannot be filled, with the reason, for a machine whose GPU cannot be read. */
function Unsupported() {
  const t = useT();
  return (
    <div>
      <div className="top" style={{ margin: '8px 0 0' }}><span>-</span><span className="sub">-</span></div>
      <Bar segments={[]} off />
      <div className="sub off-note">{t('mon.unsupported')}</div>
    </div>
  );
}

export function Monitor() {
  const t = useT();
  const views = useViews();
  const devices = useDevices();
  const snap = useMonitorStore((s) => s.snap);
  const monOn = useUiStore((s) => s.monOn);
  const toggleMon = useUiStore((s) => s.toggleMon);

  const available = ['CPU', 'RAM', 'GPU', 'VRAM']; // shown even where the GPU cannot be read: the boxes then say so
  const memName = memoryLabel(devices, t);
  const tabs = (
    <div id="mtabs">
      {available.map((k) => <button key={k} className={`small${monOn.includes(k) ? ' on' : ''}`} onClick={() => toggleMon(k)}>{k === 'VRAM' ? memName : k}</button>)}
    </div>
  );
  const sys = snap?.system;
  if (!sys) {
    return <Section id="mon" tabs={tabs}><div id="mon"><div className="sub" style={{ gridColumn: '1/-1' }}>{t('sum.empty')}</div></div></Section>;
  }

  const show = (k: string) => available.includes(k) && monOn.includes(k);
  const systemLabel = t('mon.system');
  const otherLabel = t('mon.other');
  // One share per running instance (the colour is the same as in the VRAM bar); nothing is shown for Ollama as a whole.
  const mine = views.map((v, n) => ({ name: v.name, color: instanceColor(n), m: v.metrics })).filter((x) => x.m);
  const memText = (g: number): string => (g < 1 ? `${Math.round(g * 1024)} MB` : `${g.toFixed(1)} GB`);

  const cores = sys.cpu_count || 1;
  const cpuTotal = Math.round(sys.cpu_percent);
  const cpuParts = mine.map((x) => ({ ...x, pct: Math.round((x.m?.cpu_percent ?? 0) / cores) }));
  const cpuOther = Math.max(0, cpuTotal - cpuParts.reduce((a, x) => a + x.pct, 0));
  const cpuSegments: Segment[] = [...cpuParts.map((x): Segment => [x.name, x.pct, x.color, `${x.pct}%`]), [otherLabel, cpuOther, 'var(--sub)', `${cpuOther}%`]];

  const ramParts = mine.map((x) => ({ ...x, g: gb(x.m?.rss ?? 0) }));
  const ramOllama = ramParts.reduce((a, x) => a + x.g, 0);
  const ramUsed = gb(sys.mem_used);
  const ramTotal = gb(sys.mem_total);
  const ramOther = Math.max(0, ramUsed - ramOllama);
  const ramSegments: Segment[] = [
    [systemLabel, (ramOther / ramTotal) * 100, 'var(--sub)', `${ramOther.toFixed(1)} GB`],
    ...ramParts.map((x): Segment => [x.name, (x.g / ramTotal) * 100, x.color, memText(x.g)]),
  ];

  const usage = vramByGpu(views, devices);
  const vramUsed = usage.reduce((a, g) => a + g.used, 0);
  const vramTotal = usage.reduce((a, g) => a + g.total, 0);
  const vramMax = usage.length ? Math.max(...usage.map((g) => g.pct)) : 0;
  // Unified memory (UMA): one pool shared with the CPU, so the bar is drawn over all of it; the GPU's own share and limit are written beside it.
  const pool = isUnified(devices) && devices.every((d) => d.supports.mem);
  const gpuUsed = usage.reduce((a, g) => a + g.used, 0);
  const instanceParts = usage.flatMap((g) => g.parts);
  const gpuOther = Math.max(0, gpuUsed - instanceParts.reduce((a, p) => a + p.v, 0));
  const poolSystem = Math.max(0, ramUsed - gpuUsed);
  const poolSegments: Segment[] = [
    [systemLabel, (poolSystem / ramTotal) * 100, 'var(--sub)', `${poolSystem.toFixed(1)} GB`],
    ...instanceParts.map((p): Segment => [p.name, (p.v / ramTotal) * 100, p.col, `${p.v.toFixed(1)} GB`]),
    ...(gpuOther > 0.05 ? [[t('mon.gpuOther'), (gpuOther / ramTotal) * 100, 'var(--line)', `${gpuOther.toFixed(1)} GB`] as Segment] : []),
  ];

  const boxes = [
    show('CPU') && (
      <MonitorBox key="CPU" title="CPU" summary={t('mon.cpu', { pct: cpuTotal, n: cores })}>
        <Bar segments={cpuSegments} /><Legend segments={cpuSegments} />
      </MonitorBox>
    ),
    show('RAM') && (
      <MonitorBox key="RAM" title="RAM" summary={`${ramUsed.toFixed(1)} / ${ramTotal.toFixed(0)} GB (${Math.round((ramUsed / ramTotal) * 100)}%)`}>
        <Bar segments={ramSegments} /><Legend segments={ramSegments} />
      </MonitorBox>
    ),
    show('GPU') && (
      <MonitorBox key="GPU" title="GPU" summary={devices.length ? t('mon.gpus', { n: devices.length }) : '-'}>
        {devices.length === 0 && <Unsupported />}
        {devices.map((d, n) => {
          const figures = [d.supports.util && d.util_percent != null ? `${d.util_percent}%` : '-', d.supports.temp && d.temperature_c != null ? `${d.temperature_c}°C` : '-'].join(' · ');
          return (
            <div key={d.index}>
              <DeviceHead n={n} name={gpuLabel(n, devices, t)} figures={figures} />
              <Bar segments={[[d.name, d.util_percent ?? 0, 'var(--accent)', '']]} off={!d.supports.util} />
              {!d.supports.util && <div className="sub off-note">{t('mon.unsupported')}</div>}
            </div>
          );
        })}
      </MonitorBox>
    ),
    show('VRAM') && (
      <MonitorBox key="VRAM" title={memName} summary={pool ? `${ramUsed.toFixed(1)} / ${ramTotal.toFixed(0)} GB (${Math.round((ramUsed / ramTotal) * 100)}%)` : devices.length ? `${vramUsed.toFixed(1)} / ${vramTotal.toFixed(0)} GB (${vramTotal ? Math.round((vramUsed / vramTotal) * 100) : 0}%)` : '-'} warn={vramMax > VRAM_WARN_PERCENT}>
        {devices.length === 0 && <Unsupported />}
        {pool && usage.map((g, n) => (
          <DeviceHead key={g.device.index} n={n} name={gpuLabel(n, devices, t)} figures={t('mon.gpuShare', { used: g.used.toFixed(1), limit: g.total.toFixed(1) })} warn={g.pct > VRAM_WARN_PERCENT} />
        ))}
        {pool && <><Bar segments={poolSegments} /><Legend segments={poolSegments} /></>}
        {!pool && usage.map((g, n) => {
          if (!g.device.supports.mem) {
            return (
              <div key={g.device.index}>
                <DeviceHead n={n} name={gpuLabel(n, devices, t)} figures="-" />
                <Bar segments={[]} off /><div className="sub off-note">{t('mon.unsupported')}</div>
              </div>
            );
          }
          const other = Math.max(0, g.used - g.parts.reduce((a, p) => a + p.v, 0));
          const segments: Segment[] = [
            [systemLabel, (other / g.total) * 100, 'var(--sub)', `${other.toFixed(1)} GB`],
            ...g.parts.map((p): Segment => [p.name, (p.v / g.total) * 100, p.col, `${p.v.toFixed(1)} GB`]),
          ];
          return (
            <div key={g.device.index}>
              <DeviceHead n={n} name={gpuLabel(n, devices, t)} figures={`${g.used.toFixed(1)} / ${g.total.toFixed(1)} GB (${g.pct}%)`} warn={g.pct > VRAM_WARN_PERCENT} />
              <Bar segments={segments} /><Legend segments={segments} />
            </div>
          );
        })}
      </MonitorBox>
    ),
  ].filter(Boolean);

  return (
    <Section id="mon" tabs={tabs}>
      <div id="mon">
        {boxes.length ? boxes : <div className="sub" style={{ gridColumn: '1/-1' }}>{t('sum.empty')}</div>}
      </div>
    </Section>
  );
}
