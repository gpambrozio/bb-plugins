/**
 * The seams between Herald's decisions and bb. Everything in `server/` that
 * decides something talks to these, so the tests can hand it fakes; the
 * implementations over `bb.sdk` are in `bb-ports.ts`.
 */
import type { PluginBbSdk, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";

/** The thread as every event carries it — the same DTO `GET /threads/:id` serves. */
export type ThreadDto = PluginThreadEventPayloads["thread.idle"]["thread"];
export type Interaction = PluginThreadEventPayloads["interaction.pending"]["interaction"];
export type PromptRecord = Awaited<ReturnType<PluginBbSdk["threads"]["promptHistory"]>>[number];

/** What names the work, and what was asked of it; looked up per event, since a thread's DTO has neither. */
export interface ThreadContext {
  projectName: string | null;
  folder: string | null;
  /** The user's last message, when the caller asked for it. */
  lastRequest: string | null;
}

export interface EventsPort {
  context(thread: ThreadDto, options: { withRequest: boolean }): Promise<ThreadContext>;
  /** Whether a turn is in flight right now. Uncached: it decides whether a fresh summary is still worth saying. */
  isRunning(threadId: string): Promise<boolean>;
  /** Whether an interaction is still waiting on the user; answering one fires no event. */
  interactionPending(threadId: string, interactionId: string): Promise<boolean>;
  /**
   * Whether one of the thread's interactions was interrupted within `withinMs`
   * — the user stopped the turn while it waited on them — which is why a
   * failure that follows is not news.
   */
  interruptedRecently(threadId: string, withinMs: number): Promise<boolean>;
}

export type ThreadFacts =
  | { kind: "gone" }
  | {
      kind: "open";
      status: ThreadDto["status"];
      lastReadAt: number | null;
      latestAttentionAt: number;
    };

export interface LivenessPort {
  facts(threadId: string): Promise<ThreadFacts>;
  /** Whether the interaction an entry answers to is still waiting on the user. */
  interactionPending(threadId: string, interactionId: string): Promise<boolean>;
}

export interface HelperSpawn {
  title: string;
  prompt: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  /** Kept on the helper as this plugin's metadata, for anyone reading it later. */
  metadata: Record<string, string>;
}

export interface HelperPort {
  /** Starts a hidden helper thread and resolves to its id. */
  spawn(args: HelperSpawn): Promise<string>;
  stop(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
  delete(threadId: string): Promise<void>;
  /** Hidden helper threads of this plugin created before `createdBefore` and not archived. */
  listLeftovers(createdBefore: number): Promise<string[]>;
}

export interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
