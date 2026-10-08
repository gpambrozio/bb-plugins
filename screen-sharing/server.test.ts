/**
 * The plugin against bb's fake host: the relay route is registered with
 * "local" auth, tickets are only for the Mac running the bb server and only
 * for the bb app, and stopping the plugin ends every session.
 *
 * The route is driven only with tickets it must refuse, so no test here
 * connects to this machine's real port 5900; server/relay.test.ts covers the
 * relay against a fake Screen Sharing.
 */
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "./server";
import { CloseCode, SESSIONS_CHANGED, VNC_ROUTE } from "./shared/channels";

const hosts: { harness: { dispose(): Promise<void> } }[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

async function load() {
  const host = createFakePluginHost({ pluginId: "screen-sharing" });
  hosts.push(host);
  host.harness.sdk.stub("system.config", () => ({ primaryHostId: "host_mini" }));
  host.harness.sdk.stub("hosts.get", () => makeHostResponse({ id: "host_mini", name: "MacMini" }));
  await plugin(host.bb);
  return host;
}

describe("the screen-sharing plugin", () => {
  it("registers its relay as a same-origin WebSocket route", async () => {
    const { harness } = await load();
    expect(harness.registrations.websocketRoutes.map((route) => [route.path, route.auth])).toEqual([[VNC_ROUTE, "local"]]);
    expect(harness.registrations.httpRoutes).toEqual([]);
    expect(harness.sharedPortDeclarations).toEqual([]);
  });

  it("gives the app a ticket for the server's Mac", async () => {
    const { harness } = await load();
    const ticket = (await harness.callRpc("openSession", { hostId: "host_mini" })) as { token: string; expiresAt: number };
    expect(ticket.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses any other Mac", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("openSession", { hostId: "host_laptop" })).rejects.toThrow(
      "only MacMini, the Mac running the bb server, can be shared in this version",
    );
  });

  it("refuses other plugins", async () => {
    const { harness } = await load();
    await expect(
      harness.callRpc("openSession", { hostId: "host_mini" }, { experimental_caller: { kind: "plugin", pluginId: "nosy" } }),
    ).rejects.toThrow("only the bb app can open a session");
  });

  it("closes a WebSocket that brings no valid ticket", async () => {
    const { harness } = await load();
    const forged = await harness.experimental_openWebSocket(`${VNC_ROUTE}?host=host_mini&token=forged`);
    expect(forged.closeCalls).toEqual([{ code: CloseCode.policy, reason: "unknown or already used ticket" }]);

    const ticket = (await harness.callRpc("openSession", { hostId: "host_mini" })) as { token: string };
    const elsewhere = await harness.experimental_openWebSocket(`${VNC_ROUTE}?host=host_laptop&token=${ticket.token}`);
    expect(elsewhere.closeCalls).toEqual([{ code: CloseCode.policy, reason: "ticket is for another Mac" }]);
    expect(await harness.callRpc("sessions", {})).toEqual({ sessions: [] });
  });

  it("answers the session list and Close all with nothing open", async () => {
    const { harness } = await load();
    expect(await harness.callRpc("sessions", {})).toEqual({ sessions: [] });
    expect(await harness.callRpc("closeAll", {})).toEqual({ closed: 0 });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === SESSIONS_CHANGED)).toEqual([]);
  });
});
