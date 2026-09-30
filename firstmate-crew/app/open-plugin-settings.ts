/**
 * Opens FirstMate's page in bb's settings (the host-rendered form and the settings section) from a panel.
 *
 * The panel SDK has no call for it: only a sidebar-footer action is handed `openSettings()`. That call
 * navigates to `/settings/plugins/<id>` (bb 0.44's app), so this does the same the way the app's
 * react-router browser history does: push the route with the router's `{ usr, key, idx }` state, then
 * dispatch the `popstate` the router listens for. It is an internal route; if a later bb moves it, the
 * push lands on bb's not-found page rather than failing, and the caller's fallback toast says where the
 * page is.
 */
export const PLUGIN_SETTINGS_PATH = "/settings/plugins/firstmate-crew";

/** The slice of `window` this needs, so it can be tested without a DOM. */
export interface HistoryWindow {
  location: { pathname: string };
  history: { state: unknown; pushState(state: unknown, unused: string, url: string): void };
  dispatchEvent(event: Event): boolean;
}

function nextIndex(state: unknown): number {
  const idx = typeof state === "object" && state !== null ? (state as { idx?: unknown }).idx : undefined;
  return typeof idx === "number" ? idx + 1 : 1;
}

/** Navigates to the settings page; false when the browser refused, so the caller can say where it is. */
export function openPluginSettings(win: HistoryWindow): boolean {
  if (win.location.pathname === PLUGIN_SETTINGS_PATH) return true;
  try {
    const state = { usr: null, key: Math.random().toString(36).slice(2, 10), idx: nextIndex(win.history.state) };
    win.history.pushState(state, "", PLUGIN_SETTINGS_PATH);
    win.dispatchEvent(new Event("popstate"));
    return true;
  } catch {
    return false;
  }
}
