import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { InstalledModel, RequestsResponse, SeriesPoint } from '@/api/types';
import { useDevices, useViews } from '@/app/hooks';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { StateBadge } from '@/components/common/StateBadge';
import type { InstanceView } from '@/lib/derive';
import { expAt, fmtCtx, fmtKeep, fmtN, fmtUp, gpuLabel, hms, normModel } from '@/lib/format';
import { gb } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useModelStore } from '@/stores/modelStore';

const Row = ({ k, children }: { k: string; children: ReactNode }) => <div className="f row"><label>{k}</label><span>{children}</span></div>;

const Models = ({ items, empty }: { items: { key: string; text: string }[]; empty: string }) => (
  <div className="ml">
    {items.length ? items.map((m, n) => <div key={m.key}>{n > 0 && <div className="gp" />}{m.text}</div>) : <div className="sub">{empty}</div>}
  </div>
);

// Last hour, one column per minute: requests (red part = failed) and the generation speed.
function Charts({ series }: { series: SeriesPoint[] }) {
  const t = useT();
  const n = series.length, w = 300, h = 44, bw = w / n;
  const maxR = Math.max(1, ...series.map((x) => x.requests));
  const speeds = series.map((x, k) => [k, x.tok_per_s] as const).filter((p): p is [number, number] => p[1] != null);
  const maxS = Math.max(1, ...speeds.map((p) => p[1]));
  const total = series.reduce((a, x) => a + x.requests, 0);
  const label1 = t('rq.hour', { n: total }), label2 = t('rq.hourSpeed', { n: Math.round(maxS) });
  return (
    <>
      <div className="sub">{label1}</div>
      <svg className="rqc" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label1}>
        {series.map((x, k) => {
          if (!x.requests) return null;
          const bh = Math.max(2, (x.requests / maxR) * (h - 4)), eh = (x.errors / x.requests) * bh;
          const bx = (k * bw + 0.5).toFixed(1), width = Math.max(1, bw - 1).toFixed(1);
          return (
            <g key={k}>
              <rect x={bx} y={(h - bh).toFixed(1)} width={width} height={(bh - eh).toFixed(1)} fill="var(--accent)" />
              {eh > 0 && <rect x={bx} y={(h - eh).toFixed(1)} width={width} height={eh.toFixed(1)} fill="var(--err)" />}
            </g>
          );
        })}
      </svg>
      <div className="sub" style={{ marginTop: 8 }}>{label2}</div>
      <svg className="rqc" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label2}>
        {speeds.length > 0 && (
          <polyline fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
            points={speeds.map(([k, v]) => `${(k * bw + bw / 2).toFixed(1)},${(h - 3 - (v / maxS) * (h - 6)).toFixed(1)}`).join(' ')} />
        )}
      </svg>
      <div style={{ height: 10 }} />
    </>
  );
}

/** Per-model numbers and the latest requests (no prompts or answers are kept). Refreshed with every snapshot. */
function Requests({ id }: { id: number }) {
  const t = useT();
  const snap = useMonitorStore((s) => s.snap);
  const [data, setData] = useState<{ d: RequestsResponse; series: SeriesPoint[] } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<RequestsResponse>(`/instances/${id}/requests?limit=20`),
      api.get<{ series: SeriesPoint[] }>(`/monitor/requests?minutes=60&instance=${id}`),
    ]).then(([d, s]) => { if (alive) setData({ d, series: s.series }); }, () => { /* keep what is shown */ });
    return () => { alive = false; };
  }, [id, snap]);
  if (!data) return null;
  const models = Object.entries(data.d.models);
  const { requests } = data.d;
  return (
    <>
      <Charts series={data.series} />
      {models.length > 0 && (
        <>
          <div className="sub">{t('rq.byModel')}</div>
          <div className="rqw"><table className="rq"><tbody>
            <tr><th>{t('rq.model')}</th><th className="r">{t('rq.count')}</th><th className="r">{t('rq.speed')}</th><th className="r">{t('rq.avg')}</th></tr>
            {models.map(([m, x]) => (
              <tr key={m}><td>{m}</td>
                <td className="r">{x.requests}{x.errors > 0 && <> <span className="bad">({x.errors})</span></>}</td>
                <td className="r">{x.tok_per_s != null ? `${Math.round(x.tok_per_s)} tok/s` : '-'}</td>
                <td className="r">{x.latency_avg != null ? `${x.latency_avg.toFixed(1)} s` : '-'}</td></tr>
            ))}
          </tbody></table></div>
        </>
      )}
      <div className="sub" style={{ marginTop: models.length ? 10 : 0 }}>{t('rq.recent')}</div>
      {requests.length ? (
        <div className="rqw"><table className="rq"><tbody>
          <tr><th>{t('rq.time')}</th><th>{t('rq.path')}</th><th>{t('rq.model')}</th><th className="r">{t('rq.status')}</th><th className="r">{t('rq.dur')}</th><th className="r">{t('rq.tok')}</th></tr>
          {requests.map((r, k) => (
            <tr key={`${r.ts}-${k}`} className={r.outcome === 'error' ? 'bad' : r.outcome === 'cancelled' ? 'cx' : ''}>
              <td>{hms(r.ts * 1000)}</td><td>{r.path}</td><td>{r.model || '-'}</td>
              <td className="r">{r.outcome === 'cancelled' ? t('rq.cancelled') : r.status}</td>
              <td className="r">{r.duration.toFixed(1)} s</td><td className="r">{r.prompt_tokens ?? '-'} / {r.tokens ?? '-'}</td></tr>
          ))}
        </tbody></table></div>
      ) : <div className="sub">{t('rq.none')}</div>}
    </>
  );
}

function Details({ view: i }: { view: InstanceView }) {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const lanIp = useMonitorStore((s) => s.info?.lan_ip);
  const devices = useDevices();
  const [avail, setAvail] = useState<InstalledModel[]>([]);
  const installed = useModelStore((s) => s.list);
  const running = i.state === 'running';
  const allowedKey = i.allowed.join('|');
  useEffect(() => {
    if (!running) { setAvail([]); return; }
    let alive = true;
    api.get<InstalledModel[]>(`/instances/${i.id}/models`).then((m) => { if (alive) setAvail(m); }, () => { /* shown as "none" */ });
    return () => { alive = false; };
  }, [i.id, running, allowedKey]);

  // The models the instance was limited to; without a limit, what the running instance reports.
  const availableItems = i.allowed.length
    ? i.allowed.map((name) => {
      const size = installed.find((x) => normModel(x.name) === normModel(name))?.size;
      return { key: name, text: size != null ? `${name} · ${gb(size).toFixed(1)} GB` : name };
    })
    : avail.map((x) => ({ key: x.name, text: `${x.name} · ${gb(x.size).toFixed(1)} GB` }));

  const m = i.metrics;
  const vram = m?.vram_bytes != null ? `${gb(m.vram_bytes).toFixed(1)} GB${m.vram_source === 'estimated' ? ' ~' : ''}` : '-';
  const on = (v: boolean) => t(v ? 'c.on' : 'c.off');
  return (
    <Dialog id="det" onClose={close}>
      <DialogTitle onClose={close}>{i.name}</DialogTitle>
      <DialogBody><div id="dt">
        <div className="box"><b>{t('new.server')}</b>
          <Row k={t('f.state')}><StateBadge state={i.state} /></Row>
          <Row k={t('f.port')}>{i.port}</Row>
          <Row k={t('d.addr')}>{i.listen === 'lan' ? `http://${lanIp ?? '?'}:${i.port}` : `http://127.0.0.1:${i.port}`}</Row>
          <Row k={t('f.auto')}>{i.auto ? (i.idle ? t('auto.idle', { n: i.idle }) : t('c.on')) : t('c.off')}</Row>
          <Row k={t('f.lan')}>{on(i.listen === 'lan')}</Row>
          <Row k={t('f.key')}>{on(!!i.key)}</Row>
          <Row k={t('d.pid')}>{i.pid ?? '-'}</Row>
          <Row k={t('d.uptime')}>{running ? fmtUp(Date.now() - i.startedAt, t) : '-'}</Row>
          <Row k={t('f.maxLoaded')}>{fmtN(i.maxLoaded, t)}</Row>
          <Row k={t('f.parallel')}>{fmtN(i.parallel, t)}</Row>
        </div>
        <div className="box"><b>{t('d.models')}</b>
          <div className="f row"><label>{t('d.loaded')}</label><Models empty={t('d.none')} items={i.loaded.map((x) => ({ key: x.name, text: `${x.name} · ${x.gb.toFixed(1)} GB` }))} /></div>
          <div className="f row"><label>{t('d.avail')}</label><Models empty={t('d.none')} items={availableItems} /></div>
        </div>
        <div className="box"><b>{t('d.req')}</b><div id="rq"><Requests id={i.id} /></div></div>
        <div className="box"><b>{t('d.res')}</b>
          <Row k={t('d.vram')}>{vram}</Row>
          <Row k={t('f.ctx')}>{fmtCtx(i.ctx)}</Row>
          <Row k={t('f.keep')}>{fmtKeep(i.keep, t) + (i.keep >= 0 && i.loaded.length ? ` · ${expAt(i.loaded[0]?.exp ?? null, i.keep, t)}` : '')}</Row>
          <Row k={t('f.device')}>{gpuLabel(i.gpu, devices, t)}</Row>
          <Row k={t('f.kvq')}>{i.kvq}</Row>
          <Row k={t('f.flash')}>{on(i.flash)}</Row>
        </div>
      </div></DialogBody>
    </Dialog>
  );
}

/** The details of one instance. */
export function DetailsDialog({ id }: { id: number }) {
  const view = useViews().find((v) => v.id === id);
  return view ? <Details view={view} /> : null;
}
