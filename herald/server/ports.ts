/**
 * The seams between Herald's decisions and bb. Everything in `server/` that
 * decides something talks to these, so the tests can hand it fakes; the
 * implementations over `bb.sdk` are in `bb-ports.ts`.
 */
import type { PluginBbSdk, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";

import type { LevelDefaults, OwnLevel } from "../shared/push";
import type { ThreadChoice } from "../shared/thread-choice";

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
  /**
   * Whether one of the thread's interactions was interrupted within `withinMs`
   * — the user stopped the turn while it waited on them — which is why a
   * failure that follows is not news.
   */
  interruptedRecently(threadId: string, withinMs: number): Promise<boolean>;
  /**
   * Whether an interaction still waits on the user. Answering one fires no
   * event a plugin hears, so a sentence that took time to write asks before
   * it lands.
   */
  interactionPending(threadId: string, interactionId: string): Promise<boolean>;
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
}

/** What bb calls a thread now, for the Herald page's history. */
export interface NamesPort {
  /** The thread's title and project, or null when bb answers that it does not exist; rejects when bb cannot say. */
  thread(threadId: string): Promise<{ title: string | null; projectId: string } | null>;
  projectName(projectId: string): Promise<string>;
}

export interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * bb's push-notifications plugin, as Herald uses it: whether it can send,
 * each thread's own notification level, and the send. Every call goes
 * through `bb.sdk.plugins` to that plugin, which the user can turn off.
 */
export interface PushPort {
  /** Null when `notifications.send` can be called; otherwise why not, in words for the user. */
  unavailable(): Promise<string | null>;
  /** The thread's ancestors, parent first, or null when bb does not know the thread. */
  ancestors(threadId: string): Promise<string[] | null>;
  /** Every thread below this one, children first. */
  descendants(threadId: string): Promise<string[]>;
  /** The own level of each of these threads; a thread with none is left out. At most 200 ids. */
  ownLevels(threadIds: readonly string[]): Promise<Map<string, OwnLevel>>;
  setOwnLevel(threadId: string, level: OwnLevel): Promise<void>;
  /** bb's defaults for a thread without a level of its own. */
  defaults(): Promise<LevelDefaults>;
  /** Sends one notification; a tap opens `threadId`. Rejects with a `PushSendError` code when bb says why. */
  send(notification: { title: string; body: string; threadId: string }): Promise<void>;
}

/** Herald's per-thread choice, as bb stores it: plugin metadata on each thread, and each thread's ancestors. */
export interface ThreadChoicesPort {
  /** Each known thread with its ancestors, parent first; unknown ids are left out. At most `CHOICES_BATCH_MAX` ids. */
  ancestors(threadIds: readonly string[]): Promise<Array<{ threadId: string; ancestorIds: string[] }>>;
  /** The threads among these with a choice of their own. At most `CHOICES_BATCH_MAX` ids. */
  ownChoices(threadIds: readonly string[]): Promise<Map<string, ThreadChoice>>;
  /** Sets the thread's own choice, or clears it with null. */
  setOwn(threadId: string, choice: ThreadChoice | null): Promise<void>;
}

/** A message in a thread's timeline: what a sentence is placed against. */
export interface TimelineMessage {
  /** The id bb's timeline gives the row, which message metadata receives too. */
  id: string;
  createdAt: number;
  role: "user" | "assistant";
  /** Who sent a `user` row: the person, or another thread or bb itself (a child's report, say); null for an answer. */
  initiator: "user" | "agent" | "system" | null;
  /** The turn it belongs to; a prompt carries the turn it started or steered. */
  turnId: string | null;
  /** A `user` row bb has not delivered yet (a queued prompt, or one it refused): it led to nothing. */
  undelivered: boolean;
}

/** Any other top-level row of a turn — its work, a system row, a finished turn's "Worked for" — by when it started. */
export interface TimelineMark {
  turnId: string;
  startedAt: number;
  /** A finished turn's "Worked for" row, which folds the turn's work and its intermediate messages. */
  folded: boolean;
}

/** Where the next older page of a thread's timeline starts. */
export interface TimelineCursor {
  anchorId: string;
  anchorSeq: number;
}

/**
 * A thread's timeline as bb shows it, newest page first. Only the messages
 * at its top level count: a finished turn folds its work, and the messages
 * in it, into one "Worked for" row, which message metadata does not reach.
 */
export interface TimelinePort {
  page(
    threadId: string,
    older: TimelineCursor | null,
    signal?: AbortSignal,
  ): Promise<{ messages: TimelineMessage[]; marks: TimelineMark[]; older: TimelineCursor | null }>;
  /** Whether a turn may still be running: its messages can fold into its "Worked for" row when it ends. */
  running(threadId: string): Promise<boolean>;
}
