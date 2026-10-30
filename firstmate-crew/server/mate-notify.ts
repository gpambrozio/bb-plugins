/**
 * FirstMate's own notifications for the first mate (the `mateNotifications` setting, off by default).
 *
 * While it is on, the first mate's own level in bb's push-notifications plugin is `input-only`, so bb
 * still notifies of its questions, approvals and errors but not of its finished turns. FirstMate sends
 * those itself, through the plugin's `notifications.send` (bb 0.48.1), and skips the charter's no-op
 * reply (`notification-text.ts`). Only the stored first mate is touched; crewmates keep their levels.
 *
 * The level the thread had before is kept in the store (`NotificationHold`) and put back when the setting
 * goes off, the first mate changes, or sending fails. It is put back only while the thread still has the
 * level FirstMate gave it: a level the captain chose since stays. Nothing is put back when the plugin
 * reloads or stops, so a reload does not flip the level twice.
 *
 * The captain is never left without notice of a finished turn: FirstMate takes the level only when the
 * push plugin offers `notifications.send`, and a send that fails puts the level back and stops FirstMate
 * sending until the setting is switched off and on, or the plugin reloads. Either is logged once and
 * shown on the board (`notice`).
 */
import type { Log } from "./log";
import { errorText } from "./log";
import { mateNotificationText } from "./notification-text";
import type { NotificationLevel, NotificationsPort, ThreadsPort } from "./ports";
import type { NotificationHold, Store } from "./store";

/** The first mate's level while FirstMate sends its turn notifications: questions, approvals and errors. */
export const MATE_LEVEL: NotificationLevel = "input-only";

/**
 * How long after a turn ends FirstMate looks at whether the captain has read it. bb's push plugin waits
 * the same before it notifies, so a captain watching the chat is not notified of what they just read.
 */
export const SEND_DELAY_MS = 2_000;

export interface MateNotifyDeps {
  notifications: NotificationsPort;
  threads: Pick<ThreadsPort, "get">;
  store: Pick<Store, "mateThreadId" | "notificationHold" | "setNotificationHold">;
  /** The setting, read afresh each time. */
  enabled: () => Promise<boolean>;
  log: Log;
  now: () => number;
  delayMs?: number;
}

const UNAVAILABLE =
  "FirstMate cannot send the first mate's notifications: this bb has no Push Notifications plugin that sends them (bb 0.48.1 or later, with the plugin on). bb's own notifications for the first mate are unchanged.";

function failedTaking(reason: string): string {
  return `FirstMate could not change the first mate's bb notification level (${reason}), so bb's own notifications for it are unchanged.`;
}

function failedSending(reason: string): string {
  return `FirstMate stopped sending the first mate's notifications after one failed (${reason}), and gave the first mate back its own bb notification level. Switch the setting off and on to try again.`;
}

export class MateNotifier {
  /** Why sending stopped after a failure; it stays stopped until `settingChanged` or a reload. */
  private failure: string | null = null;
  /** Why the setting is on but FirstMate is not sending, as the last sync found. */
  private unavailable: string | null = null;
  /** The last problem logged, so each is logged once. */
  private logged: string | null = null;
  /** Syncs and deliveries, one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Counts the turn ends that have something to send, so only the latest one's notification goes. */
  private latestTurn = 0;
  /** Ends the wait of the notification still waiting to go, which then does not. */
  private cancelWaiting: () => void = () => {};
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: MateNotifyDeps) {}

  /** What the board says when the setting is on and FirstMate is not sending, or null. */
  notice(): string | null {
    return this.failure ?? this.unavailable;
  }

  /**
   * Brings the first mate's level in step with the setting: taken from the stored first mate while the
   * setting is on and sending works, given back otherwise — and from a previous first mate when it changed.
   */
  sync(): Promise<void> {
    return this.serial(() => this.syncNow());
  }

  /** The captain changed the setting: a stop after a failure is lifted, and the level follows. */
  settingChanged(): Promise<void> {
    this.failure = null;
    this.logged = null;
    return this.sync();
  }

  /**
   * The first mate finished a turn with this closing text. Once the level is FirstMate's, one notification
   * goes out `SEND_DELAY_MS` later unless the reply is the no-op, has no words, or the captain has read it
   * by then. A later turn with something to send replaces one still waiting. Resolves once that is settled.
   */
  turnEnded(threadId: string, text: string | null): Promise<void> {
    const at = this.deps.now();
    return this.track(
      this.sync().then(async () => {
        const hold = await this.deps.store.notificationHold();
        if (hold?.threadId !== threadId || text === null) return;
        const message = await mateNotificationText(text, async (id) => (await this.deps.threads.get(id))?.title ?? null);
        if (message === null) return;
        // A skipped reply does not replace one still waiting; a reply that will be sent does.
        const turn = ++this.latestTurn;
        if (!(await this.waitToSend()) || turn !== this.latestTurn) return;
        await this.serial(() => this.deliver(threadId, message, at));
      }),
    );
  }

  /** Stops sending and waits for what is under way. The level is left as it is (see the module comment). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelWaiting();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async syncNow(): Promise<void> {
    if (this.stopped) return;
    const { store } = this.deps;
    const [hold, mateId] = await Promise.all([store.notificationHold(), store.mateThreadId()]);
    const wanted = mateId !== null && (await this.wanted());
    if (hold !== null && (!wanted || hold.threadId !== mateId)) {
      if (!(await this.giveBack(hold))) return;
    }
    if (wanted && mateId !== null && hold?.threadId !== mateId) await this.take(mateId);
  }

  /** Whether FirstMate should hold the first mate's level now: the setting on, and sending possible. */
  private async wanted(): Promise<boolean> {
    if (!(await this.deps.enabled())) {
      this.unavailable = null;
      return false;
    }
    if (this.failure !== null) return false;
    let canSend: boolean;
    try {
      canSend = await this.deps.notifications.canSend();
    } catch (error) {
      this.report(`${UNAVAILABLE} (${errorText(error)})`);
      return false;
    }
    if (!canSend) {
      this.report(UNAVAILABLE);
      return false;
    }
    this.unavailable = null;
    return true;
  }

  /** Records the thread's own level, then sets it to `MATE_LEVEL`. A failure gives back what it changed. */
  private async take(threadId: string): Promise<void> {
    const { notifications, store, threads } = this.deps;
    let hold: NotificationHold | null = null;
    try {
      if ((await threads.get(threadId)) === null) return;
      hold = { threadId, previous: await notifications.ownLevel(threadId) };
      // Recorded before the change, so a change whose answer is lost is still given back.
      await store.setNotificationHold(hold);
      await notifications.setOwnLevel(threadId, MATE_LEVEL);
      this.logged = null;
    } catch (error) {
      this.report(failedTaking(errorText(error)));
      if (hold !== null) await this.giveBack(hold);
    }
  }

  /**
   * Puts back the level the thread had, if it still has the one FirstMate gave it, and forgets the hold.
   * A thread bb no longer has is forgotten. Answers false when the level could not be put back: the hold
   * is kept for the next sync to try again.
   */
  private async giveBack(hold: NotificationHold): Promise<boolean> {
    const { notifications, store, threads } = this.deps;
    try {
      if ((await threads.get(hold.threadId)) !== null && (await notifications.ownLevel(hold.threadId)) === MATE_LEVEL) {
        await notifications.setOwnLevel(hold.threadId, hold.previous);
      }
      await store.setNotificationHold(null);
      return true;
    } catch (error) {
      this.warnOnce(`FirstMate could not give thread ${hold.threadId} back its bb notification level (${hold.previous}): ${errorText(error)}`);
      return false;
    }
  }

  /**
   * Sends one notification, if FirstMate still holds the thread's level, the captain has not set another
   * in bb meanwhile (bb would then notify too), and the captain has not read the turn. A failure stops
   * sending and gives the level back.
   */
  private async deliver(threadId: string, message: { title: string; body: string }, at: number): Promise<void> {
    if (this.stopped || this.failure !== null) return;
    const { notifications, store } = this.deps;
    try {
      const hold = await store.notificationHold();
      if (hold?.threadId !== threadId) return;
      if ((await notifications.ownLevel(threadId)) !== MATE_LEVEL) return;
      const attention = await notifications.attention(threadId);
      if (attention === null) return;
      const { lastReadAt, latestAttentionAt } = attention;
      if (lastReadAt !== null && lastReadAt >= latestAttentionAt && lastReadAt >= at) return;
      await notifications.send({ ...message, threadId });
    } catch (error) {
      this.failure = failedSending(errorText(error));
      this.warnOnce(this.failure);
      await this.syncNow();
    }
  }

  /** The setting is on and FirstMate is not sending: shown on the board, logged once. */
  private report(message: string): void {
    this.unavailable = message;
    this.warnOnce(message);
  }

  private warnOnce(message: string): void {
    if (message === this.logged) return;
    this.logged = message;
    this.deps.log.warn(message);
  }

  /** Waits `SEND_DELAY_MS`, cancelling the wait before it. False when cancelled or stopped meanwhile. */
  private waitToSend(): Promise<boolean> {
    this.cancelWaiting();
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!this.stopped), this.deps.delayMs ?? SEND_DELAY_MS);
      this.cancelWaiting = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Keeps `stop` waiting for the work, and logs a failure rather than leaving it to reject. */
  private track(work: Promise<void>): Promise<void> {
    const settled = work.catch((error: unknown) => this.deps.log.error(`FirstMate's notifications failed: ${errorText(error)}`));
    this.inFlight.add(settled);
    void settled.finally(() => this.inFlight.delete(settled));
    return settled;
  }
}
