/**
 * *Send Herald's sentences as push notifications*: for a thread Herald
 * announces, bb's own notification level is set to muted, and Herald sends
 * what that mute took away — the same events at the same level bb would have
 * notified at, each with Herald's sentence. The rules:
 *
 * - **Lazily, thread by thread.** A thread is taken over when Herald first
 *   handles it with the switch on (a turn starting, or an event), and given
 *   back when its choice becomes Silent, the switch goes off, the thread is
 *   archived, Herald unloads (bb gives no separate hook for a disable or a
 *   removal), or a send fails. No sweep over every thread.
 * - **Only a level Herald can give back.** The thread's own level before the
 *   mute is kept in kv (`push:<threadId>`), and restored only while the level
 *   is still the mute Herald set. A level someone else changed meanwhile —
 *   the user in bb's menu, or another plugin — is theirs: the record is
 *   dropped and the level left alone. A thread already muted by its own level
 *   or by an ancestor's that Herald did not set is never taken over.
 * - **Herald sends exactly what its mutes suppress.** For each event it works
 *   out the level bb resolves now, and the level bb would resolve with every
 *   one of Herald's mutes replaced by the level it remembered, a thread's
 *   ancestors included (a level caps its descendants). It sends when the
 *   first forbids the event and the second allows it. So nothing bb would
 *   have said goes missing — a Questions-only thread's failed turn, a worker's
 *   question under a coordinator Herald muted — and nothing is said twice.
 * - **Never no notification.** No takeover unless `notifications.send` is
 *   there; a failed send puts every level back and stops until the switch is
 *   turned off and on again, or Herald reloads.
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

/** How many levels are put back at once when every thread is given back. */
const RESTORE_CONCURRENCY = 8;

interface PushRecord {
  /** The thread's own level before Herald muted it. */
  previous: OwnLevel;
}

/** What one event's decision reads: the thread, its ancestors and their levels, and Herald's records. */
interface LevelState {
  threadId: string;
  ancestorIds: string[];
  own: Map<string, OwnLevel>;
  records: Map<string, PushRecord>;
  defaults: LevelDefaults;
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
  const previous = OwnLevelSchema.safeParse((raw as Record<string, unknown>).previous);
  return previous.success ? { previous: previous.data } : null;
}

export class PushTakeover {
  private readonly now: () => number;
  /** False until an earlier instance has given its threads back; until then, no level is changed. */
  private ready = false;
  /** Why sending stopped, once a send failed; cleared when the switch is turned on again. */
  private failure: string | null = null;
  private availability: { at: number; reason: string | null } | null = null;
  /** One decision at a time per thread, so two events cannot both take it over. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private loggedUnavailable: string | null = null;

  constructor(private readonly deps: PushDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Levels may change from now on: the instance before this one, if any, has given its threads back. */
  setReady(): void {
    this.ready = true;
  }

  /** The switch was turned on: a failure before it is forgotten, and bb is asked afresh. */
  switchedOn(): void {
    this.failure = null;
    this.availability = null;
    this.loggedUnavailable = null;
  }

  async status(): Promise<PushStatus> {
    if (!(await this.deps.enabled())) return { state: "off", message: null };
    if (this.failure !== null) {
      return {
        state: "failed",
        message: `A notification could not be sent (${this.failure}), so bb sends its own again. Turn the setting off and on to try again.`,
      };
    }
    const unavailable = await this.unavailable();
    if (unavailable !== null) return { state: "unavailable", message: `${unavailable} bb sends its own notifications.` };
    return { state: "on", message: null };
  }

  /**
   * Brings the thread's level in line with its choice and the switch, and
   * says whether Herald must send this event itself (`reason`; null on a
   * turn start, which only brings the level in line). Never rejects: when bb
   * cannot say, Herald sends if it holds a mute on the thread, since a
   * second notification is better than none.
   */
  decide(threadId: string, choiceOf: () => Promise<ThreadChoice>, reason: AttentionReason | null): Promise<boolean> {
    return this.serial(threadId, async () => {
      let before = false;
      try {
        // Off, with no mute of Herald's left on the thread: nothing to read
        // bb for, which keeps the switch free for everyone who leaves it off.
        if (!(await this.deps.enabled()) && (await this.record(threadId)) === null) return false;
        const state = await this.read(threadId);
        if (state === null) return false;
        before = reason !== null && this.owes(state, reason);
        const changed = await this.sync(state, await choiceOf());
        // Changed now, bb may or may not have read the level for this event
        // yet; either state that drops it means Herald sends.
        return before || (reason !== null && changed && this.owes(state, reason));
      } catch (error) {
        this.deps.log.warn(`Could not read or change bb's notification level for ${threadId}: ${reasonOf(error)}`);
        return before || (reason !== null && (await this.record(threadId).catch(() => null)) !== null);
      }
    });
  }

  /**
   * Sends one notification, unless it is no longer news the way bb judges it:
   * the thread is gone, the user has read it since, the turn is no longer
   * finished or failed, or the question was answered. Never rejects.
   */
  async send(subject: PushSubject, sentence: string): Promise<void> {
    let news: boolean;
    try {
      news = await this.stillNews(subject);
    } catch (error) {
      // A notification that may be stale beats none: bb stays muted for it.
      this.deps.log.warn(`Could not check whether ${subject.threadId} still needs you; notifying anyway: ${reasonOf(error)}`);
      news = true;
    }
    if (!news || this.failure !== null) return;
    try {
      await this.deps.port.send({
        title: pushTitle(subject.threadTitle, subject.projectName),
        body: pushBody(sentence),
        threadId: subject.threadId,
      });
    } catch (error) {
      if (isThreadNotFound(error)) return;
      await this.fail(reasonOf(error));
    }
  }

  /** Every thread Herald muted gets its level back: the switch went off, a send failed, or Herald unloads. */
  async restoreAll(): Promise<void> {
    let keys: string[];
    try {
      keys = await this.deps.kv.list(PUSH_RECORD_PREFIX);
    } catch (error) {
      this.deps.log.error(`Could not list the threads whose notifications Herald took over: ${reasonOf(error)}`);
      return;
    }
    const threadIds = keys.map((key) => key.slice(PUSH_RECORD_PREFIX.length));
    for (let start = 0; start < threadIds.length; start += RESTORE_CONCURRENCY) {
      await Promise.all(threadIds.slice(start, start + RESTORE_CONCURRENCY).map((threadId) => this.restore(threadId)));
    }
  }

  /** The thread was archived (its level goes back, for an unarchive) or deleted (nothing left to restore). */
  forget(threadId: string, restore: boolean): Promise<void> {
    if (restore) return this.restore(threadId);
    return this.serial(threadId, () => this.deps.kv.delete(this.key(threadId))).catch((error: unknown) => {
      this.deps.log.warn(`Could not forget ${threadId}'s notification level: ${reasonOf(error)}`);
    });
  }

  private key(threadId: string): string {
    return `${PUSH_RECORD_PREFIX}${threadId}`;
  }

  private async record(threadId: string): Promise<PushRecord | null> {
    return recordOf(await this.deps.kv.get<unknown>(this.key(threadId)));
  }

  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => {});
    this.chains.set(threadId, settled);
    void settled.then(() => {
      if (this.chains.get(threadId) === settled) this.chains.delete(threadId);
    });
    return next;
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

  /** Whether Herald should hold a mute on a thread with this choice, now. */
  private async wanted(choice: ThreadChoice): Promise<boolean> {
    if (choice === "silent" || this.failure !== null) return false;
    if (!(await this.deps.enabled())) return false;
    return (await this.unavailable()) === null;
  }

  private async read(threadId: string): Promise<LevelState | null> {
    const ancestorIds = await this.deps.port.ancestors(threadId);
    if (ancestorIds === null) return null;
    const ids = [threadId, ...ancestorIds];
    const [own, defaults, rows] = await Promise.all([
      this.deps.port.ownLevels(ids),
      this.deps.port.defaults(),
      Promise.all(ids.map((id) => this.record(id))),
    ]);
    const records = new Map<string, PushRecord>();
    for (const [index, id] of ids.entries()) {
      const record = rows[index] ?? null;
      if (record === null) continue;
      if (own.get(id) === "muted") {
        records.set(id, record);
        continue;
      }
      // Someone changed the level since Herald muted it: theirs now. Only
      // this thread's record is dropped here; an ancestor's is its own
      // decision's to drop, under its own lock.
      if (id === threadId) {
        this.deps.log.info(`bb's notification level for ${id} was changed outside Herald; Herald leaves it as it is.`);
        await this.deps.kv.delete(this.key(id));
      }
    }
    return { threadId, ancestorIds, own, records, defaults };
  }

  /** Each thread's own level, with Herald's mutes replaced by what they replaced. */
  private levels(state: LevelState, withoutHerald: boolean): (id: string) => OwnLevel {
    return (id) => {
      const record = withoutHerald ? state.records.get(id) : undefined;
      return record?.previous ?? state.own.get(id) ?? "inherit";
    };
  }

  private owes(state: LevelState, reason: AttentionReason): boolean {
    const now = resolveLevel(state.threadId, state.ancestorIds, this.levels(state, false), state.defaults);
    const without = resolveLevel(state.threadId, state.ancestorIds, this.levels(state, true), state.defaults);
    return !levelAllows(now, reason) && levelAllows(without, reason);
  }

  /** Takes the thread over or gives it back, as its choice and the switch say; true when the level changed. */
  private async sync(state: LevelState, choice: ThreadChoice): Promise<boolean> {
    if (!this.ready) return false;
    const { threadId } = state;
    const held = state.records.get(threadId);
    const wanted = await this.wanted(choice);
    if (held !== undefined && !wanted) {
      await this.deps.port.setOwnLevel(threadId, held.previous);
      await this.deps.kv.delete(this.key(threadId));
      state.records.delete(threadId);
      state.own.set(threadId, held.previous);
      return true;
    }
    if (held !== undefined || !wanted) return false;
    const own = state.own.get(threadId) ?? "inherit";
    // Muted already, by its own level or an ancestor's Herald did not set:
    // there is nothing bb would say for Herald to say instead.
    if (own === "muted") return false;
    if (resolveLevel(threadId, state.ancestorIds, this.levels(state, true), state.defaults) === "muted") return false;
    // The record first: a mute that lands with no record would never be given back.
    await this.deps.kv.set(this.key(threadId), { previous: own } satisfies PushRecord);
    try {
      await this.deps.port.setOwnLevel(threadId, "muted");
    } catch (error) {
      await this.deps.kv.delete(this.key(threadId));
      throw error;
    }
    state.records.set(threadId, { previous: own });
    state.own.set(threadId, "muted");
    return true;
  }

  /** Puts one thread's level back, if it is still Herald's mute; keeps the record when bb cannot be reached. */
  private restore(threadId: string): Promise<void> {
    return this.serial(threadId, async () => {
      try {
        const record = await this.record(threadId);
        if (record === null) return;
        const own = (await this.deps.port.ownLevels([threadId])).get(threadId) ?? "inherit";
        if (own === "muted") await this.deps.port.setOwnLevel(threadId, record.previous);
        await this.deps.kv.delete(this.key(threadId));
      } catch (error) {
        if (isThreadNotFound(error)) {
          await this.deps.kv.delete(this.key(threadId)).catch(() => {});
          return;
        }
        this.deps.log.error(`Could not give ${threadId}'s notification level back to bb: ${reasonOf(error)}`);
      }
    });
  }

  private async fail(reason: string): Promise<void> {
    if (this.failure !== null) return;
    this.failure = reason;
    this.deps.log.error(`A Herald notification could not be sent, so bb's own notifications are switched back on: ${reason}`);
    await this.restoreAll();
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
