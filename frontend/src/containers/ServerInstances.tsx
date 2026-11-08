import { useDevices, useExternal, useViews } from '@/app/hooks';
import { changeState, removeInstance } from '@/app/instanceActions';
import { Icon } from '@/components/common/Icon';
import { Section } from '@/components/common/Section';
import { StateBadge } from '@/components/common/StateBadge';
import { sortViews, type InstanceView, type LoadedView, type SortKey } from '@/lib/derive';
import { expAt, fmtCtx } from '@/lib/format';
import { useT } from '@/locales/useT';
import { useDialogStore } from '@/stores/dialogStore';
import { useIsGuest } from '@/stores/monitorStore';
import { useUiStore } from '@/stores/uiStore';

const SORTS: [SortKey, string][] = [['name', 'f.name'], ['port', 'f.port'], ['state', 'f.state']];

function LoadedList({ loaded, keep }: { loaded: LoadedView[]; keep: number }) {
  const t = useT();
  if (!loaded.length) return <div className="model" style={{ color: 'var(--sub)' }}>{t('card.none')}</div>;
  return (
    <>
      {loaded.map((x) => (
        <div className="model" key={x.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span title={x.name}>{x.name}</span><span className="sub">{expAt(x.exp, keep, t)}</span>
        </div>
      ))}
    </>
  );
}

function PortLine({ port, ctx, loaded }: { port: number; ctx: number; loaded: LoadedView[] }) {
  const t = useT();
  const used = +loaded.reduce((a, x) => a + x.gb, 0).toFixed(1);
  return <div className="sub">{t('card.line', { port, ctx: ctx ? fmtCtx(ctx) : '-', gb: used })}</div>;
}

function Buttons({ i }: { i: InstanceView }) {
  const t = useT();
  const guest = useIsGuest();
  const open = useDialogStore((s) => s.open);
  const details = () => open({ kind: 'details', id: i.id });
  const monitor = () => open({ kind: 'monitor', id: i.id });
  const monitorButton = <button className="small" disabled={i.state !== 'running'} onClick={monitor}>{t('btn.monitor')}</button>;
  if (guest) return <div className="btns">{monitorButton}<button className="small" onClick={details}>{t('btn.details')}</button></div>;
  const idle = i.state === 'stopped' || i.state === 'crashed';
  const busy = i.state === 'starting' || i.state === 'stopping';
  return (
    <div className="btns">
      {idle
        ? <button className="small" onClick={() => void changeState(i.id, 'running')}>{t('btn.start')}</button>
        : <button className="small" disabled={busy} onClick={() => void changeState(i.id, 'stopped')}>{t('btn.stop')}</button>}
      {monitorButton}
      <button className="small" disabled={busy} onClick={details}>{t('btn.details')}</button>
      <button className="small del" disabled={!idle} title={idle ? undefined : t('del.disabled')} onClick={() => void removeInstance(i.id)}>{t('btn.delete')}</button>
    </div>
  );
}

function InstanceCard({ i }: { i: InstanceView }) {
  const t = useT();
  return (
    <div className="card">
      <div className="top"><b>{i.name}</b><StateBadge state={i.state} /></div>
      <PortLine port={i.port} ctx={i.ctx} loaded={i.loaded} />
      {i.auto && <div className="sub">{t('card.auto')}</div>}
      <LoadedList loaded={i.loaded} keep={i.keep} />
      <Buttons i={i} />
    </div>
  );
}

export function ServerInstances() {
  const t = useT();
  const views = useViews();
  const external = useExternal();
  useDevices(); // the cards do not show devices, but a change of snapshot must refresh them: useViews already covers it
  const sortKey = useUiStore((s) => s.sortKey);
  const sortDir = useUiStore((s) => s.sortDir);
  const sortBy = useUiStore((s) => s.sortBy);
  const sorted = sortViews(views, sortKey, sortDir);

  const tabs = (
    <div id="stabs">
      {SORTS.map(([key, label]) => (
        <button key={key} className={`small${sortKey === key ? ' on' : ''}`} onClick={() => sortBy(key)}>
          {t(label)}{sortKey === key && <Icon name={sortDir > 0 ? 'arrow_upward' : 'arrow_downward'} />}
        </button>
      ))}
    </div>
  );

  return (
    <Section id="inst" tabs={tabs}>
      <div id="grid">
        {sorted.map((i) => <InstanceCard key={i.id} i={i} />)}
        {external && (
          <div className="card ext">
            <div className="top"><b>{t('ext.name')}</b><span className="badge"><Icon name="lock" />{t('ext.managed')}</span></div>
            <PortLine port={external.port} ctx={0} loaded={external.loaded} />
            <LoadedList loaded={external.loaded} keep={external.keep} />
          </div>
        )}
      </div>
    </Section>
  );
}
