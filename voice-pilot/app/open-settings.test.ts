import { afterEach, describe, expect, it, vi } from "vitest";

import { PLUGIN_SETTINGS_PATH, SETTINGS_SHOW_WAIT_MS, openPluginSettings, pushSettingsRoute, settingsPage, type HistoryWindow } from "./open-settings";

function fakeWindow(state: unknown = { usr: null, key: "a", idx: 4 }) {
  const events: string[] = [];
  const pushed: { state: unknown; url: string }[] = [];
  const win: HistoryWindow = {
    location: { pathname: "/threads/thr_1" },
    history: {
      state,
      pushState(next, _unused, url) {
        pushed.push({ state: next, url: String(url) });
        win.location.pathname = String(url);
      },
    },
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
  };
  return { win, events, pushed };
}

/** A clock and a timer list the test runs by hand. */
function clock(start = 10_000) {
  let now = start;
  const timers: { run: () => void; ms: number }[] = [];
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => timers.push({ run, ms }),
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) timer.run();
    },
    timers,
  };
}

afterEach(() => {
  settingsPage.shownAt = null;
});

describe("the route to Voice Pilot's settings page", () => {
  it("is pushed with the router's state, then told to the router with a popstate", () => {
    const { win, events, pushed } = fakeWindow();
    expect(pushSettingsRoute(win)).toBe(true);
    expect(PLUGIN_SETTINGS_PATH).toBe("/settings/plugins/voice-pilot");
    expect(pushed).toEqual([{ state: expect.objectContaining({ usr: null, idx: 5 }), url: PLUGIN_SETTINGS_PATH }]);
    expect(events).toEqual(["popstate"]);
  });

  it("starts the history index at 1 when the current entry has none", () => {
    const { win, pushed } = fakeWindow(null);
    pushSettingsRoute(win);
    expect(pushed[0]?.state).toMatchObject({ idx: 1 });
  });

  it("reports a refused push instead of throwing", () => {
    const { win } = fakeWindow();
    win.history.pushState = () => {
      throw new Error("SecurityError");
    };
    expect(pushSettingsRoute(win)).toBe(false);
  });
});

describe("opening the settings page", () => {
  it("says nothing when the settings page shows", () => {
    const { win } = fakeWindow();
    const time = clock();
    const onMissing = vi.fn();
    openPluginSettings({ win, onMissing, now: time.now, setTimer: time.setTimer });
    expect(time.timers.map((timer) => timer.ms)).toEqual([SETTINGS_SHOW_WAIT_MS]);
    settingsPage.shown(time.now() + 200);
    time.advance(SETTINGS_SHOW_WAIT_MS);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("says where the settings are when the route moved and the page never showed", () => {
    const { win, pushed } = fakeWindow();
    const time = clock();
    const onMissing = vi.fn();
    settingsPage.shown(time.now() - 60_000); // an earlier visit does not count
    openPluginSettings({ win, onMissing, now: time.now, setTimer: time.setTimer });
    expect(pushed).toHaveLength(1);
    time.advance(SETTINGS_SHOW_WAIT_MS);
    expect(onMissing).toHaveBeenCalledOnce();
  });

  it("says where the settings are at once when the browser refuses the push", () => {
    const { win } = fakeWindow();
    win.history.pushState = () => {
      throw new Error("SecurityError");
    };
    const time = clock();
    const onMissing = vi.fn();
    openPluginSettings({ win, onMissing, now: time.now, setTimer: time.setTimer });
    expect(onMissing).toHaveBeenCalledOnce();
    expect(time.timers).toEqual([]);
  });

  it("does nothing when the settings page is already open", () => {
    const { win, events, pushed } = fakeWindow();
    win.location.pathname = PLUGIN_SETTINGS_PATH;
    const time = clock();
    const onMissing = vi.fn();
    openPluginSettings({ win, onMissing, now: time.now, setTimer: time.setTimer });
    expect([pushed, events, time.timers]).toEqual([[], [], []]);
    expect(onMissing).not.toHaveBeenCalled();
  });
});
