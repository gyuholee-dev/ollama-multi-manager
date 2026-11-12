import { useEffect, useRef, useState } from 'react';
import type { InstalledModel, ModelDetail, ModelParameters, PullTask } from '@/api/types';
import { createModel, loadModelDetail, loadModels, pullAction, removeModel, removePull, startPull } from '@/app/modelActions';
import { notify } from '@/app/dialogs';
import { DialogBody, PageTitle } from '@/components/common/Dialog';
import { Fold } from '@/components/common/Fold';
import { Icon } from '@/components/common/Icon';
import { Slide } from '@/components/common/Slide';
import { copyText } from '@/lib/clipboard';
import { compareModels, derivedFrom, fmtCtx, normModel, splitModel } from '@/lib/format';
import { sizeBoth, sizeText, sizeTitle } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useModelStore } from '@/stores/modelStore';
import { unfinished, usePullStore } from '@/stores/pullStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePageBack } from '../pageBack';

/** A download in the list under the input: one line of 30px (the library link, its name and progress, and pause/resume and delete), and under it a thin progress bar that takes the place of a border. */
function DownloadRow({ task }: { task: PullTask }) {
  const t = useT();
  const off = task.status !== 'pulling';
  const pct = `${Math.floor(task.percent ?? 0)}%`;
  const size = task.total ? ` · ${sizeText(task.completed)} / ${sizeText(task.total)}` : '';
  const sizeHint = task.total ? `${sizeTitle(task.completed) ?? sizeText(task.completed)} / ${sizeTitle(task.total) ?? sizeText(task.total)}` : undefined; // the same in GiB
  const text = task.status === 'paused' ? `${t('mdl.paused')} · ${pct}${size}` : task.status === 'error' ? `${t('mdl.failed')} · ${pct}${size}` : pct + size;
  return (
    <div className="mrow mrow--dl" id={`dl-${task.id}`} data-s={task.status}>
      <span className="mrow__title">
        <a className="inline mrow__icon" href={`https://ollama.com/library/${encodeURI(task.model)}`} target="_blank" rel="noopener noreferrer" aria-label={t('mdl.library')} title={t('mdl.library')}><Icon name="open_in_new" /></a>
        <span className="mrow__name">{task.model}</span><span className="sub mrow__size" title={sizeHint}>{text}</span>
      </span>
      <span className="mrow__acts">
        <button type="button" className="inline" aria-label={t(off ? 'btn.resume' : 'btn.pause')} title={t(off ? 'btn.resume' : 'btn.pause')} onClick={() => void pullAction(task.id, off ? 'resume' : 'pause')}><Icon name={off ? 'play_arrow' : 'pause'} /></button>
        <button type="button" className="inline" aria-label={t('btn.delete')} title={t('btn.delete')} onClick={() => void removePull(task.id)}><Icon name="delete" /></button>
      </span>
      <span className="mrow__bar"><span className={`dl${off ? ' off' : ''}`}><i style={{ width: `${task.percent ?? 0}%` }} /></span></span>
    </div>
  );
}

/** An arrow that points right when shut and down when open, turning between the two. */
const Chevron = ({ open }: { open: boolean }) => <span className={open ? 'material-icons chev chev--open' : 'material-icons chev'}>expand_more</span>;

/** One block of text from `ollama show` (the Modelfile, the template ...): a row that opens to the text, with a copy button. */
function RawBlock({ title, text }: { title: string; text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const copy = async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } };
  return (
    <>
      <div className="kv raw">
        <span className="raw__title">
          <button type="button" className="inline" aria-expanded={open} aria-label={title} title={title} onClick={() => setOpen(!open)}><Chevron open={open} /></button>
          <label onClick={() => setOpen(!open)}>{title}</label>
        </span>
        <button type="button" className={done ? 'inline inline--done' : 'inline'} aria-label={t('btn.copy')} title={done ? t('btn.copied') : t('btn.copy')} onClick={() => void copy()}><Icon name={done ? 'check' : 'content_copy'} /></button>
      </div>
      <Slide open={open}><pre className="raw__text">{text}</pre></Slide>
    </>
  );
}

/** The settings the editor offers (the others stay as they are in the model). */
const PARAMS: { key: keyof ModelParameters; step: number; min: number; max: number }[] = [
  { key: 'num_ctx', step: 1, min: 128, max: 1048576 },
  { key: 'num_gpu', step: 1, min: 0, max: 999 },
  { key: 'temperature', step: 0.1, min: 0, max: 5 },
  { key: 'top_p', step: 0.05, min: 0, max: 1 },
  { key: 'top_k', step: 1, min: 0, max: 1000 },
  { key: 'repeat_penalty', step: 0.05, min: 0, max: 5 },
];

const current = (detail: ModelDetail | undefined, key: string): string => detail?.parameters.find((p) => p.key === key)?.value ?? '';

/** The row of a model that makes a copy of it under a new name (the same weights and settings). */
function CloneRow({ base, onClose }: { base: string; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(`${base}-copy`);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let newName = name.trim();
    if (!newName) return;
    if (!newName.includes(':')) newName += ':latest';
    if (normModel(newName) === normModel(base)) { void notify('warn', t('mdl.clone.same.title'), t('mdl.clone.same.msg')); return; }
    setBusy(true);
    const made = await createModel({ name: newName, base, parameters: {} });
    setBusy(false);
    if (made) onClose();
  };
  return (
    <div className="mrow__clone">
      <input className="fld__box" autoFocus spellCheck={false} aria-label={t('mdl.clone.name')} placeholder={t('mdl.clone.name')} value={name}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      <button type="button" className="small" disabled={busy || !name.trim()} onClick={() => void submit()}>{t('mdl.clone.create')}</button>
      <button type="button" className="small" onClick={onClose}>{t('btn.cancel')}</button>
    </div>
  );
}

/** A model in the list, on one line: the library link (a branch mark for a derived model, which is not in the library), its name and size, a mark for a derived one; and copy, edit, delete. */
function ModelRow({ model, onEdit }: { model: InstalledModel; onEdit: () => void }) {
  const t = useT();
  const [cloning, setCloning] = useState(false);
  const parent = derivedFrom(model.details);
  return (
    <div className="fld mrow">
      <span className="mrow__title">
        {parent
          // a derived model is not in the library: a branch mark before its name; a model of the library has the link icon
          ? <span className="mrow__icon mrow__branch" aria-hidden="true"><Icon name="subdirectory_arrow_right" /></span>
          : <a className="inline mrow__icon" href={`https://ollama.com/library/${encodeURI(model.name)}`} target="_blank" rel="noopener noreferrer" aria-label={t('mdl.library')} title={t('mdl.library')}><Icon name="open_in_new" /></a>}
        <span className="mrow__name">{model.name}</span>
        <span className="sub mrow__size" title={sizeTitle(model.size)}>· {sizeText(model.size)}</span>
        {parent && <span className="mrow__chip" title={normModel(parent) === normModel(model.name) ? undefined : t('mdl.derivedFrom', { n: parent })}>{t('mdl.derived')}</span>}
      </span>
      <span className="mrow__acts">
        <button type="button" className={cloning ? 'inline inline--on' : 'inline'} aria-expanded={cloning} aria-label={t('mdl.clone')} title={t('mdl.clone')} onClick={() => setCloning(!cloning)}><Icon name="control_point_duplicate" /></button>
        <button type="button" className="inline" aria-label={t('mdl.edit')} title={t('mdl.edit')} onClick={onEdit}><Icon name="edit" /></button>
        <button type="button" className="inline" aria-label={t('btn.delete')} title={t('btn.delete')} onClick={() => void removeModel(model.name)}><Icon name="delete" /></button>
      </span>
      <Slide open={cloning}><CloneRow base={model.name} onClose={() => setCloning(false)} /></Slide>
    </div>
  );
}

/** The editing screen of one model: what it is, its settings to change, and the text it was made with. */
function ModelEditor({ name, onBack }: { name: string; onBack: () => void }) {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const model = useModelStore((s) => s.list.find((m) => m.name === name));
  const detail = useModelStore((s) => s.details[name]);
  const has = !!detail;
  const [failed, setFailed] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({}); // what was typed; the rest shows the model's own value
  const [system, setSystem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!has) loadModelDetail(name).then(() => setFailed(false), () => setFailed(true));
  }, [name, has]);

  const shown = (key: string): string => edits[key] ?? current(detail, key);
  const shownSystem = system ?? detail?.system ?? '';
  const dirty = PARAMS.some(({ key }) => key in edits && edits[key].trim() !== current(detail, key)) || (system !== null && system.trim() !== (detail?.system ?? '').trim());

  const save = async () => {
    const parameters: ModelParameters = {};
    for (const { key } of PARAMS) {
      const v = shown(key).trim();
      if (v) parameters[key] = Number(v);
    }
    setBusy(true);
    // a model is changed by making it again from itself: its weights stay, the settings given here replace the old ones
    const made = await createModel({ name, base: name, parameters, ...(shownSystem.trim() ? { system: shownSystem.trim() } : {}) }, false);
    setBusy(false);
    if (made) {
      setEdits({});
      setSystem(null);
      void notify('info', t('mdl.edit.saved.title'), t('mdl.edit.saved.msg', { n: name }));
    }
  };

  const parent = derivedFrom(model?.details);
  const info = (k: string, v: string) => <div className="kv"><label>{k}</label><span>{v}</span></div>;
  return (
    <>
      <PageTitle onBack={onBack} onClose={close}>{name}</PageTitle>
      <DialogBody>
        <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('mdl.edit.info')}</h4></div>
          {model && info(t('mdl.info.size'), sizeBoth(model.size))}
          {model?.details?.parameter_size ? info(t('mdl.info.paramSize'), String(model.details.parameter_size)) : null}
          {model?.details?.quantization_level ? info(t('mdl.info.quant'), String(model.details.quantization_level)) : null}
          {parent && normModel(parent) !== normModel(name) && info(t('mdl.info.parent'), parent)}
          {detail ? (
            <>
              {info(t('mdl.detail.ctx'), detail.context_length ? fmtCtx(detail.context_length) : '-')}
              {info(t('mdl.detail.abilities'), detail.capabilities.join(', ') || '-')}
              <div className="kv"><label>{t('mdl.detail.params')}</label>
                <span>{detail.parameters.length ? <div className="ml">{detail.parameters.map((p, n) => <div key={n}>{p.key} {p.value}</div>)}</div> : t('mdl.detail.none')}</span></div>
            </>
          ) : <div className="sub">{failed ? t('mdl.detail.failed') : t('mdl.detail.loading')}</div>}
        </div>
        {detail && (
          <>
            <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('mdl.edit.settings')}</h4><p className="fgroup__note sub">{t('mdl.edit.hint')}</p></div>
              {PARAMS.map(({ key, step, min, max }) => (
                <div className="fld" key={key}><label className="fld__label" htmlFor={`ed-${key}`}>{t(`mdl.p.${key}`)}</label>
                  <input id={`ed-${key}`} className="fld__text" type="number" step={step} min={min} max={max} value={shown(key)} placeholder={t('mdl.edit.unset')}
                    onChange={(e) => setEdits({ ...edits, [key]: e.target.value })} /></div>
              ))}
              <div className="fld fld--stack"><label className="fld__label" htmlFor="ed-system">{t('mdl.derive.system')}</label>
                <textarea id="ed-system" className="fld__box" rows={4} spellCheck={false} value={shownSystem} placeholder={t('mdl.edit.unset')} onChange={(e) => setSystem(e.target.value)} /></div>
              <div className="btns mf__btns">
                <button type="button" className="small" disabled={!dirty || busy} onClick={() => void save()}>{t('mdl.edit.save')}</button>
              </div>
            </div>
            {(detail.modelfile || detail.template || detail.license) && (
              <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('mdl.edit.raw')}</h4></div>
                {detail.modelfile && <RawBlock title="Modelfile" text={detail.modelfile} />}
                {detail.template && <RawBlock title="TEMPLATE" text={detail.template} />}
                {detail.license && <RawBlock title="LICENSE" text={detail.license} />}
              </div>
            )}
          </>
        )}
      </DialogBody>
    </>
  );
}

/** Installed models and downloads, grouped by model family (every group open at first, and can be folded). A model's edit screen slides in over the list. */
export function ModelsPage() {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const { list, loaded } = useModelStore();
  const tasks = usePullStore((s) => s.tasks);
  const path = useSettingsStore((s) => s.cfg.modelsPath);
  const storage = useModelStore((s) => s.storage);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null); // the model of the edit screen (kept while it slides away)
  const [shown, setShown] = useState(false); // the edit screen is in view
  const finished = Object.values(tasks).filter((x) => x.status === 'success').length;
  const seen = useRef(finished);

  useEffect(() => { void loadModels(); }, []);
  // A download that has just finished is installed now: read the list again.
  useEffect(() => {
    if (finished !== seen.current) { seen.current = finished; void loadModels(); }
  }, [finished]);

  const edit = (model: string) => { setEditing(model); setShown(true); };
  const back = () => { setShown(false); setTimeout(() => setEditing(null), 320); }; // (the screen goes once it has slid out of view)
  // Escape goes back from the edit screen to the list first; only from the list it leaves the page (see PageHost)
  usePageBack(() => { if (!shown) return false; back(); return true; });

  const downloads = unfinished(tasks); // in the order they were started
  const groups = new Map<string, InstalledModel[]>();
  list.forEach((model) => { const family = splitModel(model.name).family; groups.set(family, [...(groups.get(family) ?? []), model]); });
  // the models of a family by quantization, the original before its derived ones
  groups.forEach((models, family) => groups.set(family, [...models].sort(compareModels)));

  const submit = async () => { if (await startPull(name)) setName(''); };
  const stats = t('mdl.stats', { path: path || '~/.ollama/models', n: list.length, size: sizeBoth(storage ? storage.bytes : list.reduce((a, m) => a + m.size, 0)) });

  return (
    <>
      <div className={shown ? 'mtrack mtrack--edit' : 'mtrack'}>
        <div className="mpane" inert={shown}>
          <PageTitle onClose={close}>{t('hdr.models')}</PageTitle>
          <DialogBody>
            <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('mdl.download')}</h4></div>
              <div className="fld fld--stack mdl-add">
                <div className="pr">
                  <input id="pn" className="fld__box" spellCheck={false} aria-label={t('mdl.download')} placeholder={t('mdl.dlPh')} value={name} onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
                  <button type="button" onClick={() => void submit()}>{t('mdl.download')}</button>
                </div>
              </div>
              {downloads.length > 0 && <div className="card fold__card mdl-dls">{downloads.map((task) => <DownloadRow key={task.id} task={task} />)}</div>}
            </div>
            <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{t('mdl.installed')}</h4><p className="fgroup__note sub" id="pg">{loaded ? stats : ''}</p></div>
              {groups.size === 0 && loaded && <div className="sub">{t('mdl.none')}</div>}
              {[...groups].map(([family, models]) => (
                <Fold key={family} title={family} hint={t('new.toggle', { n: family })} defaultOpen>
                  {models.map((model) => <ModelRow key={model.name} model={model} onEdit={() => edit(model.name)} />)}
                </Fold>
              ))}
            </div>
          </DialogBody>
        </div>
        <div className="mpane" inert={!shown}>
          {editing && <ModelEditor key={editing} name={editing} onBack={back} />}
        </div>
      </div>
    </>
  );
}
