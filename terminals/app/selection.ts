/**
 * Which tab this window shows. The tab list is the same in every window; the
 * selection is each window's own, kept in this module across page switches and
 * in localStorage across reloads.
 */

const STORAGE_KEY = "bb-plugin-terminals:selected-tab";

/** The tab to show: the wanted one while it is open, else the last tab, else none. */
export function resolveSelection(tabIds: readonly string[], wanted: string | null): string | null {
  if (wanted !== null && tabIds.includes(wanted)) return wanted;
  return tabIds.at(-1) ?? null;
}

/**
 * The tab to show once `closing` closes: unchanged unless it is the one shown,
 * then its right-hand neighbour, else its left, as a terminal app does.
 */
export function selectionAfterClose(tabIds: readonly string[], closing: string, selected: string | null): string | null {
  if (selected !== closing) return selected;
  const index = tabIds.indexOf(closing);
  if (index === -1) return selected;
  return tabIds[index + 1] ?? tabIds[index - 1] ?? null;
}

/** The selection's store: a module variable, seeded from and written through to localStorage. */
export interface SelectionStore {
  get(): string | null;
  set(terminalId: string | null): void;
}

export function createSelectionStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): SelectionStore {
  let value: string | null = null;
  try {
    value = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    value = null;
  }
  return {
    get: () => value,
    set(terminalId) {
      value = terminalId;
      try {
        if (terminalId === null) storage?.removeItem(STORAGE_KEY);
        else storage?.setItem(STORAGE_KEY, terminalId);
      } catch {
        // Private browsing or a full quota: the selection still holds for this window.
      }
    },
  };
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** This window's selection. */
export const windowSelection: SelectionStore = createSelectionStore(browserStorage());
