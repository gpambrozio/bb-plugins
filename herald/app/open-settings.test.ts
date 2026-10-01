import { describe, expect, it, vi } from "vitest";

import { openPluginSettings, pluginSettingsPath, type HistoryWindow } from "./open-settings";

function fakeWindow(pathname = "/plugins/herald/waiting"): HistoryWindow & { pushes: unknown[][] } {
  const pushes: unknown[][] = [];
  return {
    pushes,
    location: { pathname },
    history: { state: { usr: null, key: "k", idx: 3 }, pushState: (...args: unknown[]) => pushes.push(args) },
    dispatchEvent: vi.fn(() => true),
  };
}

describe("openPluginSettings", () => {
  it("pushes the route bb's own openSettings uses and tells the router", () => {
    const win = fakeWindow();
    expect(openPluginSettings(win, "herald")).toBe(true);
    expect(win.pushes).toHaveLength(1);
    expect(win.pushes[0]?.[2]).toBe("/settings/plugins/herald");
    expect((win.pushes[0]?.[0] as { idx: number }).idx).toBe(4);
    expect(win.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "popstate" }));
  });

  it("does nothing when already there, and reports a refused push", () => {
    expect(openPluginSettings(fakeWindow(pluginSettingsPath("herald")), "herald")).toBe(true);
    const refusing = fakeWindow();
    refusing.history.pushState = () => {
      throw new Error("SecurityError");
    };
    expect(openPluginSettings(refusing, "herald")).toBe(false);
  });
});
