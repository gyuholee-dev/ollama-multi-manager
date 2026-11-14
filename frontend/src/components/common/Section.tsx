import type { ReactNode } from 'react';
import { useT } from '@/locales/useT';
import { useUiStore, type SectionId } from '@/stores/uiStore';
import { Icon } from './Icon';

interface Props {
  id: SectionId;
  /** The section's name, where it is not the translation of `sec.<id>` (the monitor window's sections). */
  title?: string;
  /** Buttons shown in the section's header, before the collapse button. */
  tabs?: ReactNode;
  children: ReactNode;
}

/** A collapsible block of the page: title, optional tab buttons, and a collapse button. */
export function Section({ id, title, tabs, children }: Props) {
  const t = useT();
  const collapsed = useUiStore((s) => s.collapsed.includes(id));
  const toggle = useUiStore((s) => s.toggleSection);
  const name = title ?? t(`sec.${id}`);
  const hint = t(collapsed ? 'sec.show' : 'sec.hide');
  return (
    <section data-t={id} className={collapsed ? 'off' : undefined}>
      <div className="sh">
        <h3>{name}</h3>
        {tabs}
        <button className="tog" title={hint} aria-label={`${name} ${hint}`} onClick={() => toggle(id)}>
          <Icon name="expand_more" />
        </button>
      </div>
      <div className="body"><div>{children}</div></div>
    </section>
  );
}
