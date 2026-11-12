import { useEffect, useState, type ReactNode } from 'react';
import { log } from '@/app/log';
import { clearMetricsToken, commitMetricsToken, commitPassword, commitSetting, readMetricsToken, resetSettings } from '@/app/settingsActions';
import { DialogBody, PageTitle } from '@/components/common/Dialog';
import { pickPath } from '@/desktop';
import { copyText } from '@/lib/clipboard';
import { randomKey } from '@/lib/random';
import { LOCALES } from '@/locales';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useSettingsStore, type Cfg } from '@/stores/settingsStore';

const Switch = ({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) => (
  <div className={hint ? 'fld fld--note' : 'fld'}>
    <label className="fld__label" htmlFor={id}>{label}</label>
    <input id={id} className="sw" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    {hint && <span className="fld__note sub">{hint}</span>}
  </div>
);

const Select = ({ id, label, hint, value, options, onChange }: { id: string; label: string; hint?: string; value: string | number; options: [string | number, string][]; onChange: (v: string) => void }) => (
  <div className={hint ? 'fld fld--note' : 'fld'}>
    <label className="fld__label" htmlFor={id}>{label}</label>
    <span className="fld__select">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([k, text]) => <option key={k} value={k}>{text}</option>)}</select>
      <span className="material-icons">expand_more</span>
    </span>
    {hint && <span className="fld__note sub">{hint}</span>}
  </div>
);

const Box = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="box fgroup"><div className="fgroup__head"><h4 className="fgroup__title">{title}</h4></div>{children}</div>
);

/** Every change is stored the moment it is made (switches and lists at once, text and numbers when the field is left). */
export function SettingsPage() {
  const t = useT();
  const close = useDialogStore((s) => s.close);
  const cfg = useSettingsStore((s) => s.cfg);
  const edit = useSettingsStore((s) => s.edit);
  const version = useMonitorStore((s) => s.info?.version ?? '?');
  const platform = useMonitorStore((s) => s.info?.platform);
  const lanIp = useMonitorStore((s) => s.info?.lan_ip);
  const [copied, setCopied] = useState(false);
  const address = cfg.extMon && lanIp ? `http://${lanIp}:${cfg.monPort}` : ''; // empty while remote monitoring is off
  const copyAddress = async () => {
    if (!address || !(await copyText(address))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const pwSet = useMonitorStore((s) => s.info?.external_monitoring.password_set ?? false);
  const tokenSet = useMonitorStore((s) => s.info?.external_monitoring.metrics_token_set ?? false);
  const [pw, setPw] = useState('');
  const [token, setToken] = useState('');
  const [savedToken, setSavedToken] = useState(''); // what the backend has; the field is edited freely and saved when it is left
  useEffect(() => { // the saved token is shown as it is, to be copied
    if (!tokenSet) { setToken(''); setSavedToken(''); return; }
    let live = true;
    void readMetricsToken().then((v) => { if (live) { setToken(v); setSavedToken(v); } });
    return () => { live = false; };
  }, [tokenSet]);

  const apply = (patch: Partial<Cfg>, field: keyof Cfg) => { edit(patch); void commitSetting(field); };
  const onEnter = (field: keyof Cfg) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') void commitSetting(field); };

  const browse = async (field: 'exe' | 'modelsPath') => {
    const picked = await pickPath(field === 'exe' ? 'file' : 'dir', cfg[field], t('set.browse'));
    if (!picked) return;
    log(`Path selected: ${picked}`);
    apply({ [field]: picked }, field);
  };
  const [tokenDone, setTokenDone] = useState(false); // the token is on the clipboard (the check mark on the button)
  const flashDone = () => { setTokenDone(true); setTimeout(() => setTokenDone(false), 1500); };
  const copyToken = async () => { if (token && (await copyText(token))) flashDone(); };
  // typed, pasted or emptied by the user: emptying removes the token; a rejected one (too short) goes back to the saved value
  const saveToken = async () => {
    if (token === savedToken) return;
    const ok = token ? await commitMetricsToken(token) : await clearMetricsToken();
    if (ok) setSavedToken(token); else setToken(savedToken);
  };
  const generateToken = async () => {
    const fresh = randomKey();
    if (!(await commitMetricsToken(fresh, true))) return;
    setToken(fresh); setSavedToken(fresh); // filled in, and copied right away
    if (await copyText(fresh)) flashDone();
  };
  const savePw = async () => { if (pw && (await commitPassword(pw))) setPw(''); };
  const save = () => { log('Settings saved'); close(); }; // every change is already stored; this just closes the window

  return (
    <>
      <PageTitle onClose={close}>{t('set.title')}</PageTitle>
      <DialogBody>
      <div>
        <Box title={t('set.general')}>
          <Select id="lang" label={t('set.lang')} value={cfg.lang} options={Object.keys(LOCALES).map((k) => [k, LOCALES[k]?._name ?? k])} onChange={(v) => apply({ lang: v }, 'lang')} />
          <Select id="t" label={t('set.theme')} value={cfg.theme} onChange={(v) => apply({ theme: v as Cfg['theme'] }, 'theme')}
            options={[['system', t('theme.system')], ['light', t('theme.light')], ['dark', t('theme.dark')]]} />
          <Switch id="lg" label={t('set.login')} checked={cfg.login} onChange={(v) => apply({ login: v }, 'login')} />
          <Switch id="tray" label={t('set.tray')} checked={cfg.tray} onChange={(v) => apply({ tray: v }, 'tray')} />
        </Box>
        <Box title={t('set.web')}>
          <Switch id="em" label={t('set.ext')} hint={t('set.extHint')} checked={cfg.extMon} onChange={(v) => apply({ extMon: v }, 'extMon')} />
          <div className="fld"><label className="fld__label" htmlFor="mport">{t('set.extPort')}</label>
            <input id="mport" className="fld__text" type="number" min={1024} max={65535} value={cfg.monPort} onChange={(e) => edit({ monPort: +e.target.value })}
              onBlur={() => void commitSetting('monPort')} onKeyDown={onEnter('monPort')} /></div>
          <div className="fld"><label className="fld__label" htmlFor={address ? 'maddr' : undefined}>{t('set.extAddr')}</label>
            {address ? (
              <span className="fld__group">
                <input id="maddr" className="fld__text" readOnly value={address} />
                <button type="button" className={copied ? 'inline inline--done' : 'inline'} aria-label={t('btn.copy')} title={copied ? t('btn.copied') : t('btn.copy')} onClick={() => void copyAddress()}>
                  <span className="material-icons">{copied ? 'check' : 'content_copy'}</span>
                </button>
              </span>
            ) : <span className="fld__static">{t('set.extAddrOff')}</span>}</div>
          <div className="fld fld--note"><label className="fld__label" htmlFor="mpw">{t('set.extPw')}</label>
            <input id="mpw" className="fld__text" type="password" autoComplete="new-password" value={pw} placeholder={pwSet ? t('set.extPwSet') : t('set.extPwUnset')}
              onChange={(e) => setPw(e.target.value)} onBlur={() => void savePw()} onKeyDown={(e) => { if (e.key === 'Enter') void savePw(); }} />
            <span className="fld__note sub">{t('set.extPwHint')}</span></div>
          <div className="fld fld--note"><label className="fld__label" htmlFor="mxt">{t('set.mxToken')}</label>
            <input id="mxt" className="fld__text fld__text--grow" type="text" autoComplete="off" spellCheck={false} value={token} placeholder={t('set.extPwUnset')}
              onChange={(e) => setToken(e.target.value)} onBlur={() => void saveToken()} onKeyDown={(e) => { if (e.key === 'Enter') void saveToken(); }} />
            {token
              ? <button type="button" className={tokenDone ? 'inline inline--done' : 'inline'} aria-label={t('btn.copy')} title={tokenDone ? t('btn.copied') : t('btn.copy')} onClick={() => void copyToken()}><span className="material-icons">{tokenDone ? 'check' : 'content_copy'}</span></button>
              : <button type="button" className={tokenDone ? 'inline inline--done' : 'inline'} aria-label={t('btn.genKey')} title={t('btn.genKey')} onClick={() => void generateToken()}><span className="material-icons">{tokenDone ? 'check' : 'autorenew'}</span></button>}
            <span className="fld__note sub">{t('set.mxTokenHint')}</span></div>
        </Box>
        <Box title={t('set.monitor')}>
          {platform === 'darwin' && <Switch id="pm" label={t('set.pm')} hint={t('set.pmHint')} checked={false} disabled onChange={() => undefined} />}
          <Switch id="dol" label={t('set.defOllama')} hint={t('set.defOllamaHint')} checked={cfg.defOllama} onChange={(v) => apply({ defOllama: v }, 'defOllama')} />
          <Select id="vw" label={t('set.vramWarn')} hint={t('set.vramWarnHint')} value={cfg.vramWarn} options={[70, 75, 80, 85, 90, 95].map((n) => [n, `${n}%`])} onChange={(v) => apply({ vramWarn: +v }, 'vramWarn')} />
          <Select id="iv" label={t('set.interval')} hint={t('set.intervalHint')} value={cfg.interval} options={[1, 3, 5, 10].map((n) => [n, t('sec.n', { n })])} onChange={(v) => apply({ interval: +v }, 'interval')} />
          <Select id="kd" label={t('set.keep')} hint={t('set.keepHint')} value={cfg.keepDays} options={[1, 3, 7, 14, 30].map((n) => [n, t('day.n', { n })])} onChange={(v) => apply({ keepDays: +v }, 'keepDays')} />
        </Box>
        <Box title={t('new.server')}>
          <div className="fld fld--stack"><label className="fld__label" htmlFor="ex">{t('set.exe')}</label>
            <span className="pr">
              <input id="ex" className="fld__box" value={cfg.exe} placeholder={t('set.exePh')} onChange={(e) => edit({ exe: e.target.value })}
                onBlur={() => void commitSetting('exe')} onKeyDown={onEnter('exe')} />
              <button type="button" onClick={() => void browse('exe')}>{t('set.browse')}</button>
            </span></div>
          <div className="fld fld--stack"><label className="fld__label" htmlFor="mp">{t('set.models')}</label>
            <span className="pr">
              <input id="mp" className="fld__box" value={cfg.modelsPath} placeholder="~/.ollama/models" onChange={(e) => edit({ modelsPath: e.target.value })}
                onBlur={() => void commitSetting('modelsPath')} onKeyDown={onEnter('modelsPath')} />
              <button type="button" onClick={() => void browse('modelsPath')}>{t('set.browse')}</button>
            </span></div>
        </Box>
        <Box title={t('set.update')}>
          <div className="fld fld--btn">
            <label className="fld__label">{t('set.ver', { v: `v${version}` })}</label>
            <button type="button" className="inline" aria-label={t('set.check')} title={t('set.check')} disabled><span className="material-icons">sync</span></button>{/* not wired yet */}
          </div>
        </Box>
      </div>
      <div className="btns" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" onClick={() => void resetSettings()}>{t('set.reset')}</button>
        <button type="button" className="primary" onClick={save}>{t('set.save')}</button>
      </div>
      </DialogBody>
    </>
  );
}
