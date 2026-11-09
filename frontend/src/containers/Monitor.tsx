import type { ReactNode } from 'react';
import { useDevices, useViews } from '@/app/hooks';
import { Bar, Legend, type Segment } from '@/components/common/Bar';
import { Section } from '@/components/common/Section';
import { instanceColor, vramByGpu, type GpuUsage } from '@/lib/derive';
import { memoryLabel } from '@/lib/format';
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

export function Monitor() {
  const t = useT();
  const views = useViews();
  const devices = useDevices();
  const snap = useMonitorStore((s) => s.snap);
  const monOff = useUiStore((s) => s.monOff);
  const toggleMon = useUiStore((s) => s.toggleMon);

  // one tab per GPU (GPU-0, GPU-1, ...); where no GPU can be read there is a single disabled GPU box
  const available = ['CPU', 'RAM', ...(devices.length ? devices.map((_, n) => `GPU-${n}`) : ['GPU'])];
  const memName = memoryLabel(devices, t);
  const tabs = (
    <div id="mtabs">
      {available.map((k) => <button key={k} className={`small${monOff.includes(k) ? '' : ' on'}`} onClick={() => toggleMon(k)}>{k}</button>)}
    </div>
  );
  const sys = snap?.system;
  if (!sys) {
    return <Section id="mon" tabs={tabs}><div id="mon"><div className="sub" style={{ gridColumn: '1/-1' }}>{t('sum.empty')}</div></div></Section>;
  }

  const show = (k: string) => available.includes(k) && !monOff.includes(k);
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

  // One box per GPU: its use on the first row, its memory (VRAM, or UMA when shared with the CPU) on the second.
  const gpuBox = (g: GpuUsage, n: number) => {
    const d = g.device;
    const util = d.supports.util && d.util_percent != null ? `${d.util_percent}%` : '-';
    const temp = d.supports.temp && d.temperature_c != null ? `${d.temperature_c}°C` : '-';
    const memLabel = d.unified ? t('mon.unified') : 'VRAM';
    let memory: ReactNode;
    if (!d.supports.mem) {
      memory = <><DeviceHead n={1} name={memLabel} figures="-" /><Bar segments={[]} off /><div className="sub off-note">{t('mon.unsupported')}</div></>;
    } else if (d.unified) {
      // one pool shared with the CPU: the bar covers all of it; the row says how much the GPU uses of its limit and how full the whole pool is
      const other = Math.max(0, g.used - g.parts.reduce((a, p) => a + p.v, 0));
      const system = Math.max(0, ramUsed - g.used);
      const segments: Segment[] = [
        [systemLabel, (system / ramTotal) * 100, 'var(--sub)', `${system.toFixed(1)} GB`],
        ...g.parts.map((p): Segment => [p.name, (p.v / ramTotal) * 100, p.col, `${p.v.toFixed(1)} GB`]),
        ...(other > 0.05 ? [[t('mon.gpuOther'), (other / ramTotal) * 100, 'var(--line)', `${other.toFixed(1)} GB`] as Segment] : []),
      ];
      memory = (
        <>
          <DeviceHead n={1} name={memLabel} warn={g.pct > VRAM_WARN_PERCENT}
            figures={t('mon.umaFigures', { gpu: g.used.toFixed(1), limit: g.total.toFixed(1), used: ramUsed.toFixed(1), total: ramTotal.toFixed(0), pct: Math.round((ramUsed / ramTotal) * 100) })} />
          <Bar segments={segments} /><Legend segments={segments} />
        </>
      );
    } else {
      const other = Math.max(0, g.used - g.parts.reduce((a, p) => a + p.v, 0));
      const segments: Segment[] = [
        [systemLabel, (other / g.total) * 100, 'var(--sub)', `${other.toFixed(1)} GB`],
        ...g.parts.map((p): Segment => [p.name, (p.v / g.total) * 100, p.col, `${p.v.toFixed(1)} GB`]),
      ];
      memory = (
        <>
          <DeviceHead n={1} name={memLabel} figures={`${g.used.toFixed(1)} / ${g.total.toFixed(1)} GB (${g.pct}%)`} warn={g.pct > VRAM_WARN_PERCENT} />
          <Bar segments={segments} /><Legend segments={segments} />
        </>
      );
    }
    return (
      <MonitorBox key={`GPU-${n}`} title={`GPU-${n}`} summary={d.name}>
        <DeviceHead n={0} name="GPU" figures={`${util} · ${temp}`} />
        <Bar segments={[[d.name, d.util_percent ?? 0, 'var(--accent)', '']]} off={!d.supports.util} />
        {!d.supports.util && <div className="sub off-note">{t('mon.unsupported')}</div>}
        {memory}
      </MonitorBox>
    );
  };
  // a machine whose GPU cannot be read still gets the box, disabled
  const noGpuBox = (
    <MonitorBox key="GPU" title="GPU" summary="-">
      <DeviceHead n={0} name="GPU" figures="-" /><Bar segments={[]} off />
      <DeviceHead n={1} name={memName} figures="-" /><Bar segments={[]} off />
      <div className="sub off-note">{t('mon.unsupported')}</div>
    </MonitorBox>
  );
  const gpuBoxes = usage.length ? usage.map((g, n) => (show(`GPU-${n}`) ? gpuBox(g, n) : null)) : [show('GPU') ? noGpuBox : null];

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
    ...gpuBoxes,
  ].filter(Boolean);

  return (
    <Section id="mon" tabs={tabs}>
      <div id="mon">
        {boxes.length ? boxes : <div className="sub" style={{ gridColumn: '1/-1' }}>{t('sum.empty')}</div>}
      </div>
    </Section>
  );
}
