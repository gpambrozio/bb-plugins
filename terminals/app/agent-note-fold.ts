/**
 * Whether a tab's "agent ran" card is folded down to a pill, per tab and
 * remembered in this browser (localStorage), since the card no longer goes
 * away on its own. No React.
 */
const STORAGE_KEY = "terminals.agentNoteFolded";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(): string[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function isNoteFolded(terminalId: string): boolean {
  return readAll().includes(terminalId);
}

/** Folds or unfolds the tab's card; a browser that refuses storage remembers it until the page reloads. */
export function setNoteFolded(terminalId: string, folded: boolean): void {
  const others = readAll().filter((entry) => entry !== terminalId);
  // Bounded: the tabs closed long ago fall off the front.
  const next = (folded ? [...others, terminalId] : others).slice(-50);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage.
  }
}
