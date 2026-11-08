import { ApiError } from '@/api/client';
import { t } from '@/locales/useT';
import { useDialogStore, type PopupKind, type PopupResult } from '@/stores/dialogStore';
import { log } from './log';

/** A message the user has to acknowledge. Resolves when it is closed. */
export const notify = (kind: PopupKind, title: string, msg: string): Promise<PopupResult> =>
  useDialogStore.getState().showPopup({ kind, title, msg, ok: t('pop.ok') });

/** A yes/no question. Resolves true when the main button was pressed. */
export const ask = async (title: string, msg: string, ok = t('pop.cont'), danger = false): Promise<boolean> =>
  (await useDialogStore.getState().showPopup({ kind: danger ? 'danger' : 'confirm', title, msg, ok, cancel: t('btn.cancel') })) === true;

/** Any popup with its own buttons (an extra middle button, a warning kind ...). */
export const popup = (request: { kind: PopupKind; title: string; msg: string; ok: string; cancel?: string; alt?: string }): Promise<PopupResult> =>
  useDialogStore.getState().showPopup(request);

/** Shows a failed operation and puts it in the log. */
export function fail(e: unknown): Promise<PopupResult> {
  const message = e instanceof Error ? e.message : String(e);
  log(`Error: ${message}`);
  return notify('error', t('err.title'), e instanceof ApiError && e.status === 0 ? t('conn.lost') : message);
}
