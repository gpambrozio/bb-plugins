// @vitest-environment jsdom
/**
 * The two always-visible signs of an open session: the sidebar entry's LIVE
 * badge and the corner pill with Close all, which steps aside while the Screen
 * Sharing page itself is on screen.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import { SESSIONS_CHANGED, type SessionInfo } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { LiveSessionsOverlay, PANEL_PATH, useLiveBadge, usePageOpen } from "./sessions";

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
