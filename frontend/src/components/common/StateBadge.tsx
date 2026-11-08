import type { InstanceState } from '@/api/types';
import { useT } from '@/locales/useT';
import { Icon } from './Icon';

const ICON: Record<InstanceState, string> = {
  running: 'circle', stopped: 'radio_button_unchecked', starting: 'more_horiz', stopping: 'more_horiz', unreachable: 'warning', crashed: 'error_outline',
};

export function StateBadge({ state }: { state: InstanceState }) {
  const t = useT();
  return <span className={`badge ${state}`}><Icon name={ICON[state]} />{t(`state.${state}`)}</span>;
}
