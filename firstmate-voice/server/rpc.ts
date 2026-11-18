/**
 * The app-facing RPC handlers. A session spends the captain's ChatGPT plan and speaks for the captain to the
 * first mate, so another plugin is refused before anything runs, the credential lookup and the takeover of a
 * live session included; so are the debug log and the voice hooks' status. No RPC sets, reads or names a
 * hook command: each machine runs only its own hook file, which the owner writes there.
 *
 * This is not an app-only gate. bb 0.49 names both its app and its command line (`bb plugin rpc call`) a
 * `client`, with nothing else to tell them apart, so anything that can run `bb` on the owner's bb (an agent
 * in a thread included) passes it. See AGENTS.md, "Who can reach the RPCs".
 */
import { experimental_PluginRpcRefusal as PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";

import type { rpcContract } from "../server";
import { hookTarget, type MachineHookStatus } from "./hooks";
import type { CrewPort } from "./ports";
import type { VoiceSessions } from "./session";

type Caller = { kind: string } | undefined;

/** Throws unless bb names the caller as a client (its app, or its command line); plugins and an unknown caller are refused. */
export function requireApp(caller: Caller): void {
  if (caller?.kind !== "client") {
    throw new PluginRpcRefusal({ code: "forbidden", message: "FirstMate voice sessions are opened from bb's app only, never by another plugin." });
  }
}

/** The voice hooks as the RPCs need them: bb's active machines, and whether each has a hook file. */
export interface HooksRpcPort {
  hosts(): Promise<Array<{ id: string; name: string }>>;
  statuses(hosts: Array<{ id: string; name: string }>): Promise<MachineHookStatus[]>;
}

export function sessionHandlers(
  sessions: Pick<VoiceSessions, "start" | "renew" | "renewed" | "end" | "alive" | "current" | "debugPage">,
  crew: Pick<CrewPort, "mateThreadId">,
  hooks: HooksRpcPort,
): ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> {
  return {
    "session.start": async ({ sdp, hostId, client }, ctx) => {
      requireApp(ctx?.experimental_caller);
      // A machine list that cannot be read runs no hooks; the call goes on.
      const hosts = await hooks.hosts().catch(() => []);
      return sessions.start(sdp, hookTarget(client, hostId, hosts));
    },
    "session.renew": async ({ sessionId, sdp }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return sessions.renew(sessionId, sdp);
    },
    "session.renewed": async ({ sessionId }, ctx) => {
      requireApp(ctx?.experimental_caller);
      await sessions.renewed(sessionId);
      return null;
    },
    "session.end": async ({ sessionId, reason }, ctx) => {
      requireApp(ctx?.experimental_caller);
      await sessions.end(sessionId, reason);
      return null;
    },
    "session.alive": async ({ sessionId }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return { live: sessions.alive(sessionId) };
    },
    "session.current": async (_input, ctx) => {
      requireApp(ctx?.experimental_caller);
      return { sessionId: sessions.current()?.id ?? null };
    },
    "debug.log": async ({ afterSeq }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return sessions.debugPage(afterSeq);
    },
    "hooks.status": async (_input, ctx) => {
      requireApp(ctx?.experimental_caller);
      return { machines: await hooks.statuses(await hooks.hosts()) };
    },
    "mate.thread": async (_input, ctx) => {
      requireApp(ctx?.experimental_caller);
      try {
        return { threadId: await crew.mateThreadId() };
      } catch {
        // firstmate-crew missing, off, or not letting this plugin in: no Talk button on any thread.
        return { threadId: null };
      }
    },
  };
}
