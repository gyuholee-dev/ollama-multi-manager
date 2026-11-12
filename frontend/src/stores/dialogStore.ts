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
export type ActiveDialog = { kind: 'new' } | { kind: 'details'; id: number } | null;
/** The pages the main view slides over to (settings, models): one at a time, apart from the dialogs. */
export type Page = 'settings' | 'models';

interface DialogState {
  popup: PopupRequest | null;
  active: ActiveDialog;
  page: Page | null;
  /** True for a moment after a page was opened or closed: only then does it slide (see _views.scss), not when the window is resized. */
  slide: boolean;
  showPopup: (request: Omit<PopupRequest, 'resolve'>) => Promise<PopupResult>;
  closePopup: (result: PopupResult) => void;
  /** Opens a dialog, or slides to a page (`{ kind: 'settings' | 'models' }`). */
  open: (target: Exclude<ActiveDialog, null> | { kind: Page }) => void;
  /** Closes the dialog; with none open, goes back from the page to the main view. */
  close: () => void;
}

const SLIDE_MS = 350; // a little more than the .3s of the slide

let slideTimer: ReturnType<typeof setTimeout> | undefined;

const isPage = (target: { kind: string }): target is { kind: Page } => target.kind === 'settings' || target.kind === 'models';

export const useDialogStore = create<DialogState>((set, get) => ({
  popup: null,
  active: null,
  page: null,
  slide: false,
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
  open: (target) => {
    if (!isPage(target)) return set({ active: target });
    set({ page: target.kind, slide: true }); // (the page and the flag change together: the first frame of the slide has its transition)
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => set({ slide: false }), SLIDE_MS);
  },
  close: () => {
    if (get().active) return set({ active: null });
    set({ page: null, slide: true });
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => set({ slide: false }), SLIDE_MS);
  },
}));
