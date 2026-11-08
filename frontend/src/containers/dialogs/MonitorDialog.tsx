import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { Perf, RequestsResponse, SeriesPoint } from '@/api/types';
import { useViews } from '@/app/hooks';
import { BarChart, LineChart } from '@/components/charts/Charts';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { expAt, fmtUp, hms } from '@/lib/format';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { MAX_SAMPLES, useHistoryStore, type Sample } from '@/stores/historyStore';
import { useMonitorStore } from '@/stores/monitorStore';

const NONE: Sample[] = [];

function Cell({ label, value, unit, tone }: { label: string; value: ReactNode; unit?: string; tone?: '--err' | '--warn' }) {
  return (
    <div>
      <div className="sub">{label}</div>
      <b style={tone ? { color: `var(${tone})` } : undefined}>{value}{unit ? <small>{unit}</small> : null}</b>
    </div>
  );
}

const fixed = (v: number | null | undefined, digits = 1): string => (v == null ? '-' : v.toFixed(digits));
const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

/** Live numbers and graphs of one running instance: what it is doing now, the last hour, and its resources. */
export function MonitorDialog({ id }: { id: number }) {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const view = useViews().find((v) => v.id === id);
  const snap = useMonitorStore((s) => s.snap);
  const samples = useHistoryStore((s) => s.series[String(id)] ?? NONE);
  const [hour, setHour] = useState<SeriesPoint[] | null>(null);
  const [recent, setRecent] = useState<RequestsResponse['requests']>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<{ series: SeriesPoint[] }>(`/monitor/requests?minutes=60&instance=${id}`),
      api.get<RequestsResponse>(`/instances/${id}/requests?limit=20`),
    ]).then(([r, q]) => { if (alive) { setHour(r.series); setRecent(q.requests); } }, () => { /* keep what is shown */ });
    return () => { alive = false; };
  }, [id, snap]);

  if (!view) return null;
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

  return (
    <Dialog id="det" onClose={close}>
      <DialogTitle onClose={close}>{t('im.title', { n: view.name })}</DialogTitle>
      <DialogBody>
        <div id="dt">
          <div className="box"><b>{t('im.now')}</b>
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
          </div>

          <div className="box"><b>{t('im.hour')}</b>
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
          </div>

          <div className="box"><b>{t('im.live')}</b>
            {samples.length < 2 ? <div className="sub">{t('im.collecting')}</div> : (
              <>
                <LineChart title="CPU" value={last ? `${last.cpu.toFixed(1)} %` : undefined} points={samples.map((x) => x.cpu)} max={Math.max(10, ...samples.map((x) => x.cpu))}
                  left={liveLeft} right={liveRight} format={(v) => `${Math.round(v)} %`} />
                <LineChart title={t('c.mem')} value={last ? `${last.rss.toFixed(1)} GB` : undefined} points={samples.map((x) => x.rss)} max={maxMem}
                  left={liveLeft} right={liveRight} format={(v) => `${v.toFixed(1)} GB`} />
                {hasVram && (
                  <LineChart title="VRAM" value={last?.vram != null ? `${last.vram.toFixed(1)} GB${m?.vram_source === 'estimated' ? ' ~' : ''}` : undefined}
                    points={samples.map((x) => x.vram)} left={liveLeft} right={liveRight} floor={1} format={(v) => `${v.toFixed(1)} GB`} />
                )}
                <LineChart title={t('im.conc')} value={last ? `${last.processing} + ${last.queued}` : undefined}
                  points={samples.map((x) => x.processing + x.queued)} left={liveLeft} right={liveRight} floor={2} format={(v) => String(Math.round(v))} />
                <div className="sub" style={{ marginTop: 6 }}>{t('im.keepNote', { n: MAX_SAMPLES })}</div>
              </>
            )}
          </div>

          <div className="box"><b>{t('d.loaded')}</b>
            {view.loaded.length ? view.loaded.map((x) => (
              <div className="f row" key={x.name}><label>{x.name} · {x.gb.toFixed(1)} GB</label><span className="sub">{expAt(x.exp, view.keep, t)}</span></div>
            )) : <div className="sub">{t('d.none')}</div>}
          </div>

          <div className="box"><b>{t('rq.recent')}</b>
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
          </div>

          {p && Object.keys(p.models).length > 0 && (
            <div className="box"><b>{t('rq.byModel')}</b>
              <div className="rqw"><table className="rq"><tbody>
                <tr><th>{t('rq.model')}</th><th className="r">{t('rq.count')}</th><th className="r">{t('rq.speed')}</th><th className="r">{t('rq.avg')}</th></tr>
                {Object.entries(p.models).map(([name, x]) => (
                  <tr key={name}><td>{name}</td>
                    <td className="r">{x.requests}{x.errors > 0 && <> <span className="bad">({x.errors})</span></>}</td>
                    <td className="r">{x.tok_per_s != null ? `${Math.round(x.tok_per_s)} tok/s` : '-'}</td>
                    <td className="r">{x.latency_avg != null ? `${x.latency_avg.toFixed(1)} s` : '-'}</td></tr>
                ))}
              </tbody></table></div>
            </div>
          )}
        </div>
      </DialogBody>
    </Dialog>
  );
}
