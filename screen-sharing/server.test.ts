/**
 * The plugin against bb's fake host: the relay route is registered with
 * "local" auth, tickets are only for machines bb has and only for the bb app,
 * and nothing is ever exposed.
 *
 * The route is driven only with tickets it must refuse, so no test here
 * connects to this machine's real port 5900; server/relay.test.ts covers the
 * relay against a fake Screen Sharing, server/remote.test.ts the other Macs.
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
  host.harness.sdk.stub("hosts.list", () => [
    makeHostResponse({ id: "host_mini", name: "MacMini" }),
    makeHostResponse({ id: "host_laptop", name: "MacBook Pro" }),
  ]);
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

  it("refuses a machine bb does not have", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("openSession", { hostId: "host_elsewhere" })).rejects.toThrow("bb has no such machine");
  });

  it("refuses other plugins", async () => {
    const { harness } = await load();
    await expect(
      harness.callRpc("openSession", { hostId: "host_mini" }, { experimental_caller: { kind: "plugin", pluginId: "nosy" } }),
    ).rejects.toThrow("other plugins cannot open a session");
  });

  it("closes a WebSocket that brings no valid ticket", async () => {
    const { harness } = await load();
    const forged = await harness.experimental_openWebSocket(`${VNC_ROUTE}?host=host_mini&flow=ack&token=forged`);
    expect(forged.closeCalls).toEqual([{ code: CloseCode.policy, reason: "unknown or already used ticket" }]);

    const ticket = (await harness.callRpc("openSession", { hostId: "host_mini" })) as { token: string };
    const elsewhere = await harness.experimental_openWebSocket(`${VNC_ROUTE}?host=host_laptop&flow=ack&token=${ticket.token}`);
    expect(elsewhere.closeCalls).toEqual([{ code: CloseCode.policy, reason: "ticket is for another Mac" }]);
    expect(await harness.callRpc("sessions", {})).toEqual({ sessions: [] });
  });

  it("Close all voids a ticket whose WebSocket has not arrived yet", async () => {
    const { harness } = await load();
    const ticket = (await harness.callRpc("openSession", { hostId: "host_mini" })) as { token: string };
    await harness.callRpc("closeAll", {});
    const late = await harness.experimental_openWebSocket(`${VNC_ROUTE}?host=host_mini&flow=ack&token=${ticket.token}`);
    expect(late.closeCalls).toEqual([{ code: CloseCode.policy, reason: "unknown or already used ticket" }]);
  });

  it("Close all voids a ticket request still on its way", async () => {
    const { harness } = await load();
    let release: () => void = () => {};
    const configured = new Promise<void>((resolve) => (release = resolve));
    harness.sdk.stub("system.config", async () => {
      await configured;
      return { primaryHostId: "host_mini" };
    });
    const pending = harness.callRpc("openSession", { hostId: "host_mini" });
    await harness.callRpc("closeAll", {});
    release();
    await expect(pending).rejects.toThrow("Close all ended sessions while this one was starting");
  });

  it("answers the session list and Close all with nothing open", async () => {
    const { harness } = await load();
    expect(await harness.callRpc("sessions", {})).toEqual({ sessions: [] });
    expect(await harness.callRpc("closeAll", {})).toEqual({ closed: 0 });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === SESSIONS_CHANGED)).toEqual([]);
  });
});
