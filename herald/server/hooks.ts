/**
 * Where events become entries. Four things every handler here has to get right:
 *
 * 1. **Return fast.** bb's events are announcements: a handler cannot block
 *    anything, and it runs inside the bb server's own process. Each handler
 *    looks up the thread's names, records the entry with its sentence, and
 *    returns; a failure is logged, never thrown into the bb server.
 * 2. **Dedupe a turn's end.** A second `thread.idle` with no `thread.active`
 *    between them, inside the window, is the same turn reported twice.
 * 3. **Follow the thread, not the plugin.** An entry lives until the events
 *    show the thread moving on: a new turn, an archive, a delete. bb's unread
 *    state decides what the panel *lists*; see `server/liveness.ts`.
 * 4. **Leave hidden threads alone.** Another plugin's background worker is not
 *    something the user is waiting on; bb keeps it out of their attention too.
 */
import type { AttentionEntry, AttentionReason } from "../shared/herald";
import type { SentenceSettings } from "../shared/settings";
import { fillTemplate, splitCommandLine } from "./command-line";
import type { EventsPort, Interaction, Log, ThreadDto } from "./ports";
import type { AttentionStore } from "./store";
import { describeInteraction, displayName, fallbackSpeech, firstWords, preview } from "./timeline";

/** What the handlers act on, read fresh for every event so a settings change applies at once. */
export interface HeraldConfig {
  announce: Record<AttentionReason, boolean>;
  /** Whether a thread another thread started is announced as well as its parent. */
  announceSubagents: boolean;
  /** The tool that writes each sentence, or null for the plain one. */
  sentence: SentenceSettings | null;
}

export interface HookDeps {
  store: AttentionStore;
  readConfig: () => Promise<HeraldConfig>;
  events: EventsPort;
  /** Tells open clients the entries changed. */
  publish: () => void;
  /** Runs the tool with the prompt on stdin and resolves to its sentence; rejects on any failure. */
  writeSentence: (command: string[], prompt: string) => Promise<string>;
  log: Log;
  now?: () => Date;
}

/** How the prompt names each kind of event. */
const EVENT_PHRASES: Record<AttentionReason, string> = {
  question: "asks the developer a question",
  plan: "waits for the developer to approve its plan",
  permission: "asks for permission",
  finished: "finished its turn",
  error: "stopped with an error",
};

/** The agent's output is the longest thing in the prompt; this keeps a long turn from swamping the rest. */
const PROMPT_OUTPUT_MAX = 3000;
/** A pasted-in request or a kilobyte-long command is cut too; the prompt is about the event, not a transcript. */
const PROMPT_PART_MAX = 1000;

function cut(text: string | null, max: number): string | null {
  return text !== null && text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A second `thread.idle` for the same turn inside this window is a repeat, not a new turn. */
export const TURN_REPEAT_WINDOW_MS = 15_000;

/**
 * A turn that fails this soon after the user interrupted it while it waited on
 * them failed because the user stopped it. It is not news to announce.
 */
export const INTERRUPT_GRACE_MS = 10_000;

/**
 * Whether an event is announced; otherwise it is only listed. A
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
  /** Stops recording: on unload, nothing an event still in flight learned is kept. */
  dispose(): void;
}

export function createHooks(deps: HookDeps): Hooks {
  const now = deps.now ?? (() => new Date());

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

  interface Recording {
    thread: ThreadDto;
    reason: AttentionReason;
    eventId: string;
    requestId: string | null;
    headline: string;
    detail: string | null;
    config: HeraldConfig;
    projectName: string | null;
    folder: string | null;
    lastUser: string | null;
    /** The whole of what the agent last said, for the prompt; the entry keeps only its start. */
    output: string | null;
  }

  function record(recording: Recording): void {
    const { thread, reason, config } = recording;
    const base: Omit<AttentionEntry, "summary"> = {
      threadId: thread.id,
      projectId: thread.projectId,
      projectName: recording.projectName,
      threadTitle: thread.title ?? thread.titleFallback,
      lastRequest: recording.lastUser === null ? null : preview(recording.lastUser),
      folder: recording.folder,
      reason,
      eventId: recording.eventId,
      requestId: recording.requestId,
      createdAt: now().toISOString(),
      headline: recording.headline,
      detail: recording.detail,
    };
    const fallback = fallbackSpeech(base);
    // Switched off, or a subagent its parent speaks for: listed in the panel,
    // with its sentence, never spoken.
    if (!isAnnounced(thread, reason, config)) {
      deps.store.upsert({ ...base, summary: { status: "off", fallback } });
      deps.publish();
      return;
    }
    if (config.sentence === null) {
      deps.store.upsert({ ...base, summary: { status: "ready", text: fallback } });
      deps.publish();
      return;
    }
    // Listed at once with the plain sentence as its stand-in; the tool's
    // reply replaces it, or the stand-in is promoted when the tool fails.
    deps.store.upsert({ ...base, summary: { status: "pending", fallback } });
    deps.publish();
    void writeSentence(config.sentence, base, recording).then((text) => settleSentence(base.threadId, base.eventId, text ?? fallback));
  }

  /** The tool's sentence, or null — with the reason logged — when it gave none. Never rejects. */
  async function writeSentence(sentence: SentenceSettings, base: Omit<AttentionEntry, "summary">, recording: Recording): Promise<string | null> {
    try {
      const command = splitCommandLine(sentence.command);
      const prompt = fillTemplate(sentence.prompt, {
        thread: displayName(base),
        project: base.projectName,
        folder: base.folder,
        event: EVENT_PHRASES[base.reason],
        headline: cut(base.headline, PROMPT_PART_MAX),
        detail: cut(base.detail, PROMPT_PART_MAX),
        request: cut(recording.lastUser, PROMPT_PART_MAX),
        output: cut(recording.output, PROMPT_OUTPUT_MAX),
      });
      return await deps.writeSentence(command, prompt);
    } catch (error) {
      deps.log.warn(`The sentence for ${base.threadId} falls back to the plain one: ${reasonOf(error)}`);
      return null;
    }
  }

  /**
   * Lands a sentence on the entry it was written for — only while that entry
   * is still the one waiting. The thread may have moved on, or a newer event
   * may have replaced it; a sentence about an earlier event is stale news.
   */
  function settleSentence(threadId: string, eventId: string, text: string): void {
    if (disposed) return;
    const current = deps.store.get(threadId);
    if (current === null || current.eventId !== eventId || current.summary.status !== "pending") return;
    deps.store.upsert({ ...current, summary: { status: "ready", text } });
    deps.publish();
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
      movedOn(thread.id);
      removeEntry(thread.id);
    },

    idle(thread, lastAssistantText) {
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
          config,
          projectName: context.projectName,
          folder: context.folder,
          lastUser: context.lastRequest,
          output,
        });
      });
    },

    failed(thread, error) {
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
          config,
          projectName: context.projectName,
          folder: context.folder,
          lastUser: context.lastRequest,
          output: null,
        });
      });
    },

    interactionPending(thread, interaction) {
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
          config,
          projectName: context.projectName,
          folder: context.folder,
          lastUser: null,
          output: null,
        });
      });
    },

    gone(thread) {
      movedOn(thread.id);
      recentIdles.delete(thread.id);
      removeEntry(thread.id);
    },

    dispose() {
      disposed = true;
    },
  };
}

