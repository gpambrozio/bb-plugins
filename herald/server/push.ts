/**
 * *Send Herald's sentences as push notifications*: for a thread Herald
 * announces, bb's own notification level is set to muted, and Herald sends
 * what that mute took away — the same events at the level bb would have
 * notified at, each with Herald's sentence. See AGENTS.md for the whole
 * story; the rules this module keeps:
 *
 * - **One queue.** Every read that decides an event and every level change
 *   runs in one queue, so a give-back always sees every takeover before it,
 *   and a takeover checks the lifecycle (`epoch`, `closed`) right before it
 *   commits. Closing shuts the queue to new level changes, drains it, and
 *   gives every level back.
 * - **Records are the claim, and they are kept on doubt.** `push:<threadId>`
 *   holds the level before the mute and when the mute was asked for, written
 *   before the mute. A mute or give-back whose call fails may still have
 *   landed, so the record stays held and the next read reconciles it with the
 *   level bb reports. A given-back record is kept a minute with when it was
 *   given back (`releasedAt`), for events bb read under the mute but Herald
 *   decides later — in another instance too.
 * - **Never a guess at bb's timing.** bb reads the level some time after an
 *   event — two seconds of coalescing, then reads with no bound — so Herald
 *   cannot know whether bb saw a mute. It counts a mute of its own as
 *   holding an event back if the mute was in force at any moment after the
 *   event: held now, or given back after it. That costs a rare second
 *   notification (a mute set while bb was already sending; a give-back while
 *   bb was still reading) and never a lost one.
 * - **A give-back waits for quiet.** A level goes back only once the thread
 *   and every thread below it have had no event for `RELEASE_QUIET_MS`,
 *   checked again just before the write, which keeps those duplicates rare.
 *   A give-back that fails is retried every `RETRY_MS`; one a newer decision
 *   no longer wants is dropped.
 * - **What is owed is sent.** A send that fails is tried again while it is
 *   still news, from storage (`outbox:`), so a reload does not lose it; the
 *   failure stops new takeovers and gives the levels back, but never drops
 *   what bb has already discarded.
 * - **Muted is all bb tells.** bb's levels carry no owner, so a mute someone
 *   else sets on a thread Herald holds is indistinguishable from Herald's,
 *   and is given back with it. README and AGENTS.md say so.
 */
import { randomUUID } from "node:crypto";

import type { PluginKvStorage } from "@get-bb/plugin-sdk";

import type { AttentionReason } from "../shared/herald";
import {
  levelAllows,
  OwnLevelSchema,
  pushBody,
  pushTitle,
  resolveLevel,
  type LevelDefaults,
  type OwnLevel,
  type PushStatus,
} from "../shared/push";
import type { ThreadChoice } from "../shared/thread-choice";
import type { Log, PushPort, ThreadFacts } from "./ports";

export const PUSH_RECORD_PREFIX = "push:";

/** Notifications whose send failed, waiting to be tried again; kept in storage across a reload. */
export const OUTBOX_PREFIX = "outbox:";

/** How long bb's answer to "can Herald send?" is trusted. */
export const AVAILABILITY_TTL_MS = 60_000;

/** A level is given back only once its thread and the threads below it have been quiet this long. */
export const RELEASE_QUIET_MS = 3_000;

/** How long a given-back record is kept, for events decided after the give-back however slowly. */
export const RELEASE_LOG_MS = 10 * 60_000;

/** How often a give-back that failed is tried again. */
export const RETRY_MS = 60_000;

/** When a send that failed is tried again, after each failure; then it is given up, with an error. */
export const SEND_RETRY_MS = [15_000, 60_000, 300_000] as const;

/** At most this long is spent waiting for quiet when Herald unloads. */
export const CLOSE_QUIET_MAX_MS = 3_000;

interface PushRecord {
  /** The thread's own level before Herald muted it. */
  previous: OwnLevel;
  /** When the mute was asked for; set before the call, so a mute that landed is never older. */
  mutedAt: number;
  /** When the level was given back; absent while Herald holds the mute. */
  releasedAt?: number;
}

/** What one event's decision reads: the thread, its ancestors and their levels, and Herald's records. */
interface LevelState {
  threadId: string;
  ancestorIds: string[];
  own: Map<string, OwnLevel>;
  records: Map<string, PushRecord>;
  defaults: LevelDefaults;
}

/** The event a decision is about: its kind, and when Herald heard of it. */
export interface PushEvent {
  reason: AttentionReason;
  at: number;
}

/** What a notification is about: the entry's names, its kind, and when it happened. */
export interface PushSubject {
  threadId: string;
  threadTitle: string | null;
  projectName: string | null;
  reason: AttentionReason;
  /** The interaction it is about, which must still wait when the notification goes. */
  requestId: string | null;
  createdAt: string;
}

/** Why a level goes back: everything at once (the switch, a failure — undone by switching on again), or one thread. */
type GiveBack = "all" | "thread";

interface Outgoing {
  /** Its row under `OUTBOX_PREFIX` once a send failed; null before. */
  id: string | null;
  subject: PushSubject;
  sentence: string;
  attempts: number;
  /** When it is next due. */
  dueAt: number;
}

function outgoingOf(id: string, raw: unknown): Outgoing | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Partial<Outgoing>;
  if (typeof row.sentence !== "string" || typeof row.attempts !== "number" || typeof row.subject !== "object" || row.subject === null) return null;
  return { id, subject: row.subject, sentence: row.sentence, attempts: row.attempts, dueAt: typeof row.dueAt === "number" ? row.dueAt : 0 };
}

export interface PushDeps {
  port: PushPort;
  kv: Pick<PluginKvStorage, "get" | "set" | "delete" | "list">;
  /** The switch in Herald's settings, read when it matters. */
  enabled: () => Promise<boolean>;
  /** Whether the thread still needs the user, as the notification goes. */
  facts: (threadId: string) => Promise<ThreadFacts>;
  interactionPending: (threadId: string, interactionId: string) => Promise<boolean>;
  log: Log;
  now?: () => number;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** bb answers a send for a thread deleted meanwhile with `thread_not_found`; that is not a broken channel. */
function isThreadNotFound(error: unknown): boolean {
  return /thread[ _]not[ _]found/i.test(reasonOf(error));
}

function recordOf(raw: unknown): PushRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const previous = OwnLevelSchema.safeParse(row.previous);
  if (!previous.success) return null;
  const mutedAt = typeof row.mutedAt === "number" ? row.mutedAt : 0;
  return typeof row.releasedAt === "number"
    ? { previous: previous.data, mutedAt, releasedAt: row.releasedAt }
    : { previous: previous.data, mutedAt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PushTakeover {
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  /** False until an earlier instance has given its threads back; until then, no level is changed. */
  private ready = false;
  /** Set when Herald unloads: no level is taken from then on. */
  private closed = false;
  /** Moves on every switch, failure and close; a takeover that began in an older one does not commit. */
  private epoch = 0;
  /** Why sending failed, once it did; cleared when the switch is turned on again. */
  private failure: string | null = null;
  private availability: { at: number; reason: string | null } | null = null;
  private loggedUnavailable: string | null = null;
  /** When each thread last had an event, as Herald heard it; a give-back waits for quiet. */
  private readonly lastEventAt = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Give-backs that failed, to try again. */
  private readonly retries = new Map<string, GiveBack>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sends under way, which an unload waits for so none fails unrecorded. */
  private readonly sending = new Set<Promise<void>>();
  /** Threads archived or deleted while loaded: never taken over again. */
  private readonly forgotten = new Set<string>();
  /** Outbox rows this instance has scheduled or is sending, so a re-scan does not take them twice. */
  private readonly scheduledSends = new Set<string>();
  private readonly attempting = new Set<string>();
  /** The latest give-back asked for, per thread; an older one is dropped. */
  private readonly giveBackTokens = new Map<string, number>();
  private tokenCounter = 0;

  constructor(private readonly deps: PushDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Levels may change from now on: the instance before this one, if any, has
   * given its threads back and stored what it could not send. Those sends are
   * taken up here.
   */
  setReady(): Promise<void> {
    this.ready = true;
    this.rescanOutboxLater();
    return this.resumeOutbox();
  }

  /**
   * The instance before may still be finishing an event after it signalled
   * it was done — bb drains its handlers after Herald's own unload — and
   * store a send that failed then; so the outbox is read again every
   * `RETRY_MS` while this instance is loaded.
   */
  private rescanOutboxLater(): void {
    if (this.closed) return;
    this.setTimer(RETRY_MS, () => {
      void this.resumeOutbox().finally(() => this.rescanOutboxLater());
    });
  }

  /** The switch was turned on: a failure before it is forgotten, and bb is asked afresh. */
  switchedOn(): void {
    this.epoch += 1;
    this.failure = null;
    this.availability = null;
    this.loggedUnavailable = null;
  }

  /** The switch was turned off: no takeover from now on, and every level goes back once quiet. */
  switchedOff(): Promise<void> {
    this.epoch += 1;
    return this.giveBackAll();
  }

  /** An event arrived for the thread: noted at once, before any lookup, so a give-back waits for its flush. */
  saw(threadId: string, at: number): void {
    this.lastEventAt.set(threadId, Math.max(at, this.lastEventAt.get(threadId) ?? 0));
    if (this.lastEventAt.size > 500) {
      for (const [id, when] of this.lastEventAt) if (at - when > RELEASE_LOG_MS) this.lastEventAt.delete(id);
    }
  }

  async status(): Promise<PushStatus> {
    const held = await this.heldIds().catch(() => [] as string[]);
    const them = held.length === 1 ? "it" : "them";
    const stuck =
      held.length === 0
        ? ""
        : ` ${held.length === 1 ? "1 thread is" : `${held.length} threads are`} still muted in bb by Herald, which notifies for ${them} until bb takes ${them} back.`;
    if (!(await this.deps.enabled())) return { state: "off", message: stuck === "" ? null : stuck.trim() };
    if (this.failure !== null) {
      return {
        state: "failed",
        message: `A notification could not be sent (${this.failure}), so Herald gives bb its notifications back.${stuck} Turn the setting off and on to try again.`,
      };
    }
    const unavailable = await this.unavailable();
    if (unavailable !== null) return { state: "unavailable", message: `${unavailable} bb sends its own notifications.${stuck}` };
    return { state: "on", message: null };
  }

  /**
   * Brings the thread's level in line with its choice and the switch, and
   * says whether Herald must send `event` itself (null on a turn start, which
   * only brings the level in line). Never rejects: when bb cannot be read,
   * Herald sends if it holds a mute on the thread or on a thread above it.
   */
  decide(threadId: string, choiceOf: () => Promise<ThreadChoice>, event: PushEvent | null, takeOver = true): Promise<boolean> {
    return this.enqueue(async () => {
      const known: { ancestorIds: string[] | null } = { ancestorIds: null };
      try {
        // Off, with no record of Herald's anywhere: nothing to read bb for,
        // which keeps the switch free for everyone who leaves it off.
        if (!(await this.deps.enabled()) && (await this.deps.kv.list(PUSH_RECORD_PREFIX)).length === 0) return false;
        const state = await this.read(threadId, known);
        if (state === null) return false;
        // An event a newer one replaced only settles what it is owed: it takes no level.
        if (takeOver && this.ready && !this.closed) await this.sync(state, choiceOf);
        return event !== null && this.owes(state, event);
      } catch (error) {
        this.deps.log.warn(`Could not read or change bb's notification level for ${threadId}: ${reasonOf(error)}`);
        return event !== null && (await this.mayHold(threadId, known.ancestorIds));
      }
    });
  }

  /**
   * Sends one notification, unless it is no longer news the way bb judges it:
   * the thread is gone, the user has read it since, the turn is no longer
   * finished or failed, or the question was answered. A send that fails is
   * tried again later. Never rejects.
   */
  send(subject: PushSubject, sentence: string): Promise<void> {
    return this.track(this.attempt({ id: null, subject, sentence, attempts: 0, dueAt: this.now() }));
  }

  /** Every level Herald holds goes back, each once its thread is quiet. */
  giveBackAll(): Promise<void> {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      for (const threadId of await this.heldIds()) this.scheduleGiveBack(threadId, "all", epoch);
    }).catch((error: unknown) => {
      this.deps.log.error(`Could not list the threads whose notifications Herald took over: ${reasonOf(error)}`);
    });
  }

  /** The thread was unarchived: it may be taken over again. */
  unarchived(threadId: string): void {
    this.forgotten.delete(threadId);
  }

  /** The thread was archived (its level goes back, for an unarchive) or deleted (nothing is left to give back). */
  forget(threadId: string, giveBack: boolean): Promise<void> {
    this.forgotten.add(threadId);
    if (giveBack) {
      this.scheduleGiveBack(threadId, "thread");
      return Promise.resolve();
    }
    return this.enqueue(() => this.deps.kv.delete(this.key(threadId))).catch((error: unknown) => {
      this.deps.log.warn(`Could not forget ${threadId}'s notification level: ${reasonOf(error)}`);
    });
  }

  /**
   * Herald unloads: no level is taken from now on; what is queued finishes;
   * then, after a short wait for quiet, every level goes back at once. Sends
   * under way finish; what waits to be tried again stays in storage for the
   * next instance.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.epoch += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.queue;
    await this.enqueue(async () => {
      const held = await this.heldIds();
      if (held.length === 0) return;
      const latest = Math.max(0, ...this.lastEventAt.values());
      const wait = Math.min(CLOSE_QUIET_MAX_MS, latest + RELEASE_QUIET_MS - this.now());
      if (wait > 0) await sleep(wait);
      for (const threadId of held) await this.giveBack(threadId, false);
    }).catch((error: unknown) => this.deps.log.error(`Could not give bb its notification levels back: ${reasonOf(error)}`));
    await Promise.all([...this.sending]);
  }

  private key(threadId: string): string {
    return `${PUSH_RECORD_PREFIX}${threadId}`;
  }

  private async record(threadId: string): Promise<PushRecord | null> {
    return recordOf(await this.deps.kv.get<unknown>(this.key(threadId)));
  }

  /** The threads whose mute Herald holds now. */
  private async heldIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const key of await this.deps.kv.list(PUSH_RECORD_PREFIX)) {
      const record = recordOf(await this.deps.kv.get<unknown>(key));
      if (record !== null && record.releasedAt === undefined) ids.push(key.slice(PUSH_RECORD_PREFIX.length));
    }
    return ids;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private setTimer(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    this.timers.add(timer);
  }

  /** Whether bb can send right now, asked at most once a minute; null when it can. */
  private async unavailable(): Promise<string | null> {
    const cached = this.availability;
    if (cached !== null && this.now() - cached.at < AVAILABILITY_TTL_MS) return cached.reason;
    let reason: string | null;
    try {
      reason = await this.deps.port.unavailable();
    } catch (error) {
      reason = `bb could not say whether it can send notifications (${reasonOf(error)}).`;
    }
    this.availability = { at: this.now(), reason };
    if (reason !== null && reason !== this.loggedUnavailable) {
      this.deps.log.warn(`Herald's push notifications are not available: ${reason}`);
    }
    this.loggedUnavailable = reason;
    return reason;
  }

  /** Whether Herald should hold mutes at all now: loaded, switched on, no failure, and bb able to send. */
  private async holding(): Promise<boolean> {
    if (!this.ready || this.closed || this.failure !== null) return false;
    if (!(await this.deps.enabled())) return false;
    return (await this.unavailable()) === null;
  }

  /** When bb cannot be read: whether a mute of Herald's might hold this event back. */
  private async mayHold(threadId: string, ancestorIds: string[] | null): Promise<boolean> {
    try {
      if (ancestorIds === null) return (await this.deps.kv.list(PUSH_RECORD_PREFIX)).length > 0;
      for (const id of [threadId, ...ancestorIds]) if ((await this.record(id)) !== null) return true;
      return false;
    } catch {
      return true;
    }
  }

  private async read(threadId: string, known: { ancestorIds: string[] | null }): Promise<LevelState | null> {
    const ancestorIds = await this.deps.port.ancestors(threadId);
    if (ancestorIds === null) return null;
    known.ancestorIds = ancestorIds;
    const ids = [threadId, ...ancestorIds];
    const [own, defaults, rows] = await Promise.all([
      this.deps.port.ownLevels(ids),
      this.deps.port.defaults(),
      Promise.all(ids.map((id) => this.record(id))),
    ]);
    const records = new Map<string, PushRecord>();
    const at = this.now();
    for (const [index, id] of ids.entries()) {
      const record = rows[index] ?? null;
      if (record === null) continue;
      if (record.releasedAt !== undefined) {
        if (at - record.releasedAt > RELEASE_LOG_MS) await this.deps.kv.delete(this.key(id));
        else records.set(id, record);
        continue;
      }
      if (own.get(id) === "muted") {
        records.set(id, record);
        continue;
      }
      // Held, but bb says the level is not muted: someone changed it, a mute
      // whose call failed never landed, or a give-back whose call failed did.
      // Either way it is not Herald's any more; logged as given back now.
      this.deps.log.info(`bb's notification level for ${id} is no longer the mute Herald set; Herald leaves it as it is.`);
      const released: PushRecord = { ...record, releasedAt: at };
      await this.deps.kv.set(this.key(id), released);
      this.retries.delete(id);
      records.set(id, released);
    }
    return { threadId, ancestorIds, own, records, defaults };
  }

  /**
   * Whether bb's read of the level for this event may have held it back,
   * where it would not have without Herald. bb's read comes at an unknown
   * time after the event, so a record's mute counts if it was in force at any
   * moment after the event: held now, however late it was set, or given back
   * after it. A given-back record that a re-take replaced is held, so counts
   * too.
   */
  private owes(state: LevelState, event: PushEvent): boolean {
    const atFlush = (id: string): OwnLevel => (this.inForce(state, id, event.at) !== undefined ? "muted" : (state.own.get(id) ?? "inherit"));
    const read = resolveLevel(state.threadId, state.ancestorIds, atFlush, state.defaults);
    const wouldHave = resolveLevel(state.threadId, state.ancestorIds, this.withoutHerald(state, event.at), state.defaults);
    return !levelAllows(read, event.reason) && levelAllows(wouldHave, event.reason);
  }

  /**
   * The thread's record if its mute was in force at some moment after `at`:
   * held, or given back after it. A record given back before `at` says
   * nothing about the event: the thread's level since is whatever bb reports
   * now — its own, or another writer's — not what Herald once replaced.
   */
  private inForce(state: LevelState, id: string, at: number): PushRecord | undefined {
    const record = state.records.get(id);
    return record !== undefined && (record.releasedAt === undefined || record.releasedAt > at) ? record : undefined;
  }

  /** Each thread's own level, with every mute of Herald's in force after `at` replaced by the level it replaced. */
  private withoutHerald(state: LevelState, at: number): (id: string) => OwnLevel {
    return (id) => this.inForce(state, id, at)?.previous ?? state.own.get(id) ?? "inherit";
  }

  /** Takes the thread over, or asks for its level back, as its choice and the switch say. */
  private async sync(state: LevelState, choiceOf: () => Promise<ThreadChoice>): Promise<void> {
    const { threadId } = state;
    const record = state.records.get(threadId);
    const held = record !== undefined && record.releasedAt === undefined;
    const epoch = this.epoch;
    const wanted = (await this.holding()) && (await choiceOf()) !== "silent";
    if (held && !wanted) {
      this.scheduleGiveBack(threadId, "thread");
      return;
    }
    if (held) {
      // Wanted again (Silent, then Announce): a give-back still waiting for quiet is dropped.
      this.giveBackTokens.delete(threadId);
      this.retries.delete(threadId);
      return;
    }
    if (!wanted || this.forgotten.has(threadId)) return;
    const own = state.own.get(threadId) ?? "inherit";
    // Muted already, by its own level or an ancestor's Herald did not set:
    // there is nothing bb would say for Herald to say instead.
    if (own === "muted") return;
    if (resolveLevel(threadId, state.ancestorIds, this.withoutHerald(state, this.now()), state.defaults) === "muted") return;
    // Checked again after the awaits above: a switch, a failure or an unload meanwhile wins.
    if (this.epoch !== epoch || this.closed) return;
    // The record first: a mute that lands with no record would never be given back.
    const claimed: PushRecord = { previous: own, mutedAt: this.now() };
    await this.deps.kv.set(this.key(threadId), claimed);
    state.records.set(threadId, claimed);
    state.own.set(threadId, "muted");
    try {
      await this.deps.port.setOwnLevel(threadId, "muted");
    } catch (error) {
      // bb may have saved the mute before failing; the record stays, and the next read settles it.
      this.deps.log.warn(`Muting bb's notifications for ${threadId} may not have landed; Herald checks again: ${reasonOf(error)}`);
    }
  }

  /**
   * Asks for a thread's level back, once it and the threads below it are
   * quiet. `epoch` is when it was asked for: a give-back of everything is
   * dropped if the switch went on again since. Each request replaces the
   * thread's earlier one, and a decision that wants the mute again drops it.
   */
  private scheduleGiveBack(threadId: string, why: GiveBack, epoch = this.epoch, token = this.nextToken(threadId)): void {
    if (this.closed) return;
    void this.enqueue(async () => {
      if (this.closed || this.giveBackTokens.get(threadId) !== token) return;
      // Undone: the switch went on again since everything was to go back.
      if (why === "all" && this.epoch !== epoch && (await this.holding())) return;
      const outcome = await this.giveBack(threadId, true);
      if (outcome === "later") {
        const wait = Math.max(1, (await this.lastEventBelow(threadId)) + RELEASE_QUIET_MS - this.now());
        this.setTimer(wait, () => this.scheduleGiveBack(threadId, why, epoch, token));
      } else if (outcome === "failed") {
        this.retryLater(threadId, why);
      } else if (this.giveBackTokens.get(threadId) === token) {
        this.giveBackTokens.delete(threadId);
      }
    }).catch((error: unknown) => {
      this.deps.log.error(`Could not give ${threadId}'s notification level back to bb: ${reasonOf(error)}`);
      this.retryLater(threadId, why);
    });
  }

  private nextToken(threadId: string): number {
    this.tokenCounter += 1;
    this.giveBackTokens.set(threadId, this.tokenCounter);
    return this.tokenCounter;
  }

  /** The latest event of the thread or any thread below it; every thread's when bb cannot say which are below. */
  private async lastEventBelow(threadId: string): Promise<number> {
    let ids: string[];
    try {
      ids = [threadId, ...(await this.deps.port.descendants(threadId))];
    } catch {
      return Math.max(0, ...this.lastEventAt.values());
    }
    return Math.max(0, ...ids.map((id) => this.lastEventAt.get(id) ?? 0));
  }

  /**
   * Puts one thread's level back, if it is still Herald's mute, and logs the
   * give-back. With `quiet`, only once the thread and those below it have
   * been quiet — checked before the read and again just before the write,
   * since an event can arrive while bb answers. "failed" when bb could not be
   * reached or did not answer: the record stays held — the give-back may not
   * have landed — and the next read or retry settles it.
   */
  private async giveBack(threadId: string, quiet: boolean): Promise<"done" | "later" | "failed"> {
    const record = await this.record(threadId);
    if (record === null || record.releasedAt !== undefined) return "done";
    const isQuiet = async () => !quiet || this.now() >= (await this.lastEventBelow(threadId)) + RELEASE_QUIET_MS;
    try {
      if (!(await isQuiet())) return "later";
      const own = (await this.deps.port.ownLevels([threadId])).get(threadId) ?? "inherit";
      if (own === "muted") {
        if (!(await isQuiet())) return "later";
        await this.deps.port.setOwnLevel(threadId, record.previous);
      }
    } catch (error) {
      if (isThreadNotFound(error)) {
        await this.deps.kv.delete(this.key(threadId));
        return "done";
      }
      this.deps.log.warn(`Could not give ${threadId}'s notification level back to bb yet: ${reasonOf(error)}`);
      return "failed";
    }
    await this.deps.kv.set(this.key(threadId), { ...record, releasedAt: this.now() } satisfies PushRecord);
    this.retries.delete(threadId);
    return "done";
  }

  private retryLater(threadId: string, why: GiveBack): void {
    if (this.closed) return;
    this.retries.set(threadId, why);
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const due = [...this.retries];
      this.retries.clear();
      // A retry is asked for afresh: still wanted unless the switch is back on, which `holding` reads.
      for (const [id, reason] of due) this.scheduleGiveBack(id, reason, reason === "all" ? -1 : this.epoch);
    }, RETRY_MS);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private track(work: Promise<void>): Promise<void> {
    this.sending.add(work);
    void work.finally(() => this.sending.delete(work));
    return work;
  }

  private async attempt(item: Outgoing): Promise<void> {
    if (item.id !== null) this.attempting.add(item.id);
    try {
      await this.attemptOnce(item);
    } finally {
      if (item.id !== null) this.attempting.delete(item.id);
    }
  }

  private async attemptOnce(item: Outgoing): Promise<void> {
    const { subject, sentence } = item;
    let news: boolean;
    try {
      news = await this.stillNews(subject);
    } catch (error) {
      // A notification that may be stale beats none: bb held it back.
      this.deps.log.warn(`Could not check whether ${subject.threadId} still needs you; notifying anyway: ${reasonOf(error)}`);
      news = true;
    }
    try {
      if (news) {
        await this.deps.port.send({ title: pushTitle(subject.threadTitle, subject.projectName), body: pushBody(sentence), threadId: subject.threadId });
      }
    } catch (error) {
      if (!isThreadNotFound(error)) {
        await this.retrySend(item, reasonOf(error));
        return;
      }
    }
    if (item.id !== null) await this.deps.kv.delete(`${OUTBOX_PREFIX}${item.id}`).catch(() => {});
  }

  /** Stores a failed send to be tried again — by this instance, or the next after a reload — or gives it up. */
  private async retrySend(item: Outgoing, reason: string): Promise<void> {
    this.failed(reason);
    const delay = SEND_RETRY_MS[item.attempts];
    const id = item.id ?? randomUUID();
    if (delay === undefined) {
      this.deps.log.error(`Gave up on the notification for ${item.subject.threadId}: ${reason}`);
      await this.deps.kv.delete(`${OUTBOX_PREFIX}${id}`).catch(() => {});
      return;
    }
    const next: Outgoing = { ...item, id, attempts: item.attempts + 1, dueAt: this.now() + delay };
    try {
      await this.deps.kv.set(`${OUTBOX_PREFIX}${id}`, { subject: next.subject, sentence: next.sentence, attempts: next.attempts, dueAt: next.dueAt });
    } catch (error) {
      this.deps.log.warn(`Could not keep the notification for ${item.subject.threadId} across a reload: ${reasonOf(error)}`);
    }
    this.scheduleSend(next);
  }

  private scheduleSend(item: Outgoing): void {
    if (this.closed || item.id === null) return;
    const id = item.id;
    this.scheduledSends.add(id);
    this.setTimer(Math.max(0, item.dueAt - this.now()), () => {
      this.scheduledSends.delete(id);
      if (!this.closed) void this.track(this.attempt(item));
    });
  }

  /** Takes up the sends an earlier instance stored, or that this one stored before a failed read. */
  private async resumeOutbox(): Promise<void> {
    try {
      for (const key of await this.deps.kv.list(OUTBOX_PREFIX)) {
        const id = key.slice(OUTBOX_PREFIX.length);
        if (this.scheduledSends.has(id) || this.attempting.has(id)) continue;
        const item = outgoingOf(id, await this.deps.kv.get<unknown>(key));
        if (item === null) await this.deps.kv.delete(key);
        else this.scheduleSend(item);
      }
    } catch (error) {
      this.deps.log.error(`Could not read the notifications waiting to be sent again: ${reasonOf(error)}`);
    }
  }

  /** A send failed: no new takeover, and every level goes back. What is owed is still sent. */
  private failed(reason: string): void {
    if (this.failure !== null) return;
    this.failure = reason;
    this.epoch += 1;
    this.deps.log.error(`A Herald notification could not be sent, so bb's own notifications are switched back on: ${reason}`);
    void this.giveBackAll();
  }

  private async stillNews(subject: PushSubject): Promise<boolean> {
    const facts = await this.deps.facts(subject.threadId);
    if (facts.kind === "gone") return false;
    const at = Date.parse(subject.createdAt);
    const read = facts.lastReadAt ?? 0;
    if (read >= facts.latestAttentionAt && read >= at) return false;
    switch (subject.reason) {
      case "finished":
        return facts.status === "idle";
      case "error":
        return facts.status === "error";
      default:
        return subject.requestId === null || (await this.deps.interactionPending(subject.threadId, subject.requestId));
    }
  }
}
