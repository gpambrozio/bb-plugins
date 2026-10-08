// screen-sharing — the server entry.
//
// Runs in the bb server's process, on the Mac running the bb server: the only
// Mac this version reaches. The app's noVNC opens a WebSocket to this plugin's
// own route on the bb server, with a ticket from `openSession`; the relay
// copies its bytes to and from macOS Screen Sharing on 127.0.0.1:5900. Nothing
// is exposed: the route is reached over loopback, or through bb's own
// getbb.app tunnel behind the owner's sign-in. See AGENTS.md.
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { CloseCode, SESSION_LIMITS, SESSIONS_CHANGED, VNC_ROUTE, type SessionList } from "./shared/channels";
import { rpcContract } from "./shared/contract";
import { createRelay } from "./server/relay";
import { SessionRegistry } from "./server/sessions";
import { checkScreenSharing, launchctlScreenSharingDisabled, probeRfb } from "./server/status";

export type { RpcContract } from "./shared/contract";

const SCREEN_SHARING_PORT = 5900;
/** The app opens its WebSocket right after asking for a ticket. */
const TICKET_TTL_MS = 30_000;
const IDLE_MS = SESSION_LIMITS.idleMinutes * 60_000;
const MAX_AGE_MS = SESSION_LIMITS.maxHours * 60 * 60_000;
const SWEEP_MS = 15_000;
const MAX_TICKETS = 16;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export default async function plugin(bb: BbPluginApi) {
  const registry = new SessionRegistry({
    now: () => Date.now(),
    randomId: () => randomBytes(32).toString("base64url"),
    ticketTtlMs: TICKET_TTL_MS,
    idleMs: IDLE_MS,
    maxAgeMs: MAX_AGE_MS,
    maxTickets: MAX_TICKETS,
    onChange: (sessions) => bb.realtime.publish(SESSIONS_CHANGED, { sessions } satisfies SessionList),
  });

  /** The Mac running the bb server: the only one this version relays to. */
  async function serverHost(): Promise<{ id: string; name: string }> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) throw new Error("this bb has no server machine yet");
    const host = await bb.sdk.hosts.get({ hostId: primaryHostId });
    return { id: primaryHostId, name: host.name };
  }

  bb.rpc.register(rpcContract, {
    status: async () => {
      const host = await serverHost();
      const check = await checkScreenSharing({
        platform: process.platform,
        probe: () => probeRfb(SCREEN_SHARING_PORT),
        serviceDisabled: () => launchctlScreenSharingDisabled(),
      });
      return { hostId: host.id, hostName: host.name, ...check };
    },
    openSession: async ({ hostId }, context) => {
      // Other plugins have no business opening someone's screen. bb counts the app, the bb CLI and
      // agents alike as "client", so this refuses only plugins calling through bb.sdk.plugins.callRpc.
      if (context.experimental_caller.kind !== "client") throw new Error("other plugins cannot open a session");
      const host = await serverHost();
      if (hostId !== host.id) {
        throw new Error(`only ${host.name}, the Mac running the bb server, can be shared in this version`);
      }
      return registry.mint(host.id);
    },
    sessions: () => ({ sessions: registry.list() }),
    closeAll: () => ({ closed: registry.closeAll() }),
  });

  // "local": a browser must be on a bb app origin, which is the app itself, on
  // loopback or through bb's getbb.app tunnel. Other sites are refused.
  bb.http.experimental_websocket(
    VNC_ROUTE,
    createRelay({
      registry,
      connect: () => connect({ host: "127.0.0.1", port: SCREEN_SHARING_PORT }),
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      log: (message) => bb.log.info(message),
    }),
    { auth: "local" },
  );

  const sweep = setInterval(() => registry.sweep(), SWEEP_MS);
  sweep.unref?.();

  bb.onDispose(() => {
    clearInterval(sweep);
    registry.closeAll(CloseCode.stopping, "Screen Sharing plugin stopped");
  });
}
