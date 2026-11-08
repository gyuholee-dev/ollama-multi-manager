import { create } from 'zustand';

export type PopupKind = 'info' | 'warn' | 'error' | 'confirm' | 'danger';
/** true = the main button, 'alt' = the optional middle button, false = cancelled or closed */
export type PopupResult = true | 'alt' | false;

export interface PopupRequest {
  kind: PopupKind;
  title: string;
  msg: string;
  ok: string;
  cancel?: string;
  alt?: string;
  resolve: (result: PopupResult) => void;
}

/** The big dialogs; only one at a time. */
export type ActiveDialog = { kind: 'new' } | { kind: 'details'; id: number } | { kind: 'settings' } | { kind: 'models' } | null;

interface DialogState {
  popup: PopupRequest | null;
  active: ActiveDialog;
  showPopup: (request: Omit<PopupRequest, 'resolve'>) => Promise<PopupResult>;
  closePopup: (result: PopupResult) => void;
  open: (dialog: Exclude<ActiveDialog, null>) => void;
  close: () => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  popup: null,
  active: null,
  showPopup: (request) =>
    new Promise<PopupResult>((resolve) => {
      get().popup?.resolve(false); // a new popup replaces the one still open
      set({ popup: { ...request, resolve } });
    }),
  closePopup: (result) => {
    const popup = get().popup;
    if (!popup) return;
    set({ popup: null });
    popup.resolve(result);
  },
  open: (dialog) => set({ active: dialog }),
  close: () => set({ active: null }),
}));
