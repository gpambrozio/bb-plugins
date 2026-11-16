/**
 * The app-facing RPC handlers. A session spends the captain's ChatGPT plan and speaks for the captain to the
 * first mate, so only bb's app may open or steer one: any other plugin is refused before anything runs, the
 * credential lookup and the takeover of a live session included.
 */
import { experimental_PluginRpcRefusal as PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";

import type { rpcContract } from "../server";
import type { CrewPort } from "./ports";
import type { VoiceSessions } from "./session";

type Caller = { kind: string } | undefined;

/** Throws unless bb names the caller as a client (the app); plugins and an unknown caller are refused. */
export function requireApp(caller: Caller): void {
  if (caller?.kind !== "client") {
    throw new PluginRpcRefusal({ code: "forbidden", message: "FirstMate voice sessions are opened from bb's app only, never by another plugin." });
  }
}

export function sessionHandlers(
  sessions: Pick<VoiceSessions, "start" | "renew" | "renewed" | "end" | "alive" | "current" | "debugPage">,
  crew: Pick<CrewPort, "mateThreadId">,
): ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> {
  return {
    "session.start": async ({ sdp }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return sessions.start(sdp);
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
