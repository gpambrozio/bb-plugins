// @vitest-environment jsdom
/**
 * The debug view's Settings button goes to Voice Pilot's settings page, and says where the settings are when
 * that page does not show (bb moved the route, or the browser refused it).
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { rpcContract } from "../server";
import { DebugLogView } from "./debug";
import { VoiceHooksSection } from "./hooks-section";
import { PLUGIN_SETTINGS_PATH, SETTINGS_SHOW_WAIT_MS, SETTINGS_WHERE, settingsPage } from "./open-settings";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), dismiss: vi.fn() }) }));

type Rpc = PluginRpcTestHandlers<typeof rpcContract>;

function rpc(): Rpc {
  return {
    "debug.log": async () => ({ sessionId: null, startedAt: null, entries: [], more: false, dropped: 0 }),
    "hooks.status": async () => ({ machines: [] }),
  } as Partial<Rpc> as Rpc;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/threads/thr_1");
  settingsPage.shownAt = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the debug view's Settings button", () => {
  it("opens Voice Pilot's settings page and says nothing more once it shows", async () => {
    renderSlot({ component: DebugLogView }, { active: true }, { rpc: rpc() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.pathname).toBe(PLUGIN_SETTINGS_PATH);
    expect(popstate).toHaveBeenCalledOnce();
    window.removeEventListener("popstate", popstate);

    // bb draws the settings page, and with it the plugin's Voice hooks section.
    renderSlot({ component: VoiceHooksSection }, {}, { rpc: rpc() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_SHOW_WAIT_MS);
    });
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("says where the settings are when the page never shows", async () => {
    renderSlot({ component: DebugLogView }, { active: true }, { rpc: rpc() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_SHOW_WAIT_MS - 1);
    });
    expect(toast.info).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(SETTINGS_WHERE);
  });

  it("says where the settings are at once when the browser refuses the route", async () => {
    renderSlot({ component: DebugLogView }, { active: true }, { rpc: rpc() });
    const push = vi.spyOn(window.history, "pushState").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledExactlyOnceWith(SETTINGS_WHERE));
    push.mockRestore();
  });
});
