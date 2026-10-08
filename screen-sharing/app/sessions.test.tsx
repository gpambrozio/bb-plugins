// @vitest-environment jsdom
/**
 * The two always-visible signs of an open session: the sidebar row's "Live"
 * and the corner pill with Close all, which steps aside while the Screen
 * Sharing page itself is on screen.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import { SESSIONS_CHANGED, type SessionInfo } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { LiveAccessory, LiveSessionsOverlay, PANEL_PATH, usePageOpen } from "./sessions";

afterEach(() => cleanup());

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

describe("the sidebar row", () => {
  it("says Live while a session is open, and nothing otherwise", async () => {
    const view = renderSlot({ component: LiveAccessory }, {}, { rpc: stubs([session]) });
    expect(await screen.findByText("Live")).toBeTruthy();
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [session, { ...session, id: "s2" }] });
    expect(await screen.findByText("2 live")).toBeTruthy();
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: [] });
    await waitFor(() => expect(screen.queryByText(/live/i)).toBeNull());
  });

  it("ignores a malformed push", async () => {
    const view = renderSlot({ component: LiveAccessory }, {}, { rpc: stubs([session]) });
    expect(await screen.findByText("Live")).toBeTruthy();
    await view.emitRealtime(SESSIONS_CHANGED, { sessions: "nope" });
    expect(screen.getByText("Live")).toBeTruthy();
  });
});

describe("the corner pill", () => {
  it("offers Close all and the page while a session is open", async () => {
    const view = renderSlot({ component: LiveSessionsOverlay }, {}, { rpc: stubs([session]) });
    expect(await screen.findByRole("status", { name: "Screen Sharing sessions open" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close all" }));
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "closeAll")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Screen Sharing · Live/ }));
    expect(view.navigateCalls).toEqual([{ method: "toPluginPanel", path: PANEL_PATH }]);
  });

  it("is absent with no session open", async () => {
    const view = renderSlot({ component: LiveSessionsOverlay }, {}, { rpc: stubs([]) });
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "sessions")).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
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
    expect(screen.queryByRole("status")).toBeNull();
  });
});
