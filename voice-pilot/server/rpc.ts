/**
 * The app-facing RPC handlers. A session spends the owner's OpenAI key or ChatGPT plan and acts in bb for
 * them, so another plugin is refused before anything runs, the credential lookup and the takeover of a live
 * session included; so are the debug log and the voice hooks' status. No RPC sets, reads or names a hook
 * command: each machine runs only its own hook file, which the owner writes there.
 *
 * This is not an app-only gate. bb names both its app and its command line (`bb plugin rpc call`) a
 * `client`, with nothing else to tell them apart, so anything that can run `bb` on the owner's bb (an agent
 * in a thread included) passes it, as it could reach bb's own thread APIs. See AGENTS.md.
 */
import { experimental_PluginRpcRefusal as PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";

import type { rpcContract } from "../server";
import { hookTarget, type MachineHookStatus } from "./hooks";
import type { PromptEdits } from "./prompt-edits";
import type { VoiceSessions } from "./session";

type Caller = { kind: string } | undefined;

/** Throws unless bb names the caller as a client (its app, or its command line); plugins and an unknown caller are refused. */
export function requireApp(caller: Caller): void {
  if (caller?.kind !== "client") {
    throw new PluginRpcRefusal({ code: "forbidden", message: "Voice Pilot sessions are opened from bb's app only, never by another plugin." });
  }
}

/** The voice hooks as the RPCs need them: bb's active machines, and whether each has a hook file. */
export interface HooksRpcPort {
  hosts(): Promise<Array<{ id: string; name: string }>>;
  statuses(hosts: Array<{ id: string; name: string }>): Promise<MachineHookStatus[]>;
}

type PromptMethods = "prompt.staged" | "prompt.apply" | "prompt.reject";

/**
 * The staged edit of the voice's instructions. Only bb's app (or its command line, which bb cannot tell apart)
 * reads, applies or rejects it; the voice only stages one, through its tool. See AGENTS.md.
 */
export function promptHandlers(prompts: Pick<PromptEdits, "read" | "apply" | "reject">): Pick<ExperimentalPluginRpcHandlersWithContext<typeof rpcContract>, PromptMethods> {
  return {
    "prompt.staged": async (_input, ctx) => {
      requireApp(ctx?.experimental_caller);
      return prompts.read();
    },
    "prompt.apply": async ({ id, text }, ctx) => {
      requireApp(ctx?.experimental_caller);
      await prompts.apply(id, text);
      return { applied: true as const };
    },
    "prompt.reject": async ({ id }, ctx) => {
      requireApp(ctx?.experimental_caller);
      await prompts.reject(id);
      return null;
    },
  };
}

export function sessionHandlers(
  sessions: Pick<VoiceSessions, "start" | "renew" | "renewed" | "end" | "pause" | "resume" | "alive" | "focus" | "current" | "debugPage">,
  hooks: HooksRpcPort,
): Omit<ExperimentalPluginRpcHandlersWithContext<typeof rpcContract>, PromptMethods> {
  return {
    "session.start": async ({ sdp, hostId, client, threadId }, ctx) => {
      requireApp(ctx?.experimental_caller);
      // A machine list that cannot be read runs no hooks; the call goes on.
      const hosts = await hooks.hosts().catch(() => []);
      // Only bb's mobile app is suspended when it leaves the screen: its sessions pause there instead of ending.
      return sessions.start(sdp, hookTarget(client, hostId, hosts), threadId ?? null, client === "mobile");
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
    "session.pause": async ({ sessionId, reason }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return { paused: await sessions.pause(sessionId, reason) };
    },
    "session.resume": async ({ sessionId, sdp }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return sessions.resume(sessionId, sdp);
    },
    "session.alive": async ({ sessionId, threadId }, ctx) => {
      requireApp(ctx?.experimental_caller);
      return { live: sessions.alive(sessionId, threadId) };
    },
    "session.focus": async ({ sessionId, threadId }, ctx) => {
      requireApp(ctx?.experimental_caller);
      sessions.focus(sessionId, threadId);
      return null;
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
  };
}
