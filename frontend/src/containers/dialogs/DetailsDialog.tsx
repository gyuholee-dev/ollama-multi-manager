import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { InstalledModel } from '@/api/types';
import { useDevices, useViews } from '@/app/hooks';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { StateBadge } from '@/components/common/StateBadge';
import type { InstanceView } from '@/lib/derive';
import { expAt, fmtCtx, fmtKeep, fmtN, fmtUp, gpuLabel, normModel } from '@/lib/format';
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
