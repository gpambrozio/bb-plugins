/**
 * Opens this plugin's page in bb's settings. The SDK has no call for it, so this pushes the route the
 * way the app's react-router history does and dispatches the `popstate` it listens for, as Herald does
 * (`herald/app/open-settings.ts`). It is an internal route: if a later bb moves it, the push lands on
 * bb's not-found page, and the caller's toast says where the settings are.
 */

export interface HistoryWindow {
  location: { pathname: string };
  history: { state: unknown; pushState(state: unknown, unused: string, url: string): void };
  dispatchEvent(event: Event): boolean;
}

export const SETTINGS_PATH = "/settings/plugins/learning-exercises";

function nextIndex(state: unknown): number {
  const idx = typeof state === "object" && state !== null ? (state as { idx?: unknown }).idx : undefined;
  return typeof idx === "number" ? idx + 1 : 1;
}

/** False when the browser refused, so the caller can say where the settings are. */
export function openSettings(win: HistoryWindow): boolean {
  if (win.location.pathname === SETTINGS_PATH) return true;
  try {
    win.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: nextIndex(win.history.state) }, "", SETTINGS_PATH);
    win.dispatchEvent(new Event("popstate"));
    return true;
  } catch {
    return false;
  }
}
