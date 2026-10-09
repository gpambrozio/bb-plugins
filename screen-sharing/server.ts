// screen-sharing — the server entry.
//
// Runs in the bb server's process. The app's noVNC opens a WebSocket to this
// plugin's own route on the bb server, with a ticket from `openSession`; the
// relay copies its bytes to and from the chosen Mac's Screen Sharing: over a
// loopback TCP connection when that Mac is the bb server's own, and over bb's
// host link to the plugin's host entry (host.ts) for every other enrolled Mac.
// Nothing is exposed: the route is reached over loopback, or through bb's own
// getbb.app tunnel behind the owner's sign-in. See AGENTS.md.
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  CloseCode,
  SESSION_LIMITS,
  SESSIONS_CHANGED,
  VNC_ROUTE,
  type HostEntry,
  type ScreenStatus,
  type SessionList,
} from "./shared/channels";
import { rpcContract } from "./shared/contract";
import { hostContract, hostSignals } from "./shared/host-contract";
import { HOST_KEEPALIVE_MS, LOOPBACK_WINDOW_BYTES, MAX_PIPELINED_WRITES, SCREEN_SHARING_PORT } from "./shared/limits";
import { checkScreenSharing, launchctlScreenSharingDisabled, probeRfb } from "./host/status";
import { HostLinks } from "./server/host-link";
import { errorText, type OpenLink } from "./server/link";
import { createLoopbackLink } from "./server/loopback-link";
import { createRelay } from "./server/relay";
import { SessionRegistry, type TicketTarget } from "./server/sessions";

export type { RpcContract } from "./shared/contract";

/** The app opens its WebSocket right after asking for a ticket. */
const TICKET_TTL_MS = 30_000;
const IDLE_MS = SESSION_LIMITS.idleMinutes * 60_000;
const MAX_AGE_MS = SESSION_LIMITS.maxHours * 60 * 60_000;
const SWEEP_MS = 15_000;
const MAX_TICKETS = 16;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Connecting to a remote Mac's Screen Sharing: two round trips and a TCP connect, with room to spare. */
const HOST_OPEN_TIMEOUT_MS = 15_000;
/** A status check on a remote Mac: a round trip, a TCP probe (3 s) and launchctl (3 s). */
const HOST_STATUS_TIMEOUT_MS = 12_000;

type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];

function usable(host: Host): boolean {
  return host.lifecycle.phase !== "destroyed" && host.lifecycle.phase !== "removing";
}

function connected(host: Host): boolean {
  return host.status === "connected" && host.lifecycle.phase === "active";
}

export default async function plugin(bb: BbPluginApi) {
  /** Late callbacks (a host call failing after a reload) may log after bb has retired this instance. */
  function log(message: string): void {
    try {
      bb.log.info(message);
    } catch {
      // This instance is gone; the message has nowhere to go.
    }
  }

  const registry = new SessionRegistry({
    now: () => Date.now(),
    randomId: () => randomBytes(32).toString("base64url"),
    ticketTtlMs: TICKET_TTL_MS,
    idleMs: IDLE_MS,
    maxAgeMs: MAX_AGE_MS,
    maxTickets: MAX_TICKETS,
    onChange: (sessions) => {
      try {
        bb.realtime.publish(SESSIONS_CHANGED, { sessions } satisfies SessionList);
      } catch {
        // A retired instance has no app to tell; the new one publishes its own list.
      }
    },
  });

  const hostClient = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const hostLinks = new HostLinks({
    client: hostClient,
    maxPipelinedWrites: MAX_PIPELINED_WRITES,
    maxQueuedBytes: MAX_BUFFERED_BYTES,
    keepaliveMs: HOST_KEEPALIVE_MS,
    openTimeoutMs: HOST_OPEN_TIMEOUT_MS,
    now: () => Date.now(),
    log,
  });
  // Signal handlers do their work at once: bb starts each as it arrives, so they stay in order.
  bb.onDispose(hostClient.experimental_onSignal("data", ({ hostId, payload }) => hostLinks.data(hostId, payload)));
  bb.onDispose(hostClient.experimental_onSignal("closed", ({ hostId, payload }) => hostLinks.closed(hostId, payload)));
  bb.onDispose(hostClient.experimental_onWorkerExit(({ hostId }) => hostLinks.workerExited(hostId)));

  async function primaryHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  /** The Mac a session to `hostId` would reach, and how; throws when there is none to reach. */
  async function targetFor(hostId: string): Promise<TicketTarget> {
    const [primary, hosts] = await Promise.all([primaryHostId(), bb.sdk.hosts.list()]);
    const host = hosts.find((entry) => entry.id === hostId && usable(entry));
    if (host === undefined) throw new Error("bb has no such machine");
    if (hostId === primary) return { hostId, hostName: host.name, route: "loopback" };
    if (!connected(host)) throw new Error(`${host.name} is offline`);
    return { hostId, hostName: host.name, route: "host" };
  }

  async function status(hostId: string): Promise<ScreenStatus> {
    const [primary, hosts] = await Promise.all([primaryHostId(), bb.sdk.hosts.list()]);
    const host = hosts.find((entry) => entry.id === hostId && usable(entry));
    if (host === undefined) throw new Error("bb has no such machine");
    const known = { hostId, hostName: host.name, isServer: hostId === primary, unreachableReason: null };
    if (known.isServer) {
      const check = await checkScreenSharing({
        platform: process.platform,
        probe: () => probeRfb(SCREEN_SHARING_PORT),
        serviceDisabled: () => launchctlScreenSharingDisabled(),
      });
      return { ...known, ...check };
    }
    const nothing = { rfbVersion: null, securityTypes: [], signInSupported: false, refusedReason: null };
    if (!connected(host)) return { ...known, ...nothing, state: "offline" };
    try {
      const check = await hostClient.call("status", {}, { hostId, timeoutMs: HOST_STATUS_TIMEOUT_MS });
      return { ...known, ...check };
    } catch (error) {
      return { ...known, ...nothing, state: "unreachable", unreachableReason: errorText(error) };
    }
  }

  bb.rpc.register(rpcContract, {
    hosts: async () => {
      const [primary, hosts] = await Promise.all([primaryHostId(), bb.sdk.hosts.list()]);
      const listed: HostEntry[] = hosts
        .filter(usable)
        .map((host) => ({ id: host.id, name: host.name, connected: connected(host), isServer: host.id === primary }))
        .sort((a, b) => Number(b.isServer) - Number(a.isServer) || a.name.localeCompare(b.name));
      return { hosts: listed };
    },
    status: ({ hostId }) => status(hostId),
    openSession: async ({ hostId }, context) => {
      // Other plugins have no business opening someone's screen. bb counts the app, the bb CLI and
      // agents alike as "client", so this refuses only plugins calling through bb.sdk.plugins.callRpc.
      if (context.experimental_caller.kind !== "client") throw new Error("other plugins cannot open a session");
      // Read before the await: a Close all pressed meanwhile voids this request.
      const generation = registry.generation;
      const target = await targetFor(hostId);
      return registry.mint(target, generation);
    },
    sessions: () => ({ sessions: registry.list() }),
    closeAll: () => ({ closed: registry.closeAll() }),
  });

  const openLink: OpenLink = (target, events) =>
    target.route === "loopback"
      ? createLoopbackLink(
          {
            socket: connect({ host: "127.0.0.1", port: SCREEN_SHARING_PORT }),
            windowBytes: LOOPBACK_WINDOW_BYTES,
            maxBufferedBytes: MAX_BUFFERED_BYTES,
          },
          events,
        )
      : hostLinks.open(target, events);

  // "local": a browser must be on a bb app origin, which is the app itself, on
  // loopback or through bb's getbb.app tunnel. Other sites are refused.
  bb.http.experimental_websocket(
    VNC_ROUTE,
    createRelay({ registry, openLink, log }),
    { auth: "local" },
  );

  const sweep = setInterval(() => {
    registry.sweep();
    hostLinks.keepalive();
  }, SWEEP_MS);
  sweep.unref?.();

  bb.onDispose(() => {
    clearInterval(sweep);
    // Ends the remote sessions too: each link asks its host to close, and the hosts close
    // whatever is left when bb stops their workers or the server stops calling.
    registry.closeAll(CloseCode.stopping, "Screen Sharing plugin stopped");
  });
}
