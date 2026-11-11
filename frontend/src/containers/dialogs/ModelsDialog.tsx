import { useEffect, useRef, useState } from 'react';
import type { InstalledModel, PullTask } from '@/api/types';
import { loadModels, pullAction, removeModel, removePull, startPull } from '@/app/modelActions';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { Icon } from '@/components/common/Icon';
import { modelInfo, splitModel } from '@/lib/format';
import { sizeBoth, sizeText, sizeTitle } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useModelStore } from '@/stores/modelStore';
import { unfinished, usePullStore } from '@/stores/pullStore';
import { useSettingsStore } from '@/stores/settingsStore';

function DownloadCard({ task }: { task: PullTask }) {
  const t = useT();
  const off = task.status !== 'pulling';
  const pct = `${Math.floor(task.percent ?? 0)}%`;
  const size = task.total ? ` · ${sizeText(task.completed)} / ${sizeText(task.total)}` : '';
  const sizeHint = task.total ? `${sizeTitle(task.completed) ?? sizeText(task.completed)} / ${sizeTitle(task.total) ?? sizeText(task.total)}` : undefined; // the same in GiB
  const text = task.status === 'paused' ? `${t('mdl.paused')} · ${pct}${size}` : task.status === 'error' ? `${t('mdl.failed')} · ${pct}${size}` : pct + size;
  return (
    <div className="card mc" id={`dl-${task.id}`} data-s={task.status}>
      <div className="top" style={{ margin: 0 }}><span className="ti tag">{task.model}</span><span className="sub" title={sizeHint}>{text}</span></div>
      <div className="mi"><div className={`dl${off ? ' off' : ''}`}><i style={{ width: `${task.percent ?? 0}%` }} /></div></div>
      <div className="btns" style={{ justifyContent: 'space-between' }}>
        <button className="small" onClick={() => void pullAction(task.id, off ? 'resume' : 'pause')}>{t(off ? 'btn.resume' : 'btn.pause')}</button>
        <button className="small" onClick={() => void removePull(task.id)}>{t('btn.delete')}</button>
      </div>
    </div>
  );
}

/** Installed models and downloads, grouped by model family. Downloads come first: they are what the user just did. */
export function ModelsDialog() {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const { list, loaded } = useModelStore();
  const tasks = usePullStore((s) => s.tasks);
  const path = useSettingsStore((s) => s.cfg.modelsPath);
  const [name, setName] = useState('');
  const finished = Object.values(tasks).filter((x) => x.status === 'success').length;
  const seen = useRef(finished);

  useEffect(() => { void loadModels(); }, []);
  // A download that has just finished is installed now: read the list again.
  useEffect(() => {
    if (finished !== seen.current) { seen.current = finished; void loadModels(); }
  }, [finished]);

  type Row = { task?: PullTask; model?: InstalledModel; tag: string };
  const groups = new Map<string, Row[]>();
  const add = (family: string, row: Row) => groups.set(family, [...(groups.get(family) ?? []), row]);
  unfinished(tasks).forEach((task) => { const { family, tag } = splitModel(task.model); add(family, { task, tag }); });
  list.forEach((model) => { const { family, tag } = splitModel(model.name); add(family, { model, tag }); });

  const submit = async () => { if (await startPull(name)) setName(''); };
  const stats = t('mdl.stats', { path: path || '~/.ollama/models', n: list.length, size: sizeBoth(list.reduce((a, m) => a + m.size, 0)) });

  return (
    <Dialog id="det" onClose={close}>
      <DialogTitle id="mdl" onClose={close}>{t('hdr.models')}</DialogTitle>
      <DialogBody>
      <div className="fld fld--stack mdl-add"><label className="fld__label" htmlFor="pn">{t('mdl.download')}</label>
        <div className="pr">
          <input id="pn" className="fld__box" spellCheck={false} placeholder={t('mdl.dlPh')} value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
          <button type="button" onClick={() => void submit()}>{t('mdl.download')}</button>
        </div>
      </div>
      <div className="sub" id="pg" style={{ minHeight: 16 }}>{loaded ? stats : ''}</div>
      <div className="box" style={{ marginTop: 12 }}>
        {groups.size === 0 && loaded && <div className="sub">{t('mdl.none')}</div>}
        {[...groups].map(([family, rows]) => (
          <div className="cat mg" key={family}>
            <span className="ti">{family}</span>
            {rows.map((row) => row.task ? <DownloadCard key={row.task.id} task={row.task} /> : (
              <div className="card mc" key={row.model!.name}>
                <div className="top" style={{ margin: 0 }}><span className="ti tag">{row.model!.name}</span><span className="sub">{sizeBoth(row.model!.size)}</span></div>
                <div className="sub mi"><span>{modelInfo(row.tag, t, row.model!.details)}</span></div>
                <div className="btns" style={{ justifyContent: 'space-between' }}>
                  <a className="btn small" href={`https://ollama.com/library/${encodeURI(row.model!.name)}`} target="_blank" rel="noopener noreferrer" aria-label={t('mdl.library')} title={t('mdl.library')}><Icon name="open_in_new" /></a>
                  <button className="small" onClick={() => void removeModel(row.model!.name)}>{t('btn.delete')}</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      </DialogBody>
    </Dialog>
  );
}
