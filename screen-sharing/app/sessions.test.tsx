// @vitest-environment jsdom
/**
 * The two always-visible signs of an open session: the sidebar entry's LIVE
 * badge and the toast with Close all, which steps aside while the Screen
 * Sharing page itself is on screen.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { toast, type ExternalToast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSIONS_CHANGED, type SessionInfo } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { LIVE_TOAST_ID, LiveSessionsOverlay, PANEL_PATH, useLiveBadge, usePageOpen } from "./sessions";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.dismiss).mockClear();
});

const session: SessionInfo = { id: "s1", hostId: "host_mini", openedAt: 1, lastActivityAt: 1 };

/** Handlers for the methods these tests drive; any other method rejects, as an unstubbed one does. */
function stubs(sessions: SessionInfo[]): PluginRpcTestHandlers<RpcContract> {
  const handlers: Partial<PluginRpcTestHandlers<RpcContract>> = {
    sessions: () => ({ sessions }),
    closeAll: () => ({ closed: sessions.length }),
  };
  return handlers as PluginRpcTestHandlers<RpcContract>;
}

function PageStandIn() {
  usePageOpen();
  return null;
}

function BadgeProbe() {
  return <output data-testid="badge">{JSON.stringify(useLiveBadge())}</output>;
}

function badge(): unknown {
  return JSON.parse(screen.getByTestId("badge").textContent ?? "");
}

const oneLive = { text: "LIVE", tone: "critical", label: "1 Screen Sharing session open" };

describe("the sidebar entry", () => {
  it("is the panel's badge", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => panel.experimental_useBadge)).toEqual([useLiveBadge]);
  });

  it("says LIVE while a session is open, with the count in its label, and nothing otherwise", async () => {
    const view = renderSlot({ component: BadgeProbe }, {}, { rpc: stubs([session]) });
    await waitFor(() => expect(badge()).toEqual(oneLive));
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [session, { ...session, id: "s2" }] });
    await waitFor(() => expect(badge()).toEqual({ ...oneLive, label: "2 Screen Sharing sessions open" }));
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [] });
    await waitFor(() => expect(badge()).toBeNull());
  });

  it("ignores a malformed push", async () => {
    const view = renderSlot({ component: BadgeProbe }, {}, { rpc: stubs([session]) });
    await waitFor(() => expect(badge()).toEqual(oneLive));
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: "nope" });
    expect(badge()).toEqual(oneLive);
  });
});

describe("the live-sessions toast", () => {
  /** The last toast shown, as sonner received it. */
  function shown(): { title: string; options: ExternalToast } {
    const call = vi.mocked(toast).mock.calls.at(-1);
    if (!call) throw new Error("no toast shown");
    return { title: String(call[0]), options: call[1] ?? {} };
  }

  function click(button: unknown, prevent = vi.fn()): ReturnType<typeof vi.fn> {
    (button as { onClick(event: unknown): void }).onClick({ preventDefault: prevent });
    return prevent;
  }

  it("stays up with the live count, Close all and Open while a session is open", async () => {
    const view = renderSlot({ component: LiveSessionsOverlay }, {}, { rpc: stubs([session]) });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const { title, options } = shown();
    expect(title).toBe("Screen Sharing · Live");
    expect(options).toMatchObject({ id: LIVE_TOAST_ID, duration: Infinity, dismissible: false });
    expect(options.action).toMatchObject({ label: "Close all" });
    expect(options.cancel).toMatchObject({ label: "Open" });

    // Close all keeps the toast up: it goes when the sessions do.
    const prevent = click(options.action);
    expect(prevent).toHaveBeenCalled();
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "closeAll")).toBe(true));

    click(options.cancel);
    expect(view.navigateCalls).toEqual([{ method: "toPluginPanel", path: PANEL_PATH }]);
  });

  it("updates the count in place and goes when no session is left", async () => {
    const view = renderSlot({ component: LiveSessionsOverlay }, {}, { rpc: stubs([session]) });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [session, { ...session, id: "s2" }] });
    await waitFor(() => expect(shown().title).toBe("Screen Sharing · 2 live"));
    expect(shown().options.id).toBe(LIVE_TOAST_ID);
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [] });
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith(LIVE_TOAST_ID));
  });

  it("is not shown with no session open", async () => {
    const view = renderSlot({ component: LiveSessionsOverlay }, {}, { rpc: stubs([]) });
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "sessions")).toBe(true));
    expect(toast).not.toHaveBeenCalled();
  });

  it("steps aside while the page is on screen", async () => {
    const view = renderSlot(
      {
        component: () => (
          <>
            <PageStandIn />
            <LiveSessionsOverlay />
          </>
        ),
      },
      {},
      { rpc: stubs([session]) },
    );
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "sessions")).toBe(true));
    expect(toast).not.toHaveBeenCalled();
  });

  it("is taken away when the overlay unmounts", async () => {
    const view = renderSlot({ component: LiveSessionsOverlay }, {}, { rpc: stubs([session]) });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    vi.mocked(toast.dismiss).mockClear();
    view.unmount();
    expect(toast.dismiss).toHaveBeenCalledWith(LIVE_TOAST_ID);
  });
});
