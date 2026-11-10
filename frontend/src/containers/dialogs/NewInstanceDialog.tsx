import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api } from '@/api/client';
import type { InstanceCreate } from '@/api/types';
import { reloadInstances } from '@/app/instanceActions';
import { fail, notify, popup } from '@/app/dialogs';
import { useDevices, useExternal } from '@/app/hooks';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { Fold } from '@/components/common/Fold';
import { ModelPicker } from '@/components/common/ModelPicker';
import { fmtCtx, fmtKeep, fmtN, gpuLabel, KEEP } from '@/lib/format';
import { gb } from '@/lib/units';
import { modelNeed, unifiedRoom } from '@/lib/memory';
import { useMonitorStore } from '@/stores/monitorStore';
import { useModelStore } from '@/stores/modelStore';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useInstancesStore } from '@/stores/instancesStore';
import { useSettingsStore } from '@/stores/settingsStore';

const FALLBACK_PORT = 11435;

function Slider({ label, shown, min, max, value, onChange }: { label: string; shown: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div className="fld fld--stack">
      <div className="fld__head"><label className="fld__label">{label}</label><span className="fld__value">{shown}</span></div>
      <input className="rg" type="range" min={min} max={max} step={1} value={value} style={{ '--p': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}

const randomKey = (): string => { // 24 random bytes as URL-safe text
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '');
};

function Form({ port: firstPort }: { port: number }) {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const list = useInstancesStore((s) => s.list);
  const monPort = useSettingsStore((s) => s.cfg.monPort);
  const external = useExternal();
  const devices = useDevices();
  const system = useMonitorStore((s) => s.snap?.system);

  const [name, setName] = useState(() => { let k = 1; while (list.some((i) => i.name === `worker-${k}`)) k++; return `worker-${k}`; });
  const [port, setPort] = useState(String(firstPort));
  const [ctx, setCtx] = useState(3);
  const [keep, setKeep] = useState(1);
  const [maxLoaded, setMaxLoaded] = useState(2);
  const [parallel, setParallel] = useState(2);
  const [gpu, setGpu] = useState('auto');
  const [kvq, setKvq] = useState<'f16' | 'q8_0' | 'q4_0'>('f16');
  const [flash, setFlash] = useState(true);
  const [auto, setAuto] = useState(false);
  const [idle, setIdle] = useState('10');
  const [lan, setLan] = useState(false);
  const [key, setKey] = useState('');
  const [saveReq, setSaveReq] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const installed = useModelStore((s) => s.list);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const nm = name.trim();
    const p = +port;
    const used = [...list.map((i) => i.port), ...(external ? [external.port] : [])];
    const bad: [string, string] | null = !nm ? [t('v.nameReq.t'), t('v.nameReq.m')]
      : list.some((i) => i.name === nm) ? [t('v.nameDup.t'), t('v.nameDup.m', { n: nm })]
        : !(p >= 1024 && p <= 65535) ? [t('v.port.t'), t('v.port.m')]
          : used.includes(p) || p === monPort ? [t('port.conflict'), t('v.used.m', { p })]
            : !allowed.length ? [t('v.models.t'), t('v.models.m')] : null;
    if (bad) { void notify('warn', ...bad); return; }
    const body: InstanceCreate = {
      name: nm, port: p,
      options: {
        gpu: gpu === 'auto' || gpu === 'cpu' ? gpu : +gpu, context_length: 2048 * 2 ** (ctx - 1), keep_alive_min: KEEP[keep] ?? 5,
        max_loaded_models: maxLoaded, num_parallel: parallel, flash_attention: flash, kv_cache_type: kvq,
        models_path: null, listen: lan ? 'lan' : 'local', api_key: key.trim() || null, allowed_models: allowed, save_requests: saveReq,
        auto_start: auto, idle_stop_min: auto ? Math.max(0, +idle || 0) : 0,
      },
    };
    const need = modelNeed(installed, allowed, maxLoaded); // the biggest models that can sit in memory together
    const device = gpu === 'cpu' ? undefined : devices[gpu === 'auto' ? 0 : +gpu];
    const room = unifiedRoom(devices, gpu === 'cpu' || gpu === 'auto' ? gpu : +gpu, system);
    if (room) {
      // memory shared with the CPU: compare with what can really be used now (the pool's free part and what is left under the GPU's maximum)
      if (need > room.cap
        && !(await popup({ kind: 'warn', title: t('w.fitUma.t'), msg: room.room == null ? t('w.fitUma.cpu', { need: need.toFixed(1), cap: room.cap.toFixed(1) }) : t('w.fitUma.m', { need: need.toFixed(1), cap: room.cap.toFixed(1), avail: room.avail.toFixed(1), room: room.room.toFixed(1) }), ok: t('btn.create'), cancel: t('btn.cancel') }))) return;
    } else if (device && need > gb(device.mem_total)
      && !(await popup({ kind: 'warn', title: t('w.fit.t'), msg: t('w.fit.m', { need: need.toFixed(1), cap: gb(device.mem_total).toFixed(1) }), ok: t('btn.create'), cancel: t('btn.cancel') }))) return;
    if (body.options.listen === 'lan' && !body.options.api_key
      && !(await popup({ kind: 'warn', title: t('w.lan.t'), msg: t('w.lan.m'), ok: t('btn.open'), cancel: t('btn.cancel') }))) return;
    try {
      await api.post('/instances', body);
      close();
    } catch (e) { await notify('warn', t('err.title'), e instanceof Error ? e.message : String(e)); }
    await reloadInstances();
  };

  return (
    <Dialog id="dlg" onClose={close}>
      <DialogTitle onClose={close}>{t('new.title')}</DialogTitle>
      <DialogBody><form onSubmit={(e) => void submit(e)}>
        <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('new.server')}</h4></div>
          <div className="fld"><label className="fld__label" htmlFor="n">{t('f.name')}</label><input id="n" className="fld__text fld__text--grow" required placeholder="worker-4" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="fld"><label className="fld__label" htmlFor="p">{t('f.port')}</label><input id="p" className="fld__text" type="number" required placeholder="11438" value={port} onChange={(e) => setPort(e.target.value)} /></div>
          <Fold title={t('new.general')} hint={t('new.generalT')}>
            <Slider label={t('f.ctx')} shown={fmtCtx(2048 * 2 ** (ctx - 1))} min={1} max={7} value={ctx} onChange={setCtx} />
            <Slider label={t('f.keep')} shown={fmtKeep(KEEP[keep] ?? 5, t)} min={0} max={9} value={keep} onChange={setKeep} />
            <Slider label={t('f.maxLoaded')} shown={fmtN(maxLoaded, t)} min={1} max={4} value={maxLoaded} onChange={setMaxLoaded} />
            <Slider label={t('f.parallel')} shown={fmtN(parallel, t)} min={1} max={8} value={parallel} onChange={setParallel} />
          </Fold>
          <Fold title={t('new.advanced')} hint={t('new.advancedT')}>
            <div className="fld"><label className="fld__label" htmlFor="gp">{t('f.device')}</label>
              <span className="fld__select"><select id="gp" value={gpu} onChange={(e) => setGpu(e.target.value)}>
                {['auto', 'cpu', ...devices.map((d) => String(d.index))].map((g) => <option key={g} value={g}>{gpuLabel(g === 'auto' || g === 'cpu' ? g : +g, devices, t)}</option>)}
              </select><span className="material-icons">expand_more</span></span></div>
            <div className="fld"><label className="fld__label" htmlFor="kvq">{t('f.kvq')}</label>
              <span className="fld__select"><select id="kvq" value={kvq} onChange={(e) => setKvq(e.target.value as typeof kvq)}>
                <option value="f16">{t('opt.f16')}</option><option value="q8_0">q8_0</option><option value="q4_0">q4_0</option>
              </select><span className="material-icons">expand_more</span></span></div>
            <div className="fld"><label className="fld__label" htmlFor="fa">{t('f.flash')}</label><input id="fa" className="sw" type="checkbox" role="switch" checked={flash} onChange={(e) => setFlash(e.target.checked)} /></div>
            <div className="fld"><label className="fld__label" htmlFor="as">{t('f.auto')}</label><input id="as" className="sw" type="checkbox" role="switch" checked={auto} onChange={(e) => setAuto(e.target.checked)} /></div>
            {auto && <div className="fld"><label className="fld__label" htmlFor="ist">{t('f.idle')}</label><input id="ist" className="fld__text" type="number" min={0} max={1440} value={idle} onChange={(e) => setIdle(e.target.value)} /></div>}
            <div className="fld"><label className="fld__label" htmlFor="lan">{t('f.lan')}</label><input id="lan" className="sw" type="checkbox" role="switch" checked={lan} onChange={(e) => setLan(e.target.checked)} /></div>
            <div className={saveReq ? 'fld fld--note' : 'fld'}>
              <label className="fld__label" htmlFor="sr">{t('f.saveReq')}</label>
              <input id="sr" className="sw" type="checkbox" role="switch" checked={saveReq} onChange={(e) => setSaveReq(e.target.checked)} />
              {saveReq && <span className="fld__note sub">{t('f.saveReqHint')}</span>}
            </div>
            <div className="fld fld--stack"><label className="fld__label" htmlFor="ak">{t('f.key')}</label>
              <span className="pr"><input id="ak" className="fld__box" autoComplete="off" spellCheck={false} placeholder={t('f.keyPh')} value={key} onChange={(e) => setKey(e.target.value)} />
                <button type="button" onClick={() => setKey(randomKey())}>{t('btn.genKey')}</button></span></div>
          </Fold>
        </div>
        <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('new.models')}</h4><p className="fgroup__note sub">{t('new.modelsHint')}</p></div>
          <ModelPicker value={allowed} onChange={setAllowed} />
        </div>
        <div className="btns" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={close}>{t('btn.cancel')}</button>
          <button className="primary" id="mk" disabled={!allowed.length}>{t('btn.create')}</button>
        </div>
      </form></DialogBody>
    </Dialog>
  );
}

/** Asks the backend for a free port first; the form opens once there is one. */
export function NewInstanceDialog() {
  const close = useDialogStore((s) => s.close);
  const [port, setPort] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ port: number }>('/instances/next-port').then(
      (r) => { if (alive) setPort(r.port ?? FALLBACK_PORT); },
      (e) => { if (alive) { close(); void fail(e); } },
    );
    return () => { alive = false; };
  }, [close]);
  return port === null ? null : <Form port={port} />;
}
