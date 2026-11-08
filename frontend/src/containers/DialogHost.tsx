import { useIsGuest } from '@/stores/monitorStore';
import { useDialogStore } from '@/stores/dialogStore';
import { DetailsDialog } from './dialogs/DetailsDialog';
import { MonitorDialog } from './dialogs/MonitorDialog';
import { ModelsDialog } from './dialogs/ModelsDialog';
import { NewInstanceDialog } from './dialogs/NewInstanceDialog';
import { PopupHost } from './dialogs/PopupHost';
import { SettingsDialog } from './dialogs/SettingsDialog';

/** Shows the one big dialog that is open, and the popup layer above it. Guests get the details only. */
export function DialogHost() {
  const active = useDialogStore((s) => s.active);
  const guest = useIsGuest();
  return (
    <>
      {active?.kind === 'details' && <DetailsDialog key={`d${active.id}`} id={active.id} />}
      {active?.kind === 'monitor' && <MonitorDialog key={`m${active.id}`} id={active.id} />}
      {!guest && active?.kind === 'new' && <NewInstanceDialog />}
      {!guest && active?.kind === 'settings' && <SettingsDialog />}
      {!guest && active?.kind === 'models' && <ModelsDialog />}
      <PopupHost />
    </>
  );
}
