/**
 * Where events become entries. Five things every handler here has to get right:
 *
 * 1. **Return fast.** bb's events are announcements: a handler cannot block
 *    anything, and it runs inside the bb server's own process. A summary is a
 *    full agent turn, so it is detached — the handler records a `pending`
 *    entry and returns; the summary lands later through the store.
 * 2. **Route our own helpers.** A hidden thread still fires these events. A
 *    thread this plugin spawned (bb stamps `originPluginId`) is a summary
 *    helper; its events go to `HelperOutcomes` and nowhere else.
 * 3. **Dedupe a turn's end.** A second `thread.idle` with no `thread.active`
 *    between them, inside the window, is the same turn reported twice.
 * 4. **Follow the thread, not the plugin.** An entry lives until the events
 *    show the thread moving on: a new turn, an archive, a delete. bb's unread
 *    state decides what the panel *lists*; see `server/liveness.ts`.
 * 5. **Leave hidden threads alone.** Another plugin's background worker is not
 *    something the user is waiting on; bb keeps it out of their attention too.
 */
import type { AttentionEntry, AttentionReason, SummarizerConfig } from "../shared/herald";
import type { HelperOutcomes } from "./helpers";
import type { EventsPort, Interaction, Log, ThreadDto } from "./ports";
import type { AttentionStore } from "./store";
import type { Summary, SummaryRequest, SummaryRun } from "./summarize";
import { describeInteraction, fallbackSpeech, firstWords, preview } from "./timeline";

/** What the handlers act on, read fresh for every event so a settings change applies at once. */
export interface HeraldConfig {
  announce: Record<AttentionReason, boolean>;
  /** Whether a thread another thread started is announced as well as its parent. */
  announceSubagents: boolean;
  /**
   * Whether a helper thread writes the sentence. Off, the plain fallback
   * sentence is announced: bb cannot keep a helper from using tools.
   */
  modelSummaries: boolean;
  deleteHelpers: boolean;
  timeoutMs: number;
  summarizer: SummarizerConfig;
}

export interface HookDeps {
  /** This plugin's id; a thread whose `originPluginId` is this one is a summary helper. */
  pluginId: string;
  store: AttentionStore;
  readConfig: () => Promise<HeraldConfig>;
  summarize: (request: SummaryRequest, config: HeraldConfig) => SummaryRun;
  events: EventsPort;
  outcomes: HelperOutcomes;
  /** Tells open clients the entries changed. */
  publish: () => void;
  log: Log;
  now?: () => Date;
  /** How many helpers may be alive at once; more threads than this wait their turn. */
  maxConcurrent?: number;
  /** How long `drain` waits; `DRAIN_TIMEOUT_MS` unless a test says otherwise. */
  drainTimeoutMs?: number;
}

/** A second `thread.idle` for the same turn inside this window is a repeat, not a new turn. */
export const TURN_REPEAT_WINDOW_MS = 15_000;

/** How long unload waits for running summaries to put their helpers away. */
export const DRAIN_TIMEOUT_MS = 15_000;

/**
 * A turn that fails this soon after the user interrupted it while it waited on
 * them failed because the user stopped it. It is not news to announce.
 */
export const INTERRUPT_GRACE_MS = 10_000;

/**
 * Whether an event gets a summary and a voice; otherwise it is only listed. A
 * thread another thread started reports to that thread — bb tells the parent
 * when it finishes, fails or is interrupted — so unless the user has asked for
 * subagents too, the parent's announcement is the one they hear.
 */
export function isAnnounced(thread: ThreadDto, reason: AttentionReason, config: HeraldConfig): boolean {
  if (thread.parentThreadId !== null && !config.announceSubagents) return false;
  return config.announce[reason];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Hooks {
  active(thread: ThreadDto): void;
  idle(thread: ThreadDto, lastAssistantText: string | null): Promise<void>;
  failed(thread: ThreadDto, error: string | null): Promise<void>;
  interactionPending(thread: ThreadDto, interaction: Interaction): Promise<void>;
  /** Archived or deleted: gone for good. */
  gone(thread: ThreadDto): void;
  /**
   * Stops taking events, drops the queue, and resolves once every running
   * summary has put its helper away — true — or `DRAIN_TIMEOUT_MS` has
   * passed with some still running — false.
   */
  drain(): Promise<boolean>;
}

export function createHooks(deps: HookDeps): Hooks {
  const now = deps.now ?? (() => new Date());
  const maxConcurrent = deps.maxConcurrent ?? 2;
  let running = 0;
  const queue: Array<() => void> = [];

  /**
   * Every recording handler awaits — the config, the thread's names — and the
   * thread can move on while it does. Whatever it learned is then about a turn
   * already replied to, and recording it would put a stale event back on the
   * panel. So each handler takes the thread's generation before its first
   * await and drops out if it moved.
   */
  const generations = new Map<string, number>();
  /** The last turn end seen per thread, with the generation it belonged to. */
  const recentIdles = new Map<string, { at: number; generation: number }>();
  /**
   * The newest recording started per thread. Two events can share a turn —
   * two questions, say — and so a generation; their lookups can finish in
   * either order, and the older one must not land on top of the newer.
   */
  const latestEvent = new Map<string, number>();
  let eventCounter = 0;

  /** Every scheduled summary task still running, for `drain`. */
  const inFlight = new Set<Promise<void>>();
  let disposed = false;

  /** Marks the start of a recording; `isLatest` later says whether a newer one began since. */
  function beginEvent(threadId: string): number {
    eventCounter += 1;
    latestEvent.set(threadId, eventCounter);
    return eventCounter;
  }

  function isLatest(threadId: string, event: number): boolean {
    return !disposed && latestEvent.get(threadId) === event;
  }

  function isHelper(thread: ThreadDto): boolean {
    return thread.originPluginId === deps.pluginId;
  }

  function generationOf(threadId: string): number {
    return generations.get(threadId) ?? 0;
  }

  /** The thread unmistakably moved on: a new turn, or gone for good. */
  function movedOn(threadId: string): void {
    generations.set(threadId, generationOf(threadId) + 1);
  }

  function isRepeatIdle(threadId: string): boolean {
    const at = now().getTime();
    for (const [id, seen] of recentIdles) {
      if (at - seen.at > TURN_REPEAT_WINDOW_MS) recentIdles.delete(id);
    }
    const generation = generationOf(threadId);
    const previous = recentIdles.get(threadId);
    if (previous !== undefined && previous.generation === generation) return true;
    recentIdles.set(threadId, { at, generation });
    return false;
  }

  function removeEntry(threadId: string): void {
    if (deps.store.remove(threadId) !== null) deps.publish();
  }

  /**
   * Whether the thread has carried on since the summary was commissioned, in
   * which case there is nothing to announce.
   *
   * The generation — a turn we saw start — applies to every event. Then one
   * question for bb, depending on the event:
   *
   * - a **finish**: is a turn in flight again? A provider can report a turn as
   *   finished and carry on, and writing a summary is exactly that window.
   * - an **interaction**: is it still pending? Answering one fires nothing a
   *   plugin hears, and the thread stays mid-turn, so the generation cannot
   *   tell. (Asking "is it running?" here would suppress every question —
   *   a thread waiting on one is running — which is the whole point.)
   */
  async function outran(threadId: string, generation: number, check: "running" | { interactionId: string } | null): Promise<boolean> {
    if (generationOf(threadId) !== generation) return true;
    if (check === null) return false;
    let movedOnInBb: boolean;
    try {
      movedOnInBb =
        check === "running"
          ? await deps.events.isRunning(threadId)
          : !(await deps.events.interactionPending(threadId, check.interactionId));
    } catch (error) {
      // A transport hiccup must not lose a summary.
      deps.log.warn(`Could not check whether thread ${threadId} has moved on: ${reasonOf(error)}`);
      movedOnInBb = false;
    }
    // A turn can start while that round trip is in flight, and the reading it
    // answers with may predate it.
    return generationOf(threadId) !== generation ? true : movedOnInBb;
  }

  /**
   * Runs `task` when a helper slot is free; the order threads finished in is
   * kept. The slot is held until the task is over — its helper put away — and
   * nothing queued starts after unload.
   */
  function schedule(task: () => Promise<void>): void {
    const start = () => {
      running += 1;
      // Detached work inside the bb server's process: a rejection must end
      // in the log, never as an unhandled rejection.
      const work = task()
        .catch((error: unknown) => deps.log.error(`A summary task failed: ${reasonOf(error)}`))
        .finally(() => {
          inFlight.delete(work);
          running -= 1;
          if (!disposed) queue.shift()?.();
        });
      inFlight.add(work);
    };
    if (running < maxConcurrent) start();
    else queue.push(start);
  }

  interface Recording {
    thread: ThreadDto;
    reason: AttentionReason;
    eventId: string;
    requestId: string | null;
    headline: string;
    detail: string | null;
    output: string;
    config: HeraldConfig;
    projectName: string | null;
    folder: string | null;
    lastUser: string | null;
  }

  function record(recording: Recording): void {
    const { thread, reason, eventId, config } = recording;
    const base: Omit<AttentionEntry, "summary"> = {
      threadId: thread.id,
      projectId: thread.projectId,
      projectName: recording.projectName,
      threadTitle: thread.title ?? thread.titleFallback,
      lastRequest: recording.lastUser === null ? null : preview(recording.lastUser),
      folder: recording.folder,
      reason,
      eventId,
      requestId: recording.requestId,
      createdAt: now().toISOString(),
      headline: recording.headline,
      detail: recording.detail,
    };
    const off = (): AttentionEntry => ({ ...base, summary: { status: "off", fallback: fallbackSpeech(base) } });
    if (!isAnnounced(thread, reason, config)) {
      // Switched off, or a subagent its parent speaks for: listed in the panel,
      // no summary, nothing spoken.
      deps.store.upsert(off());
      deps.publish();
      return;
    }
    if (!config.modelSummaries) {
      // No helper: the plain sentence is the announcement.
      deps.store.upsert({ ...base, summary: { status: "ready", text: fallbackSpeech(base), model: "plain" } });
      deps.publish();
      return;
    }
    deps.store.upsert({ ...base, summary: { status: "pending" } });
    deps.publish();
    schedule(async () => {
      // The user may have moved on while this waited in the queue.
      if (deps.store.get(thread.id)?.eventId !== eventId) return;
      const generation = generationOf(thread.id);
      let summary: Summary | null = null;
      let failure: string | null = null;
      let run: SummaryRun | null = null;
      try {
        run = deps.summarize(
          {
            thread: { id: thread.id, title: base.threadTitle, projectName: base.projectName, folder: base.folder },
            eventId,
            reason,
            headline: base.headline,
            detail: base.detail,
            output: recording.output,
            lastUser: recording.lastUser,
          },
          config,
        );
        summary = await run.result;
      } catch (error) {
        failure = reasonOf(error);
        deps.log.error(`The summary for thread ${thread.id} failed: ${failure}`);
      }

      // Checked after the summary rather than before it: writing one takes
      // seconds, and that is the window in which a completion turns out not
      // to have been one. Nothing is said and the entry is taken back.
      const check = reason === "finished" ? "running" : recording.requestId === null ? null : { interactionId: recording.requestId };
      if (await outran(thread.id, generation, check)) {
        if (deps.store.removeIf(thread.id, (entry) => entry.eventId === eventId)) deps.publish();
      } else {
        const settled: AttentionEntry["summary"] =
          summary !== null
            ? { status: "ready", ...summary }
            : { status: "failed", error: failure ?? "The summary helper returned nothing.", fallback: fallbackSpeech(base) };
        if (deps.store.updateSummary(thread.id, eventId, settled)) deps.publish();
      }
      // The sentence is out; the slot is held until the helper is put away,
      // so stopping helpers never add up past the cap.
      await run?.finished;
    });
  }

  /** Runs a handler's async work; a failure is logged, never left to reject inside the bb server. */
  async function guarded(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      deps.log.error(`Handling ${what} failed: ${reasonOf(error)}`);
    }
  }

  return {
    active(thread) {
      if (isHelper(thread)) {
        deps.outcomes.active(thread.id);
        return;
      }
      movedOn(thread.id);
      removeEntry(thread.id);
    },

    idle(thread, lastAssistantText) {
      if (isHelper(thread)) {
        deps.outcomes.idle(thread.id, lastAssistantText);
        return Promise.resolve();
      }
      if (thread.visibility === "hidden") return Promise.resolve();
      return guarded("thread.idle", async () => {
        // bb assembles the turn's text itself, chunks and all; it is used as
        // it comes, with nothing added between the pieces.
        const output = lastAssistantText?.trim() ?? "";
        // A turn that produced no words — a compaction, a bare tool run —
        // gives the user nothing to hear. Checked before the repeat test, so
        // a silent end does not stand in for the turn end that follows it.
        if (output === "") return;
        if (isRepeatIdle(thread.id)) return;
        const event = beginEvent(thread.id);
        const generation = generationOf(thread.id);
        const [config, context] = await Promise.all([
          deps.readConfig(),
          deps.events.context(thread, { withRequest: true }),
        ]);
        if (generationOf(thread.id) !== generation || !isLatest(thread.id, event)) return;
        record({
          thread,
          reason: "finished",
          eventId: `${thread.id}:idle:${now().getTime()}`,
          requestId: null,
          headline: "Finished",
          detail: firstWords(output, 60),
          output,
          config,
          projectName: context.projectName,
          folder: context.folder,
          lastUser: context.lastRequest,
        });
      });
    },

    failed(thread, error) {
      if (isHelper(thread)) {
        deps.outcomes.failed(thread.id, error);
        return Promise.resolve();
      }
      if (thread.visibility === "hidden") return Promise.resolve();
      return guarded("thread.failed", async () => {
        const event = beginEvent(thread.id);
        const generation = generationOf(thread.id);
        const [config, context, interrupted] = await Promise.all([
          deps.readConfig(),
          deps.events.context(thread, { withRequest: true }),
          deps.events.interruptedRecently(thread.id, INTERRUPT_GRACE_MS),
        ]);
        if (interrupted) return;
        if (generationOf(thread.id) !== generation || !isLatest(thread.id, event)) return;
        record({
          thread,
          reason: "error",
          eventId: `${thread.id}:failed:${now().getTime()}`,
          requestId: null,
          headline: error?.trim() || "The turn failed",
          detail: null,
          output: "",
          config,
          projectName: context.projectName,
          folder: context.folder,
          lastUser: context.lastRequest,
        });
      });
    },

    interactionPending(thread, interaction) {
      if (isHelper(thread)) {
        deps.outcomes.interaction(thread.id);
        return Promise.resolve();
      }
      if (thread.visibility === "hidden" || interaction.status !== "pending") return Promise.resolve();
      return guarded("interaction.pending", async () => {
        const described = describeInteraction(interaction);
        const event = beginEvent(thread.id);
        const generation = generationOf(thread.id);
        const [config, context] = await Promise.all([
          deps.readConfig(),
          deps.events.context(thread, { withRequest: false }),
        ]);
        if (generationOf(thread.id) !== generation || !isLatest(thread.id, event)) return;
        record({
          thread,
          reason: described.reason,
          eventId: `${thread.id}:interaction:${interaction.id}`,
          requestId: interaction.id,
          headline: described.headline,
          detail: described.detail,
          output: "",
          config,
          projectName: context.projectName,
          folder: context.folder,
          lastUser: null,
        });
      });
    },

    gone(thread) {
      if (isHelper(thread)) {
        deps.outcomes.forget(thread.id);
        return;
      }
      movedOn(thread.id);
      recentIdles.delete(thread.id);
      removeEntry(thread.id);
    },

    async drain() {
      disposed = true;
      queue.length = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          deps.log.warn(`${inFlight.size} summaries were still putting their helpers away at unload.`);
          resolve(false);
        }, deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
      });
      const drained = await Promise.race([Promise.allSettled([...inFlight]).then(() => true), timeout]);
      clearTimeout(timer);
      return drained;
    },
  };
}

