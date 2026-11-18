/**
 * The first-run guide's state in this window: whether its setup dialog is open, whether "Later" put the
 * offer away until the app loads again, and which thread should get the FirstMate tab once it is on
 * screen. One module-level store, because the dialog lives in an app overlay (`intro.tsx`) while the
 * palette command, the settings section and the tab open it from elsewhere.
 */
export interface IntroWindowState {
  /** The setup dialog is open. */
  open: boolean;
  /** "Later" was pressed: no toast in this window until the app loads again. */
  snoozed: boolean;
  /** The first mate the guide just started, whose thread gets the FirstMate tab when it shows. */
  boardFor: string | null;
}

type Listener = () => void;

export interface IntroStore {
  get(): IntroWindowState;
  subscribe(listener: Listener): () => void;
  open(): void;
  close(): void;
  snooze(): void;
  showBoardFor(threadId: string | null): void;
}

export function createIntroStore(): IntroStore {
  let state: IntroWindowState = { open: false, snoozed: false, boardFor: null };
  const listeners = new Set<Listener>();
  function set(change: Partial<IntroWindowState>): void {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: () => set({ open: true }),
    close: () => set({ open: false }),
    snooze: () => set({ snoozed: true }),
    showBoardFor: (threadId) => set({ boardFor: threadId }),
  };
}

/** This window's store. */
export const introStore = createIntroStore();

/** Opens the setup dialog, from the toast, the palette, the settings section or the tab. */
export function openIntro(): void {
  introStore.open();
}
