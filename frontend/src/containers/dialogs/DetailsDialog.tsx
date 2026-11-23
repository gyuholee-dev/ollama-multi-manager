import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { Instance, InstalledModel, InstanceOptions } from '@/api/types';
import { changeState, reloadInstances } from '@/app/instanceActions';
import { ask, fail, notify, popup } from '@/app/dialogs';
import { useCpuName, useDevices, useExternal, useViews } from '@/app/hooks';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { ModelPicker } from '@/components/common/ModelPicker';
import { StateBadge } from '@/components/common/StateBadge';
import type { InstanceView } from '@/lib/derive';
import { expAt, fmtCtx, fmtKeep, fmtN, gpuLabel, normModel } from '@/lib/format';
import { API_KEY_MIN, randomKey } from '@/lib/random';
import { sizeText } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useInstancesStore } from '@/stores/instancesStore';
import { isGuest, useMonitorStore } from '@/stores/monitorStore';
import { useModelStore } from '@/stores/modelStore';
import { useSettingsStore } from '@/stores/settingsStore';

const Row = ({ k, children }: { k: string; children: ReactNode }) => <div className="kv"><label>{k}</label><span>{children}</span></div>;

const Models = ({ items, empty }: { items: { key: string; text: string }[]; empty: string }) => (
  <div className="ml">
    {items.length ? items.map((m, n) => <div key={m.key}>{n > 0 && <div className="gp" />}{m.text}</div>) : <div className="sub">{empty}</div>}
  </div>
);

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{title}</h4></div>{children}</div>
);

/** What the edit mode lets the user change: the name, the port and the options (the numbers are kept as typed until they are saved). */
interface Draft {
  name: string; port: string; gpu: string; ctx: string; keep: string; maxLoaded: string; parallel: string; kvq: InstanceOptions['kv_cache_type']; flash: boolean;
  auto: boolean; idle: string; lan: boolean; key: string; saveReq: boolean; modelsPath: string; allowed: string[];
}

const draftOf = (i: InstanceView): Draft => ({
  name: i.name, port: String(i.port), gpu: String(i.gpu), ctx: String(i.ctx), keep: String(i.keep), maxLoaded: String(i.maxLoaded), parallel: String(i.parallel),
  kvq: i.kvq as Draft['kvq'], flash: i.flash, auto: i.auto, idle: String(i.idle), lan: i.listen === 'lan', key: i.key ?? '', saveReq: i.saveRequests, modelsPath: i.modelsPath ?? '', allowed: i.allowed,
});

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function Details({ view: i }: { view: InstanceView }) {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const lanIp = useMonitorStore((s) => s.info?.lan_ip);
  const devices = useDevices();
  const cpuName = useCpuName();
  const external = useExternal();
  const list = useInstancesStore((s) => s.list);
  const monPort = useSettingsStore((s) => s.cfg.monPort);
  const [avail, setAvail] = useState<InstalledModel[]>([]);
  const installed = useModelStore((s) => s.list);
  const running = i.state === 'running';
  const allowedKey = i.allowed.join('|');
  const [draft, setDraft] = useState<Draft | null>(null); // not null = the edit mode
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;
  const start = useMemo(() => draftOf(i), [i.id, editing]); // eslint-disable-line react-hooks/exhaustive-deps -- what the edit began with (the instance stays stopped, so it does not move meanwhile)
  const dirty = editing && !same(draft, start);

  useEffect(() => {
    if (!running) { setAvail([]); return; }
    let alive = true;
    api.get<InstalledModel[]>(`/instances/${i.id}/models`).then((m) => { if (alive) setAvail(m); }, () => { /* shown as "none" */ });
    return () => { alive = false; };
  }, [i.id, running, allowedKey]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  /** "Edit": an instance that is running (or does not answer) has to be stopped first, after the user agrees. */
  const beginEdit = async () => {
    if (isGuest()) return;
    if (i.state === 'running' || i.state === 'unreachable') {
      if (!(await ask(t('det.stopAsk.t'), t('det.stopAsk.m', { n: i.name }), t('det.stopAsk.ok'), true))) return;
      await changeState(i.id, 'stopped'); // asks again about requests in progress; the user may still cancel there
      const now = useInstancesStore.getState().list.find((x) => x.id === i.id);
      if (!now || now.status.state === 'running') return;
    }
    setDraft(draftOf(i));
  };

  /** Leaving the edit mode (cancel) or the dialog (X, Escape, the backdrop) with changed values asks first. */
  const discard = async (): Promise<boolean> => {
    if (!dirty) return true;
    return !!(await popup({ kind: 'danger', title: t('det.discard.t'), msg: t('det.discard.m'), ok: t('det.discard.ok'), cancel: t('det.discard.keep') }));
  };
  const cancelEdit = async () => { if (await discard()) setDraft(null); };
  const closeAsked = async () => { if (await discard()) close(); };

  const save = async () => {
    if (!draft) return;
    const nm = draft.name.trim();
    const p = +draft.port;
    const used = [...list.filter((x) => x.id !== i.id).map((x) => x.port), ...(external ? [external.port] : [])];
    const bad: [string, string] | null = !nm ? [t('v.nameReq.t'), t('v.nameReq.m')]
      : list.some((x) => x.id !== i.id && x.name === nm) ? [t('v.nameDup.t'), t('v.nameDup.m', { n: nm })]
        : !(p >= 1024 && p <= 65535) ? [t('v.port.t'), t('v.port.m')]
          : used.includes(p) || p === monPort ? [t('port.conflict'), t('v.used.m', { p })]
            : !draft.allowed.length ? [t('v.models.t'), t('v.models.m')] : null;
    if (bad) { void notify('warn', ...bad); return; }
    if (draft.key.trim() && draft.key.trim().length < API_KEY_MIN) { void notify('warn', t('f.key'), t('key.short', { n: API_KEY_MIN })); return; }
    const raw = list.find((x) => x.id === i.id) as Instance;
    const options: InstanceOptions = {
      ...raw.options,
      gpu: draft.gpu === 'auto' || draft.gpu === 'cpu' ? draft.gpu : +draft.gpu, context_length: +draft.ctx, keep_alive_min: +draft.keep,
      max_loaded_models: +draft.maxLoaded, num_parallel: +draft.parallel, flash_attention: draft.flash, kv_cache_type: draft.kvq,
      models_path: draft.modelsPath.trim() || null, listen: draft.lan ? 'lan' : 'local', api_key: draft.key.trim() || null, allowed_models: draft.allowed,
      save_requests: draft.saveReq, auto_start: draft.auto, idle_stop_min: draft.auto ? Math.max(0, +draft.idle || 0) : 0,
    };
    setSaving(true);
    try {
      await api.patch(`/instances/${i.id}`, { name: nm, port: p, options });
      setDraft(null); // saved: the view mode again, and the instance stays stopped
    } catch (e) { await fail(e); }
    setSaving(false);
    await reloadInstances();
  };

  // The models the instance was limited to; without a limit, what the running instance reports.
  const allowedItems = i.allowed.map((name) => {
    const size = installed.find((x) => normModel(x.name) === normModel(name))?.size;
    return { key: name, text: size != null ? `${name} · ${sizeText(size)}` : name };
  });

  const on = (v: boolean) => t(v ? 'c.on' : 'c.off');
  const addr = i.listen === 'lan' ? `http://${lanIp ?? '?'}:${i.port}` : `http://127.0.0.1:${i.port}`;

  const text = (id: string, label: string, k: 'name' | 'port' | 'ctx' | 'keep' | 'maxLoaded' | 'parallel' | 'idle', type: 'text' | 'number' = 'number') => (
    <div className="fld"><label className="fld__label" htmlFor={id}>{label}</label>
      <input id={id} className="fld__text" type={type} value={draft?.[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
  );
  const note = (msg: string) => <p className="fld__note sub" style={{ margin: '0 0 8px' }}>{msg}</p>;
  const sw = (id: string, label: string, k: 'flash' | 'auto' | 'lan' | 'saveReq') => (
    <div className="fld"><label className="fld__label" htmlFor={id}>{label}</label>
      <input id={id} className="sw" type="checkbox" role="switch" checked={draft?.[k] ?? false} onChange={(e) => set(k, e.target.checked)} /></div>
  );

  const body = draft ? (
    <>
      <Group title={t('det.g.basic')}>
        {text('e-name', t('f.name'), 'name', 'text')}{draft.name.trim() !== i.name && note(t('det.nameNote'))}
        {text('e-port', t('f.port'), 'port')}{+draft.port !== i.port && note(t('det.portNote'))}
      </Group>
      <Group title={t('det.g.access')}>
        <Row k={t('d.addr')}>{addr}</Row>
        {sw('e-lan', t('f.lan'), 'lan')}
        <div className="fld"><label className="fld__label" htmlFor="e-key">{t('f.key')}</label>
          <input id="e-key" className="fld__text fld__text--grow" autoComplete="off" spellCheck={false} placeholder={t('f.keyPh')} value={draft.key} onChange={(e) => set('key', e.target.value)} />
          <button type="button" className="inline" aria-label={t('btn.genKey')} title={t('btn.genKey')} onClick={() => set('key', randomKey())}><span className="material-icons">autorenew</span></button></div>
        {sw('e-auto', t('f.auto'), 'auto')}
        {draft.auto && text('e-idle', t('f.idle'), 'idle')}
      </Group>
      <Group title={t('det.g.perf')}>
        <div className="fld"><label className="fld__label" htmlFor="e-gpu">{t('f.device')}</label>
          <span className="fld__select"><select id="e-gpu" value={draft.gpu} onChange={(e) => set('gpu', e.target.value)}>
            {['auto', 'cpu', ...devices.map((d) => String(d.index))].map((g) => <option key={g} value={g}>{gpuLabel(g === 'auto' || g === 'cpu' ? g : +g, devices, t, cpuName)}</option>)}
          </select><span className="material-icons">expand_more</span></span></div>
        {text('e-ctx', t('f.ctx'), 'ctx')}
        {text('e-keep', t('f.keep'), 'keep')}
        {text('e-max', t('f.maxLoaded'), 'maxLoaded')}
        {text('e-par', t('f.parallel'), 'parallel')}
        <div className="fld"><label className="fld__label" htmlFor="e-kvq">{t('f.kvq')}</label>
          <span className="fld__select"><select id="e-kvq" value={draft.kvq} onChange={(e) => set('kvq', e.target.value as Draft['kvq'])}>
            <option value="f16">{t('opt.f16')}</option><option value="q8_0">q8_0</option><option value="q4_0">q4_0</option>
          </select><span className="material-icons">expand_more</span></span></div>
        {sw('e-flash', t('f.flash'), 'flash')}
      </Group>
      <Group title={t('det.g.models')}>
        <div className="fld"><label className="fld__label" htmlFor="e-path">{t('f.modelsPath')}</label>
          <input id="e-path" className="fld__text fld__text--grow" spellCheck={false} placeholder={t('f.modelsPathPh')} value={draft.modelsPath} onChange={(e) => set('modelsPath', e.target.value)} /></div>
        <p className="fgroup__note sub">{t('new.modelsHint')}</p>
        <ModelPicker value={draft.allowed} onChange={(v) => set('allowed', v)} />
      </Group>
      <Group title={t('det.g.log')}>{sw('e-save', t('f.saveReq'), 'saveReq')}</Group>
      <p className="sub">{t('det.afterSave')}</p>
    </>
  ) : (
    <>
      <Group title={t('det.g.basic')}>
        <Row k={t('f.name')}>{i.name}</Row>
        <Row k={t('f.port')}>{i.port}</Row>
      </Group>
      <Group title={t('det.g.access')}>
        <Row k={t('d.addr')}>{addr}</Row>
        <Row k={t('f.lan')}>{on(i.listen === 'lan')}</Row>
        <Row k={t('f.key')}>{i.key ? i.key : on(false)}</Row>
        <Row k={t('f.auto')}>{i.auto ? (i.idle ? t('auto.idle', { n: i.idle }) : t('c.on')) : t('c.off')}</Row>
      </Group>
      <Group title={t('det.g.perf')}>
        <Row k={t('f.device')}>{gpuLabel(i.gpu, devices, t, cpuName)}</Row>
        <Row k={t('f.ctx')}>{fmtCtx(i.ctx)}</Row>
        <Row k={t('f.keep')}>{fmtKeep(i.keep, t) + (i.keep >= 0 && i.loaded.length ? ` · ${expAt(i.loaded[0]?.exp ?? null, i.keep, t)}` : '')}</Row>
        <Row k={t('f.maxLoaded')}>{fmtN(i.maxLoaded, t)}</Row>
        <Row k={t('f.parallel')}>{fmtN(i.parallel, t)}</Row>
        <Row k={t('f.kvq')}>{i.kvq}</Row>
        <Row k={t('f.flash')}>{on(i.flash)}</Row>
      </Group>
      <Group title={t('det.g.models')}>
        <Row k={t('f.modelsPath')}>{i.modelsPath ?? '-'}</Row>
        <div className="kv"><label>{t('d.allowed')}</label><Models empty={t('d.allowedAll')} items={allowedItems} /></div>
        <div className="kv"><label>{t('d.loaded')}</label><Models empty={t('d.none')} items={i.loaded.map((x) => ({ key: x.name, text: `${x.name} · ${x.gb.toFixed(1)} GB` }))} /></div>
        {running && <div className="kv"><label>{t('d.avail')}</label><Models empty={t('d.none')} items={avail.map((x) => ({ key: x.name, text: `${x.name} · ${sizeText(x.size)}` }))} /></div>}
      </Group>
      <Group title={t('det.g.log')}><Row k={t('f.saveReq')}>{on(i.saveRequests)}</Row></Group>
    </>
  );

  return (
    <Dialog id="det" onClose={close} guard={{ allow: () => !dirty, blocked: () => void closeAsked() }}>
      <DialogTitle onClose={() => void closeAsked()}>{i.name} <StateBadge state={i.state} /></DialogTitle>
      <DialogBody><div id="dt">
        {body}
        {!isGuest() && (
          <div className="btns" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            {draft
              ? <>
                <button type="button" disabled={saving} onClick={() => void cancelEdit()}>{t('btn.cancel')}</button>
                <button type="button" className="primary" disabled={saving || !draft.allowed.length} onClick={() => void save()}>{t('btn.save')}</button>
              </>
              : <button type="button" disabled={i.state === 'starting' || i.state === 'stopping'} onClick={() => void beginEdit()}>{t('det.edit')}</button>}
          </div>
        )}
      </div></DialogBody>
    </Dialog>
  );
}

/** The details of one instance; the edit mode changes its name, port and options (only while it is stopped). */
export function DetailsDialog({ id }: { id: number }) {
  const view = useViews().find((v) => v.id === id);
  return view ? <Details view={view} /> : null;
}
