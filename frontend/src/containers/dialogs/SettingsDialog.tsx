import type { ReactNode } from 'react';
import { log } from '@/app/log';
import { commitSetting, resetSettings } from '@/app/settingsActions';
import { Dialog, DialogBody, DialogTitle } from '@/components/common/Dialog';
import { pickPath } from '@/desktop';
import { LOCALES } from '@/locales';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useSettingsStore, type Cfg } from '@/stores/settingsStore';

const Switch = ({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <div className="f row">
    {hint ? <div className="ot"><label htmlFor={id}>{label}</label><span className="sub">{hint}</span></div> : <label htmlFor={id}>{label}</label>}<input id={id} className="sw" type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /></div>
);

const Select = ({ id, label, value, options, onChange }: { id: string; label: string; value: string | number; options: [string | number, string][]; onChange: (v: string) => void }) => (
  <div className="f h"><div className="f row"><label htmlFor={id}>{label}</label></div>
    <span className="sel">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([k, text]) => <option key={k} value={k}>{text}</option>)}</select>
      <span className="material-icons">expand_more</span>
    </span>
  </div>
);

const Box = ({ title, children }: { title: string; children: ReactNode }) => <div className="box"><span className="ti">{title}</span>{children}</div>;

/** Every change is stored the moment it is made (switches and lists at once, text and numbers when the field is left). */
export function SettingsDialog() {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const cfg = useSettingsStore((s) => s.cfg);
  const edit = useSettingsStore((s) => s.edit);
  const version = useMonitorStore((s) => s.info?.version ?? '?');

  const apply = (patch: Partial<Cfg>, field: keyof Cfg) => { edit(patch); void commitSetting(field); };
  const onEnter = (field: keyof Cfg) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') void commitSetting(field); };

  const browse = async (field: 'exe' | 'modelsPath') => {
    const picked = await pickPath(field === 'exe' ? 'file' : 'dir', cfg[field], t('set.browse'));
    if (!picked) return;
    log(`Path selected: ${picked}`);
    apply({ [field]: picked }, field);
  };
  const save = () => { log('Settings saved'); close(); }; // every change is already stored; this just closes the window

  return (
    <Dialog id="det" onClose={close}>
      <DialogTitle onClose={close}>{t('set.title')}</DialogTitle>
      <DialogBody>
      <div>
        <Box title={t('set.general')}>
          <Select id="lang" label={t('set.lang')} value={cfg.lang} options={Object.keys(LOCALES).map((k) => [k, LOCALES[k]?._name ?? k])} onChange={(v) => apply({ lang: v }, 'lang')} />
          <Select id="t" label={t('set.theme')} value={cfg.theme} onChange={(v) => apply({ theme: v as Cfg['theme'] }, 'theme')}
            options={[['system', t('theme.system')], ['light', t('theme.light')], ['dark', t('theme.dark')]]} />
          <Switch id="lg" label={t('set.login')} checked={cfg.login} onChange={(v) => apply({ login: v }, 'login')} />
          <Switch id="tray" label={t('set.tray')} checked={cfg.tray} onChange={(v) => apply({ tray: v }, 'tray')} />
        </Box>
        <Box title={t('set.monitor')}>
          <Switch id="em" label={t('set.ext')} hint={t('set.extHint')} checked={cfg.extMon} onChange={(v) => apply({ extMon: v }, 'extMon')} />
          <div className="f h"><div className="f row"><label htmlFor="mport">{t('set.extPort')}</label></div>
            <input id="mport" type="number" min={1024} max={65535} value={cfg.monPort} onChange={(e) => edit({ monPort: +e.target.value })}
              onBlur={() => void commitSetting('monPort')} onKeyDown={onEnter('monPort')} /></div>
          <Select id="iv" label={t('set.interval')} value={cfg.interval} options={[1, 3, 5, 10].map((n) => [n, t('sec.n', { n })])} onChange={(v) => apply({ interval: +v }, 'interval')} />
        </Box>
        <Box title={t('new.server')}>
          <div className="f"><div className="f row"><label htmlFor="ex">{t('set.exe')}</label></div>
            <span className="pr">
              <input id="ex" value={cfg.exe} placeholder={t('set.exePh')} onChange={(e) => edit({ exe: e.target.value })}
                onBlur={() => void commitSetting('exe')} onKeyDown={onEnter('exe')} />
              <button type="button" onClick={() => void browse('exe')}>{t('set.browse')}</button>
            </span></div>
          <div className="f"><div className="f row"><label htmlFor="mp">{t('set.models')}</label></div>
            <span className="pr">
              <input id="mp" value={cfg.modelsPath} placeholder="~/.ollama/models" onChange={(e) => edit({ modelsPath: e.target.value })}
                onBlur={() => void commitSetting('modelsPath')} onKeyDown={onEnter('modelsPath')} />
              <button type="button" onClick={() => void browse('modelsPath')}>{t('set.browse')}</button>
            </span></div>
        </Box>
        <Box title={t('set.update')}>
          <div className="f row">
            <label>{t('set.ver', { v: `v${version}` })}</label>
            <button type="button" disabled>{t('set.check')}</button>{/* not wired yet */}
          </div>
        </Box>
      </div>
      <div className="btns" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" onClick={() => void resetSettings()}>{t('set.reset')}</button>
        <button type="button" className="primary" onClick={save}>{t('set.save')}</button>
      </div>
      </DialogBody>
    </Dialog>
  );
}
