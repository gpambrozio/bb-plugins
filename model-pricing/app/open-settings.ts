/**
 * Opens Model Pricing's page in bb's settings (the host-rendered form)
 * from the panel's gear and from the palette command.
 *
 * The panel SDK has no call for it: only a sidebar-footer action is handed
 * `openSettings()`, and in bb 0.44 that navigates to
 * `/settings/plugins/<pluginId>`. This goes to the same route the way the
 * app's react-router browser history does — push the route with the router's
 * `{ usr, key, idx }` state, then dispatch the `popstate` it listens for — as
 * `herald` and `firstmate-crew` do. It is an internal route: if a later bb
 * moves it, the push lands on bb's not-found page, and the caller's toast says
 * where the settings are.
 */

/** The slice of `window` this needs, so it can be tested without a DOM. */
export interface HistoryWindow {
  location: { pathname: string };
  history: { state: unknown; pushState(state: unknown, unused: string, url: string): void };
  dispatchEvent(event: Event): boolean;
}

export function pluginSettingsPath(pluginId: string): string {
  return `/settings/plugins/${encodeURIComponent(pluginId)}`;
}

function nextIndex(state: unknown): number {
  const idx = typeof state === "object" && state !== null ? (state as { idx?: unknown }).idx : undefined;
  return typeof idx === "number" ? idx + 1 : 1;
}

/** Navigates to the plugin's settings; false when the browser refused, so the caller can say where they are. */
export function openPluginSettings(win: HistoryWindow, pluginId: string): boolean {
  const path = pluginSettingsPath(pluginId);
  if (win.location.pathname === path) return true;
  try {
    const state = { usr: null, key: Math.random().toString(36).slice(2, 10), idx: nextIndex(win.history.state) };
    win.history.pushState(state, "", path);
    win.dispatchEvent(new Event("popstate"));
    return true;
  } catch {
    return false;
  }
}
