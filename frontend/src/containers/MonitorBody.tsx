import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { InstanceSample, Perf, RequestDetail, RequestEntry, RequestsResponse, SeriesPoint } from '@/api/types';
import { BarChart, LineChart, niceMax } from '@/components/charts/Charts';
import { Collapse } from '@/components/common/Collapse';
import { Section } from '@/components/common/Section';
import type { InstanceView } from '@/lib/derive';
import { expAt, fmtUp, hms, memoryLabel } from '@/lib/format';
import { gb } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useLogStore } from '@/stores/logStore';
import { useHistoryStore, type Sample } from '@/stores/historyStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useUiStore, type SectionId } from '@/stores/uiStore';

/** One part of a section of the monitor: a titled block (folding in the dialog, fixed in the window). */
/** The name on a group button: the title without a note in brackets at its end ("Per model (last 5 min)" -> "Per model"). */
const short = (title: string): string => title.replace(/\s*[(（][^)）]*[)）]\s*$/, '');

interface Part {
  id: string;
  title: string;
  boxed?: boolean;
  body: ReactNode;
}

const NONE: Sample[] = [];
/** The live graphs always show this much time, so their left edge reads the same on every graph. */
const LIVE_MINUTES = 3;

/** The readings of the last LIVE_MINUTES, with empty slots in front when the page has not collected that long yet. */
function liveWindow(all: Sample[]): { recent: Sample[]; slots: (Sample | null)[] } {
  const last = all.at(-1);
  if (!last) return { recent: [], slots: [] };
  const recent = all.filter((x) => x.ts >= last.ts - LIVE_MINUTES * 60000);
  const gaps = recent.slice(1).map((x, k) => x.ts - recent[k]!.ts).sort((a, b) => a - b);
  const step = gaps.length ? Math.max(200, gaps[Math.floor(gaps.length / 2)]!) : 3000;
  const n = Math.round((LIVE_MINUTES * 60000) / step) + 1;
  const slots: (Sample | null)[] = recent.slice(-n);
  while (slots.length < n) slots.unshift(null);
  return { recent, slots };
}

function Cell({ label, value, unit, tone }: { label: string; value: ReactNode; unit?: string; tone?: '--err' | '--warn' }) {
  return (
    <div>
      <div className="sub">{label}</div>
      <span className="val" style={tone ? { color: `var(${tone})` } : undefined}>{value}{unit ? <small>{unit}</small> : null}</span>
    </div>
  );
}

/** One line of the recent-request list; opened, it shows what was asked and answered (read from the journal when first opened). */
function RequestRow({ iid, r }: { iid: number; r: RequestEntry }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RequestDetail | 'failed' | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (!open && detail === null) {
      api.get<RequestDetail>(`/instances/${iid}/requests/${r.id}`).then(setDetail, () => setDetail('failed'));
    }
  };
  return (
    <>
      <tr className={`rqr ${r.outcome === 'error' ? 'bad' : r.outcome === 'cancelled' ? 'cx' : ''}${open ? ' op' : ''}`} onClick={toggle} aria-expanded={open}>
        <td><span className="material-icons rqa">chevron_right</span>{hms(r.ts * 1000)}</td><td>{r.path}</td>
        <td className="r">{r.outcome === 'cancelled' ? t('rq.cancelled') : r.status}</td>
        <td className="r">{r.duration.toFixed(1)} s</td><td className="r">{r.prompt_tokens ?? '-'} / {r.tokens ?? '-'}</td></tr>
      {open && (
        <tr className="rqd"><td colSpan={5}>
          {detail === null ? <div className="sub">…</div> : detail === 'failed' ? <div className="sub">{t('rq.noDetail')}</div> : (
            <>
              <div className="sub">{t('rq.model')}: <span className="val">{detail.model || '-'}</span> · {t('rq.client')}: <span className="val">{detail.client || '-'}</span>
                {detail.ttft != null && <> · {t('im.ttft')}: <span className="val">{detail.ttft.toFixed(1)} s</span></>}</div>
              {detail.saved ? (
                <>
                  <div className="sub rqh">{t('rq.asked')}</div><pre className="rqp">{detail.request}</pre>
                  <div className="sub rqh">{t('rq.answered')}</div><pre className="rqp">{detail.response || '-'}</pre>
                </>
              ) : <div className="sub rqh">{t('rq.notSaved')}</div>}
            </>
          )}
        </td></tr>
      )}
    </>
  );
}

/** The instance's own output (what the log section of the page shows for it), following the newest line. */
function InstanceLog({ name }: { name: string }) {
  const t = useT();
  const lines = useLogStore((s) => s.lines);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const text = lines.filter((l) => l.src === name).map((l) => `[${hms(l.ts)}] ${l.m}`).join('\n');
  const el = box.current;
  if (el) atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  useLayoutEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  return text ? <div className="ilog" ref={box}>{text}</div> : <div className="sub">{t('im.logNone')}</div>;
}

const fixed = (v: number | null | undefined, digits = 1): string => (v == null ? '-' : v.toFixed(digits));
const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

/** Live numbers and graphs of one running instance: what it is doing now, the last hour, and its resources. */
/** `folds` false: the monitor window, whose parts are plain blocks that cannot be folded and are switched on and off by the buttons of their section. */
export function MonitorBody({ id, view, folds = true }: { id: number; view: InstanceView; folds?: boolean }) {
  const t = useT();
  const snap = useMonitorStore((s) => s.snap);
  const samples = useHistoryStore((s) => s.series[String(id)] ?? NONE);
  const imFold = useUiStore((s) => s.imFold);
  const imHide = useUiStore((s) => s.imHide);
  const toggleHide = useUiStore((s) => s.toggleImPart);
  const shown = (part: string) => folds || !imHide.includes(part); // (the dialog shows all parts; the window's buttons switch them off)
  const open = (key: string) => !folds || !imFold.includes(key);
  const [hour, setHour] = useState<SeriesPoint[] | null>(null);
  const [recent, setRecent] = useState<RequestsResponse['requests']>([]);

  useEffect(() => {
    let alive = true;
    // only what is shown is asked for
    Promise.all([
      shown('hour') && open('hour') ? api.get<{ series: SeriesPoint[] }>(`/monitor/requests?minutes=60&instance=${id}`).then((r) => r.series) : Promise.resolve(null),
      shown('recent') && open('recent') ? api.get<RequestsResponse>(`/instances/${id}/requests?limit=20`).then((q) => q.requests) : Promise.resolve(null),
    ]).then(([series, requests]) => { if (alive) { if (series) setHour(series); if (requests) setRecent(requests); } }, () => { /* keep what is shown */ });
    return () => { alive = false; };
  }, [id, snap, imFold, imHide]); // eslint-disable-line react-hooks/exhaustive-deps

  // the readings the backend kept so far: the graphs start full, also in a window that was just opened
  useEffect(() => {
    let alive = true;
    api.get<{ samples: InstanceSample[] }>(`/monitor/instances/${id}/history`)
      .then((r) => { if (alive) useHistoryStore.getState().seed(String(id), r.samples); }, () => { /* the graphs fill as snapshots arrive */ });
    return () => { alive = false; };
  }, [id]);

  const p: Perf | null = view.metrics?.perf ?? null;
  const m = view.metrics;
  const running = view.state === 'running';
  const last = samples.at(-1);
  const { slots } = liveWindow(samples);
  const liveLeft = samples.length > 1 ? t('im.span', { m: LIVE_MINUTES }) : '';
  const liveRight = t('im.nowEdge');
  const series = hour ?? [];
  // the newest minute of the last-hour graphs, shown beside their titles
  const newest = series.at(-1);
  const nowReq = newest ? `${newest.requests} ${t('u.case')}` : undefined;
  const nowSpeed = newest ? (newest.tok_per_s != null ? `${Math.round(newest.tok_per_s)} tok/s` : '-') : undefined;
  const nowLatency = newest ? (newest.latency_avg != null ? `${newest.latency_avg.toFixed(1)} s` : '-') : undefined;
  const total = sum(series.map((x) => x.requests));
  const errors = sum(series.map((x) => x.errors));
  const tokIn = sum(series.map((x) => x.prompt_tokens));
  const tokOut = sum(series.map((x) => x.tokens));
  const hourLeft = t('im.hourAgo'), hourRight = t('im.nowEdge');
  // The top of each live graph is the most the hardware (or the instance's setting) can give, not the largest reading.
  const memTotal = snap?.system.mem_total ? gb(snap.system.mem_total) : undefined;
  const devices = snap?.gpu.devices ?? [];
  const vramTotal = view.gpu === 'cpu' ? 0 : gb(devices.filter((d) => view.gpu === 'auto' || d.index === view.gpu).reduce((a, d) => a + d.mem_total, 0));
  // The graphs of the last hour have no hardware limit: a round number above the largest reading.
  const reqMax = niceMax(Math.max(0, ...series.map((x) => x.requests)), 4);
  const speedMax = niceMax(Math.max(0, ...series.map((x) => x.tok_per_s ?? 0)), 20);
  const latencyMax = niceMax(Math.max(0, ...series.map((x) => x.latency_avg ?? 0)), 1);
  const hasVram = samples.some((x) => x.vram != null);
  const memName = memoryLabel(devices, t);
  const memReadable = devices.some((d) => d.supports.mem); // a machine whose GPU memory cannot be read gets a disabled graph

  const live = samples.length >= 2;
  const collecting = <div className="sub">{t('im.collecting')}</div>;

  // The parts of the monitor, grouped in four sections. The dialog shows each section as a box with folding parts; the window shows each as a
  // section like those of the main view: its header has the name, a button per part to switch it on or off, and the button that hides the section.
  const sections: { id: SectionId; title: string; parts: Part[] }[] = [
    {
      id: 'imModels', title: t('d.models'), parts: [
        {
          id: 'loaded', title: t('d.loaded'), body: view.loaded.length ? view.loaded.map((x) => (
            <div className="kv" key={x.name}><label>{x.name} · {x.gb.toFixed(1)} GB</label><span className="sub">{expAt(x.exp, view.keep, t)}</span></div>
          )) : <div className="sub">{t('d.none')}</div>,
        },
        {
          id: 'bymodel', title: t('rq.byModel'), body: p && Object.keys(p.models).length > 0 ? (
            <div className="rqw"><table className="rq"><tbody>
              <tr><th>{t('rq.model')}</th><th className="r">{t('rq.count')}</th><th className="r">{t('rq.speed')}</th><th className="r">{t('rq.avg')}</th></tr>
              {Object.entries(p.models).map(([name, x]) => (
                <tr key={name}><td>{name}</td>
                  <td className="r">{x.requests}{x.errors > 0 && <> <span className="bad">({x.errors})</span></>}</td>
                  <td className="r">{x.tok_per_s != null ? `${Math.round(x.tok_per_s)} tok/s` : '-'}</td>
                  <td className="r">{x.latency_avg != null ? `${x.latency_avg.toFixed(1)} s` : '-'}</td></tr>
              ))}
            </tbody></table></div>
          ) : <div className="sub">{t('rq.none')}</div>,
        },
      ],
    },
    {
      id: 'imState', title: t('f.state'), parts: [
        {
          id: 'now', title: t('im.now'), body: (
            <>
              <div className="sc">
                <Cell label={t('c.reqs')} value={p ? p.processing : '-'} unit={p ? ` ${t('u.case')}` : undefined} />
                <Cell label={t('c.queued')} value={p ? p.queued : '-'} unit={p ? ` ${t('u.case')}` : undefined} />
                <Cell label={t('c.fail')} value={p ? p.errors : '-'} unit={p ? ` ${t('u.case')}` : undefined} tone={p?.errors ? '--err' : undefined} />
              </div>
              <div className="sc" style={{ marginTop: 8 }}>
                <Cell label={t('c.latency')} value={fixed(p?.latency_avg)} unit={p?.latency_avg != null ? ' s' : undefined} />
                <Cell label={t('im.ttft')} value={fixed(p?.ttft_avg)} unit={p?.ttft_avg != null ? ' s' : undefined} />
                <Cell label={t('c.speed')} value={p?.tok_per_s != null ? Math.round(p.tok_per_s) : '-'} unit={p?.tok_per_s != null ? ' tok/s' : undefined} />
              </div>
              <div className="sub" style={{ marginTop: 8 }}>
                {t('im.window', { m: p ? Math.round(p.window_seconds / 60) : 5 })} · {t('d.uptime')} {running ? fmtUp(Date.now() - view.startedAt, t) : '-'}
              </div>
            </>
          ),
        },
        {
          id: 'hour', title: t('im.hour'), body: (
            <>
              <div className="sc" style={{ marginBottom: 12 }}>
                <Cell label={t('im.total')} value={<>{total} / <span style={errors ? { color: 'var(--err)' } : undefined}>{errors}</span></>} unit={` ${t('u.case')}`} />
                <Cell label={t('im.tokIn')} value={tokIn} />
                <Cell label={t('im.tokOut')} value={tokOut} />
              </div>
              <BarChart title={t('im.reqs')} value={nowReq} max={reqMax} bars={series.map((x) => ({ total: x.requests, errors: x.errors }))} left={hourLeft} right={hourRight} />
              <LineChart title={t('im.speed')} value={nowSpeed} points={series.map((x) => x.tok_per_s)} max={speedMax} left={hourLeft} right={hourRight} floor={1}
                format={(v) => `${Math.round(v)} tok/s`} />
              <LineChart title={t('im.latency')} value={nowLatency} points={series.map((x) => x.latency_avg)} max={latencyMax} left={hourLeft} right={hourRight} floor={1}
                format={(v) => `${v.toFixed(1)} s`} />
            </>
          ),
        },
      ],
    },
    {
      id: 'imRes', title: t('d.res'), parts: [
        {
          id: 'cpu', title: 'CPU', body: live ? <LineChart title="CPU" value={last ? `${last.cpu.toFixed(1)} %` : undefined} points={slots.map((x) => x?.cpu ?? null)} max={100}
            left={liveLeft} right={liveRight} format={(v) => `${Math.round(v)} %`} /> : collecting,
        },
        {
          id: 'mem', title: t('c.mem'), body: live ? <LineChart title={t('c.mem')} value={last ? `${last.rss.toFixed(1)} GB` : undefined} points={slots.map((x) => x?.rss ?? null)} max={memTotal}
            left={liveLeft} right={liveRight} format={(v) => `${v.toFixed(1)} GB`} /> : collecting,
        },
        ...(!memReadable ? [{
          id: 'vram', title: memName, body: (
            <div className="chart off"><div className="chh"><span className="sub">{memName}</span><span className="val">-</span></div><div className="plot" /><div className="sub off-note">{t('mon.unsupported')}</div></div>
          ),
        }] : []),
        ...(memReadable && hasVram ? [{
          id: 'vram', title: memName, body: (
            <LineChart title={memName} value={last?.vram != null ? `${last.vram.toFixed(1)} GB${m?.vram_source === 'estimated' ? ' ~' : ''}` : undefined}
              points={slots.map((x) => x?.vram ?? null)} max={vramTotal || undefined} left={liveLeft} right={liveRight} floor={1} format={(v) => `${v.toFixed(1)} GB`} />
          ),
        }] : []),
        {
          id: 'conc', title: t('im.conc'), body: live ? <LineChart title={t('im.conc')} value={last ? `${last.processing} + ${last.queued}` : undefined}
            points={slots.map((x) => (x ? x.processing + x.queued : null))} max={view.parallel} left={liveLeft} right={liveRight} floor={1} format={(v) => v.toFixed(1)} /> : collecting,
        },
      ],
    },
    {
      id: 'imLog', title: t('im.history'), parts: [
        {
          id: 'recent', title: t('rq.recent'), boxed: true, body: recent.length ? (
            <div className="rqw"><table className="rq"><tbody>
              <tr><th>{t('rq.time')}</th><th>{t('rq.path')}</th><th className="r">{t('rq.status')}</th><th className="r">{t('rq.dur')}</th><th className="r">{t('rq.tok')}</th></tr>
              {recent.map((r) => <RequestRow key={r.id} iid={id} r={r} />)}
            </tbody></table></div>
          ) : <div className="sub">{t('rq.none')}</div>,
        },
        { id: 'ilog', title: t('im.log'), boxed: true, body: <InstanceLog name={view.name} /> },
      ],
    },
  ];

  // the dialog's parts fold; the window's do not: a title, then what it shows (in a box of its own where `boxed`)
  const part = (x: Part) => <Collapse key={x.id} id={x.id} title={x.title}>{x.body}</Collapse>;
  const plainPart = (x: Part) => (
    <div className="mpart" key={x.id}>
      <div className="mpart__title">{x.title}</div>
      {x.boxed ? <div className="card">{x.body}</div> : x.body}
    </div>
  );

  if (folds) {
    return (
      <div id="dt">
        {sections.map((sec) => (
          <div className="box fgroup" key={sec.id}><div className="fgroup__head"><h4 className="fgroup__title">{sec.title}</h4></div>{sec.parts.map(part)}</div>
        ))}
      </div>
    );
  }
  return (
    <div id="dt">
      {sections.map((sec) => {
        const on = sec.parts.filter((x) => shown(x.id));
        const tabs = (
          <div className="tabs">
            {sec.parts.map((x) => <button key={x.id} className={`small${shown(x.id) ? ' on' : ''}`} onClick={() => toggleHide(x.id)}>{short(x.title)}</button>)}
          </div>
        );
        return (
          <Section key={sec.id} id={sec.id} title={sec.title} tabs={tabs}>
            {on.length > 0 && <div className="box fgroup">{on.map(plainPart)}</div>}
          </Section>
        );
      })}
    </div>
  );
}
