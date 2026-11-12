import { useIsGuest } from '@/stores/monitorStore';
import { useDialogStore } from '@/stores/dialogStore';
import { DetailsDialog } from './dialogs/DetailsDialog';
import { NewInstanceDialog } from './dialogs/NewInstanceDialog';
import { PopupHost } from './dialogs/PopupHost';

/** Shows the one big dialog that is open, and the popup layer above it. Guests get the details only. (Settings and models are pages: see PageHost.) */
export function DialogHost() {
  const active = useDialogStore((s) => s.active);
  const guest = useIsGuest();
  return (
    <>
      {active?.kind === 'details' && <DetailsDialog key={`d${active.id}`} id={active.id} />}
      {!guest && active?.kind === 'new' && <NewInstanceDialog />}
      <PopupHost />
    </>
  );
}
