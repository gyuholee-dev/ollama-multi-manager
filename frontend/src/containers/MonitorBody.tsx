import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { InstanceSample, Perf, RequestsResponse, SeriesPoint } from '@/api/types';
import { BarChart, LineChart } from '@/components/charts/Charts';
import { Collapse } from '@/components/common/Collapse';
import type { InstanceView } from '@/lib/derive';
import { expAt, fmtUp, hms } from '@/lib/format';
import { useT } from '@/locales/useT';
import { useLogStore } from '@/stores/logStore';
import { MAX_SAMPLES, useHistoryStore, type Sample } from '@/stores/historyStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useUiStore } from '@/stores/uiStore';

const NONE: Sample[] = [];

/** The four kinds of information of the window; the buttons under its title switch each one on or off. */
const CATEGORIES: [string, string][] = [['models', 'd.models'], ['state', 'f.state'], ['res', 'd.res'], ['log', 'im.history']];

function Cell({ label, value, unit, tone }: { label: string; value: ReactNode; unit?: string; tone?: '--err' | '--warn' }) {
  return (
    <div>
      <div className="sub">{label}</div>
      <b style={tone ? { color: `var(${tone})` } : undefined}>{value}{unit ? <small>{unit}</small> : null}</b>
    </div>
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

/** The buttons that switch the four categories of the monitor on or off (they sit in the header of the dialog or window). */
export function CategoryButtons() {
  const t = useT();
  const imHide = useUiStore((s) => s.imHide);
  const toggleCat = useUiStore((s) => s.toggleImCat);
  return (
    <>
      {CATEGORIES.map(([key, label]) => (
        <button key={key} className={`small${imHide.includes(key) ? '' : ' on'}`} onClick={() => toggleCat(key)}>{t(label)}</button>
      ))}
    </>
  );
}

/** Live numbers and graphs of one running instance: what it is doing now, the last hour, and its resources. */
export function MonitorBody({ id, view }: { id: number; view: InstanceView }) {
  const t = useT();
  const snap = useMonitorStore((s) => s.snap);
  const samples = useHistoryStore((s) => s.series[String(id)] ?? NONE);
  const imFold = useUiStore((s) => s.imFold);
  const imHide = useUiStore((s) => s.imHide);
  const shown = (cat: string) => !imHide.includes(cat);
  const open = (key: string) => !imFold.includes(key);
  const [hour, setHour] = useState<SeriesPoint[] | null>(null);
  const [recent, setRecent] = useState<RequestsResponse['requests']>([]);

  useEffect(() => {
    let alive = true;
    // only what is shown is asked for
    Promise.all([
      shown('state') && open('hour') ? api.get<{ series: SeriesPoint[] }>(`/monitor/requests?minutes=60&instance=${id}`).then((r) => r.series) : Promise.resolve(null),
      shown('log') && open('recent') ? api.get<RequestsResponse>(`/instances/${id}/requests?limit=20`).then((q) => q.requests) : Promise.resolve(null),
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
  const minutes = samples.length > 1 ? Math.max(1, Math.round(((last?.ts ?? 0) - (samples[0]?.ts ?? 0)) / 60000)) : 0;
  const liveLeft = minutes ? t('im.span', { m: minutes }) : '';
  const liveRight = t('im.nowEdge');
  const series = hour ?? [];
  const total = sum(series.map((x) => x.requests));
  const errors = sum(series.map((x) => x.errors));
  const tokIn = sum(series.map((x) => x.prompt_tokens));
  const tokOut = sum(series.map((x) => x.tokens));
  const hourLeft = t('im.hourAgo'), hourRight = t('im.nowEdge');
  const maxMem = Math.max(1, ...samples.map((x) => x.rss));
  const hasVram = samples.some((x) => x.vram != null);

  const live = samples.length >= 2;
  const collecting = <div className="sub">{t('im.collecting')}</div>;

  return (
        <div id="dt">
          {shown('models') && (
          <div className="box"><b>{t('d.models')}</b>
            <Collapse id="loaded" title={t('d.loaded')}>
              {view.loaded.length ? view.loaded.map((x) => (
                <div className="f row" key={x.name}><label>{x.name} · {x.gb.toFixed(1)} GB</label><span className="sub">{expAt(x.exp, view.keep, t)}</span></div>
              )) : <div className="sub">{t('d.none')}</div>}
            </Collapse>
            <Collapse id="bymodel" title={t('rq.byModel')}>
              {p && Object.keys(p.models).length > 0 ? (
                <div className="rqw"><table className="rq"><tbody>
                  <tr><th>{t('rq.model')}</th><th className="r">{t('rq.count')}</th><th className="r">{t('rq.speed')}</th><th className="r">{t('rq.avg')}</th></tr>
                  {Object.entries(p.models).map(([name, x]) => (
                    <tr key={name}><td>{name}</td>
                      <td className="r">{x.requests}{x.errors > 0 && <> <span className="bad">({x.errors})</span></>}</td>
                      <td className="r">{x.tok_per_s != null ? `${Math.round(x.tok_per_s)} tok/s` : '-'}</td>
                      <td className="r">{x.latency_avg != null ? `${x.latency_avg.toFixed(1)} s` : '-'}</td></tr>
                  ))}
                </tbody></table></div>
              ) : <div className="sub">{t('rq.none')}</div>}
            </Collapse>
          </div>
          )}

          {shown('state') && (
          <div className="box"><b>{t('f.state')}</b>
            <Collapse id="now" title={t('im.now')}>
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
            </Collapse>
            <Collapse id="hour" title={t('im.hour')}>
              <div className="sc" style={{ marginBottom: 12 }}>
                <Cell label={t('im.total')} value={total} unit={` ${t('u.case')}`} />
                <Cell label={t('c.fail')} value={errors} unit={` ${t('u.case')}`} tone={errors ? '--err' : undefined} />
                <Cell label={t('im.tokens')} value={`${tokIn} / ${tokOut}`} />
              </div>
              <BarChart title={t('im.reqs')} bars={series.map((x) => ({ total: x.requests, errors: x.errors }))} left={hourLeft} right={hourRight} />
              <LineChart title={t('im.speed')} points={series.map((x) => x.tok_per_s)} left={hourLeft} right={hourRight} floor={1}
                format={(v) => `${Math.round(v)} tok/s`} />
              <LineChart title={t('im.latency')} points={series.map((x) => x.latency_avg)} left={hourLeft} right={hourRight} floor={1}
                format={(v) => `${v.toFixed(1)} s`} />
            </Collapse>
          </div>
          )}

          {shown('res') && (
          <div className="box"><b>{t('d.res')}</b>
            <Collapse id="cpu" title="CPU">
              {live ? <LineChart title="CPU" value={last ? `${last.cpu.toFixed(1)} %` : undefined} points={samples.map((x) => x.cpu)} max={Math.max(10, ...samples.map((x) => x.cpu))}
                left={liveLeft} right={liveRight} format={(v) => `${Math.round(v)} %`} /> : collecting}
            </Collapse>
            <Collapse id="mem" title={t('c.mem')}>
              {live ? <LineChart title={t('c.mem')} value={last ? `${last.rss.toFixed(1)} GB` : undefined} points={samples.map((x) => x.rss)} max={maxMem}
                left={liveLeft} right={liveRight} format={(v) => `${v.toFixed(1)} GB`} /> : collecting}
            </Collapse>
            {hasVram && (
              <Collapse id="vram" title="VRAM">
                <LineChart title="VRAM" value={last?.vram != null ? `${last.vram.toFixed(1)} GB${m?.vram_source === 'estimated' ? ' ~' : ''}` : undefined}
                  points={samples.map((x) => x.vram)} left={liveLeft} right={liveRight} floor={1} format={(v) => `${v.toFixed(1)} GB`} />
              </Collapse>
            )}
            <Collapse id="conc" title={t('im.conc')}>
              {live ? <LineChart title={t('im.conc')} value={last ? `${last.processing} + ${last.queued}` : undefined}
                points={samples.map((x) => x.processing + x.queued)} left={liveLeft} right={liveRight} floor={2} format={(v) => String(Math.round(v))} /> : collecting}
            </Collapse>
            <div className="sub" style={{ marginTop: 6 }}>{t('im.keepNote', { n: MAX_SAMPLES })}</div>
          </div>
          )}

          {shown('log') && (
          <div className="box"><b>{t('im.history')}</b>
            <Collapse id="recent" title={t('rq.recent')}>
              {recent.length ? (
                <div className="rqw"><table className="rq"><tbody>
                  <tr><th>{t('rq.time')}</th><th>{t('rq.path')}</th><th>{t('rq.model')}</th><th className="r">{t('rq.status')}</th><th className="r">{t('rq.dur')}</th><th className="r">{t('rq.tok')}</th></tr>
                  {recent.map((r, k) => (
                    <tr key={`${r.ts}-${k}`} className={r.outcome === 'error' ? 'bad' : r.outcome === 'cancelled' ? 'cx' : ''}>
                      <td>{hms(r.ts * 1000)}</td><td>{r.path}</td><td>{r.model || '-'}</td>
                      <td className="r">{r.outcome === 'cancelled' ? t('rq.cancelled') : r.status}</td>
                      <td className="r">{r.duration.toFixed(1)} s</td><td className="r">{r.prompt_tokens ?? '-'} / {r.tokens ?? '-'}</td></tr>
                  ))}
                </tbody></table></div>
              ) : <div className="sub">{t('rq.none')}</div>}
            </Collapse>
            <Collapse id="ilog" title={t('im.log')}>
              <InstanceLog name={view.name} />
            </Collapse>
          </div>
          )}
        </div>
  );
}

