/**
 * Opens Voice Pilot's page in bb's settings (the host-rendered form and the Voice hooks section) from the
 * debug view, as `firstmate-crew`, `dream` and `herald` do.
 *
 * The panel SDK has no call for it: only a sidebar-footer action is handed `openSettings()`, which navigates
 * to `/settings/plugins/<id>`. This goes to the same route the way the app's react-router browser history
 * does: push the route with the router's `{ usr, key, idx }` state, then dispatch the `popstate` the router
 * listens for. It is an internal route, and if a later bb moves it the push lands on bb's not-found page
 * without failing. So this also waits for the page to show: the Voice hooks section is drawn only on
 * Voice Pilot's settings page, and marks `settingsPage` when it mounts. When it has not within
 * `SETTINGS_SHOW_WAIT_MS`, or the browser refused the push, `onMissing` runs and the caller says where the
 * settings are.
 */
export const PLUGIN_SETTINGS_PATH = "/settings/plugins/voice-pilot";

/** Said when the settings page did not show. */
export const SETTINGS_WHERE = "Voice Pilot's settings are in Settings → Plugins → Voice Pilot.";

/** How long the settings page has to show before the caller is told it did not. */
export const SETTINGS_SHOW_WAIT_MS = 3_000;

/** The slice of `window` this needs, so it can be tested without a DOM. */
export interface HistoryWindow {
  location: { pathname: string };
  history: { state: unknown; pushState(state: unknown, unused: string, url: string): void };
  dispatchEvent(event: Event): boolean;
}

/** When Voice Pilot's settings page last showed in this window, marked by its Voice hooks section. */
export const settingsPage = {
  shownAt: null as number | null,
  shown(now = Date.now()): void {
    settingsPage.shownAt = now;
  },
};

function nextIndex(state: unknown): number {
  const idx = typeof state === "object" && state !== null ? (state as { idx?: unknown }).idx : undefined;
  return typeof idx === "number" ? idx + 1 : 1;
}

/** Navigates to the settings page; false when the browser refused. */
export function pushSettingsRoute(win: HistoryWindow): boolean {
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

export interface OpenSettingsOptions {
  win: HistoryWindow;
  /** Runs when the settings page did not show: the push was refused, or the route moved. */
  onMissing: () => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
}

/** Opens the settings page, and calls `onMissing` once if it does not show. */
export function openPluginSettings({ win, onMissing, now = Date.now, setTimer = setTimeout }: OpenSettingsOptions): void {
  if (win.location.pathname === PLUGIN_SETTINGS_PATH) return;
  const asked = now();
  if (!pushSettingsRoute(win)) {
    onMissing();
    return;
  }
  setTimer(() => {
    if ((settingsPage.shownAt ?? -Infinity) < asked) onMissing();
  }, SETTINGS_SHOW_WAIT_MS);
}
