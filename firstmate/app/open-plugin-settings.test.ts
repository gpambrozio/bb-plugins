import { describe, expect, it } from "vitest";

import { PLUGIN_SETTINGS_PATH, openPluginSettings, type HistoryWindow } from "./open-plugin-settings";

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

describe("openPluginSettings", () => {
  it("pushes the plugin's settings route and tells the router with a popstate", () => {
    const { win, events, pushed } = fakeWindow();

    expect(openPluginSettings(win)).toBe(true);

    expect(PLUGIN_SETTINGS_PATH).toBe("/settings/plugins/firstmate");
    expect(pushed.map((entry) => entry.url)).toEqual(["/settings/plugins/firstmate"]);
    expect(events).toEqual(["popstate"]);
  });

  it("keeps the router's history index moving forward", () => {
    const { win, pushed } = fakeWindow({ usr: null, key: "a", idx: 4 });

    openPluginSettings(win);

    expect(pushed[0]?.state).toMatchObject({ usr: null, idx: 5 });
  });

  it("starts the index at 1 when the current entry has none", () => {
    const { win, pushed } = fakeWindow(null);

    openPluginSettings(win);

    expect(pushed[0]?.state).toMatchObject({ idx: 1 });
  });

  it("does nothing and reports success when the settings page is already open", () => {
    const { win, events, pushed } = fakeWindow();
    win.location.pathname = "/settings/plugins/firstmate";

    expect(openPluginSettings(win)).toBe(true);
    expect(pushed).toEqual([]);
    expect(events).toEqual([]);
  });

  it("reports failure instead of throwing when history refuses the push", () => {
    const { win } = fakeWindow();
    win.history.pushState = () => {
      throw new Error("SecurityError");
    };

    expect(openPluginSettings(win)).toBe(false);
  });
});
