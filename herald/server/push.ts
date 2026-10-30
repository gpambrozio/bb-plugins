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
 * - **Decided for bb's flush, not for now.** bb reads the level about two
 *   seconds after an event (it coalesces). Herald sends an event when the
 *   level bb read then forbade it and the level without Herald's mutes —
 *   this thread's and its ancestors' — allows it. A mute set too late for an
 *   event leaves that event to bb.
 * - **A give-back waits for quiet.** A level goes back only once the thread
 *   and every thread below it have had no event for `RELEASE_QUIET_MS`, so
 *   every flush bb still has pending reads the mute and Herald is the only
 *   sender. A give-back that fails is retried every `RETRY_MS`.
 * - **What is owed is sent.** A send that fails is tried again while it is
 *   still news; the failure stops new takeovers and gives the levels back,
 *   but never drops what bb has already discarded.
 * - **Muted is all bb tells.** bb's levels carry no owner, so a mute someone
 *   else sets on a thread Herald holds is indistinguishable from Herald's,
 *   and is given back with it. README and AGENTS.md say so.
 */
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

/** How long bb's answer to "can Herald send?" is trusted. */
export const AVAILABILITY_TTL_MS = 60_000;

/**
 * bb's flush for an event reads the level at most this long after it: its
 * two-second coalescing window, and its own reads. A mute asked for later
 * came too late for the event; one asked for sooner may have been read.
 */
export const FLUSH_LEAD_MS = 2_500;

/** A level is given back only once its thread and the threads below it have been quiet this long. */
export const RELEASE_QUIET_MS = 3_000;

/** How long a given-back record is kept, for events decided after the give-back. */
export const RELEASE_LOG_MS = 60_000;

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
  subject: PushSubject;
  sentence: string;
  attempts: number;
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
  /** Notifications whose send failed and that wait to be tried again. */
  private readonly outbox = new Set<Outgoing>();

  constructor(private readonly deps: PushDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Levels may change from now on: the instance before this one, if any, has given its threads back. */
  setReady(): void {
    this.ready = true;
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
  decide(threadId: string, choiceOf: () => Promise<ThreadChoice>, event: PushEvent | null): Promise<boolean> {
    return this.enqueue(async () => {
      const known: { ancestorIds: string[] | null } = { ancestorIds: null };
      try {
        // Off, with no record of Herald's anywhere: nothing to read bb for,
        // which keeps the switch free for everyone who leaves it off.
        if (!(await this.deps.enabled()) && (await this.deps.kv.list(PUSH_RECORD_PREFIX)).length === 0) return false;
        const state = await this.read(threadId, known);
        if (state === null) return false;
        if (this.ready && !this.closed) await this.sync(state, choiceOf);
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
    return this.attempt({ subject, sentence, attempts: 0 });
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

  /** The thread was archived (its level goes back, for an unarchive) or deleted (nothing is left to give back). */
  forget(threadId: string, giveBack: boolean): Promise<void> {
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
   * then, after a short wait for quiet, every level goes back at once, and
   * notifications waiting to be tried again get one last try.
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
      for (const threadId of held) await this.giveBack(threadId);
    }).catch((error: unknown) => this.deps.log.error(`Could not give bb its notification levels back: ${reasonOf(error)}`));
    const left = [...this.outbox];
    this.outbox.clear();
    await Promise.all(left.map((item) => this.attempt({ ...item, attempts: SEND_RETRY_MS.length })));
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
   * Whether bb's flush for this event read a level that held it back, and
   * would not have without Herald. A record's mute counts if it was asked for
   * in time for that flush and not given back before the event.
   */
  private owes(state: LevelState, event: PushEvent): boolean {
    const atFlush = (id: string): OwnLevel => {
      const record = state.records.get(id);
      if (record === undefined) return state.own.get(id) ?? "inherit";
      const inForce = record.mutedAt <= event.at + FLUSH_LEAD_MS && (record.releasedAt === undefined || record.releasedAt > event.at);
      return inForce ? "muted" : record.previous;
    };
    const read = resolveLevel(state.threadId, state.ancestorIds, atFlush, state.defaults);
    const wouldHave = resolveLevel(state.threadId, state.ancestorIds, this.withoutHerald(state), state.defaults);
    return !levelAllows(read, event.reason) && levelAllows(wouldHave, event.reason);
  }

  /** Each thread's own level, with every record of Herald's replaced by the level it replaced. */
  private withoutHerald(state: LevelState): (id: string) => OwnLevel {
    return (id) => state.records.get(id)?.previous ?? state.own.get(id) ?? "inherit";
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
    if (held || !wanted) return;
    const own = state.own.get(threadId) ?? "inherit";
    // Muted already, by its own level or an ancestor's Herald did not set:
    // there is nothing bb would say for Herald to say instead.
    if (own === "muted") return;
    if (resolveLevel(threadId, state.ancestorIds, this.withoutHerald(state), state.defaults) === "muted") return;
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
   * dropped if the switch went on again since.
   */
  private scheduleGiveBack(threadId: string, why: GiveBack, epoch = this.epoch): void {
    if (this.closed) return;
    void this.enqueue(async () => {
      if (this.closed) return;
      // Undone: the switch went on again since everything was to go back.
      if (why === "all" && this.epoch !== epoch && (await this.holding())) return;
      const record = await this.record(threadId);
      if (record === null || record.releasedAt !== undefined) return;
      const quietAt = (await this.lastEventBelow(threadId)) + RELEASE_QUIET_MS;
      if (this.now() < quietAt) {
        this.setTimer(quietAt - this.now(), () => this.scheduleGiveBack(threadId, why, epoch));
        return;
      }
      if (!(await this.giveBack(threadId))) this.retryLater(threadId, why);
    }).catch((error: unknown) => {
      this.deps.log.error(`Could not give ${threadId}'s notification level back to bb: ${reasonOf(error)}`);
      this.retryLater(threadId, why);
    });
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
   * give-back. False when bb could not be reached or did not answer: the
   * record stays held — the give-back may not have landed — and the next
   * read or retry settles it.
   */
  private async giveBack(threadId: string): Promise<boolean> {
    const record = await this.record(threadId);
    if (record === null || record.releasedAt !== undefined) return true;
    try {
      const own = (await this.deps.port.ownLevels([threadId])).get(threadId) ?? "inherit";
      if (own === "muted") await this.deps.port.setOwnLevel(threadId, record.previous);
    } catch (error) {
      if (isThreadNotFound(error)) {
        await this.deps.kv.delete(this.key(threadId));
        return true;
      }
      this.deps.log.warn(`Could not give ${threadId}'s notification level back to bb yet: ${reasonOf(error)}`);
      return false;
    }
    await this.deps.kv.set(this.key(threadId), { ...record, releasedAt: this.now() } satisfies PushRecord);
    this.retries.delete(threadId);
    return true;
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

  private async attempt(item: Outgoing): Promise<void> {
    const { subject, sentence } = item;
    let news: boolean;
    try {
      news = await this.stillNews(subject);
    } catch (error) {
      // A notification that may be stale beats none: bb held it back.
      this.deps.log.warn(`Could not check whether ${subject.threadId} still needs you; notifying anyway: ${reasonOf(error)}`);
      news = true;
    }
    if (!news) return;
    try {
      await this.deps.port.send({ title: pushTitle(subject.threadTitle, subject.projectName), body: pushBody(sentence), threadId: subject.threadId });
    } catch (error) {
      if (isThreadNotFound(error)) return;
      this.failed(reasonOf(error));
      const delay = SEND_RETRY_MS[item.attempts];
      if (delay === undefined || this.closed) {
        this.deps.log.error(`Gave up on the notification for ${subject.threadId}: ${reasonOf(error)}`);
        return;
      }
      const next: Outgoing = { ...item, attempts: item.attempts + 1 };
      this.outbox.add(next);
      this.setTimer(delay, () => {
        if (this.outbox.delete(next)) void this.attempt(next);
      });
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
