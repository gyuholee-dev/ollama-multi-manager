import { useEffect } from 'react';
import { loadModels } from '@/app/modelActions';
import { normModel, splitModel } from '@/lib/format';
import { sizeText, sizeTitle } from '@/lib/units';
import { useT } from '@/locales/useT';
import { useModelStore } from '@/stores/modelStore';
import { Fold } from './Fold';

/** The installed models, grouped by family, to tick the ones an instance may serve. Nothing ticked = all of them. */
export function ModelPicker({ value, onChange }: { value: string[]; onChange: (models: string[]) => void }) {
  const t = useT();
  const list = useModelStore((s) => s.list);
  useEffect(() => { void loadModels(); }, []); // the stored list is shown first; this refreshes it
  if (!list.length) return <div className="sub">{t('new.noModels')}</div>;

  const picked = new Set(value.map(normModel));
  const toggle = (name: string, on: boolean) =>
    onChange(on ? [...value, name] : value.filter((v) => normModel(v) !== normModel(name)));

  const families = new Map<string, typeof list>();
  list.forEach((m) => { const { family } = splitModel(m.name); families.set(family, [...(families.get(family) ?? []), m]); });

  return (
    <>
      {[...families].map(([family, models]) => {
        const count = models.filter((m) => picked.has(normModel(m.name))).length;
        return (
          <Fold key={family} title={count ? `${family} (${count})` : family} hint={t('new.toggle', { n: family })}>
            {models.map((m) => {
              const id = `pick-${m.name}`;
              return (
                <div className="fld" key={m.name}>
                  <label className="fld__label" htmlFor={id} title={sizeTitle(m.size)}>{m.name} · {sizeText(m.size)}</label>
                  <input id={id} className="sw" type="checkbox" role="switch" checked={picked.has(normModel(m.name))} onChange={(e) => toggle(m.name, e.target.checked)} />
                </div>
              );
            })}
          </Fold>
        );
      })}
    </>
  );
}
