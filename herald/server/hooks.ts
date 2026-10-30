/**
 * Where events become entries. Four things every handler here has to get right:
 *
 * 1. **Return fast.** bb's events are announcements: a handler cannot block
 *    anything, and it runs inside the bb server's own process. Each handler
 *    looks up the thread's names, records the entry with its sentence, and
 *    returns; a failure is logged, never thrown into the bb server.
 * 2. **Dedupe a turn's end.** A second `thread.idle` with no `thread.active`
 *    between them, inside the window, is the same turn reported twice.
 * 3. **Follow the thread, not the plugin.** An entry is the thread's last
 *    event and lives until the next one replaces it, or the thread is archived
 *    or deleted. A new turn takes back only a sentence still being written.
 *    bb's unread state decides what the panel *lists*; see `app/rows.ts`.
 * 4. **Leave hidden threads alone.** Another plugin's background worker is not
 *    something the user is waiting on; bb keeps it out of their attention too.
 */
import type { AttentionEntry, AttentionReason, HistoryItem } from "../shared/herald";
import type { SentenceSettings } from "../shared/settings";
import { choiceAllows, effectiveChoice, NO_CHOICE, type ChoiceInputs, type ThreadChoice } from "../shared/thread-choice";
import { fillTemplate, splitCommandLine } from "./command-line";
import type { EventsPort, Interaction, Log, ThreadDto } from "./ports";
import type { PushEvent, PushSubject } from "./push";
import type { AttentionStore } from "./store";
import { describeInteraction, displayName, fallbackSpeech, firstWords, preview } from "./timeline";

/** What the handlers act on, read fresh for every event so a settings change applies at once. */
export interface HeraldConfig {
  announce: Record<AttentionReason, boolean>;
  /** Whether a thread another thread started is announced as well as its parent. */
  announceSubagents: boolean;
  /** The tool that writes each sentence, or null for the plain one. */
  sentence: SentenceSettings | null;
  /** *Send Herald's sentences as push notifications instead of bb's.* */
  push: boolean;
}

/**
 * Herald's push notifications (`push.ts`): hears of each event as it
 * arrives, brings a thread's bb notification level in line with its choice,
 * says whether Herald notifies an event itself, and sends. Nothing rejects.
 */
export interface PushHooks {
  saw(threadId: string, at: number): void;
  /** Stores an event Herald could not finish looking up before it unloads, for the next instance to decide. */
  handOver(subject: PushSubject, sentence: string, event: PushEvent): Promise<void>;
  /** `takeOver` false: settle what the event is owed, and change no level. */
  decide(threadId: string, choiceOf: () => Promise<ThreadChoice>, event: PushEvent | null, takeOver?: boolean): Promise<boolean>;
  send(subject: PushSubject, sentence: string): Promise<void>;
}

export interface HookDeps {
  store: AttentionStore;
  readConfig: () => Promise<HeraldConfig>;
  events: EventsPort;
  /** The thread's own choice from bb's thread menu, and the nearest one above it. */
  choiceOf: (thread: ThreadDto) => Promise<ChoiceInputs>;
  /** Tells open clients the entries changed. */
  publish: () => void;
  /** Runs the tool with the prompt on stdin and resolves to its sentence; rejects on any failure. */
  writeSentence: (command: string[], prompt: string) => Promise<string>;
  /** Adds a sentence that landed to the thread's history, for its panel. Never throws. */
  remember: (threadId: string, item: HistoryItem) => void;
  /** Absent in tests that are not about notifications. */
  push?: PushHooks;
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

/**
 * How long an unload waits for event handlers still looking things up, and
 * for the notifications they send: bb drains a plugin's handlers only after
 * its unload hook, so what finishes later is the next instance's to find in
 * the outbox.
 */
export const DISPOSE_DRAIN_MS = 5_000;

/** A second `thread.idle` for the same turn inside this window is a repeat, not a new turn. */
export const TURN_REPEAT_WINDOW_MS = 15_000;

/**
 * A turn that fails this soon after the user interrupted it while it waited on
 * them failed because the user stopped it. It is not news to announce.
 */
export const INTERRUPT_GRACE_MS = 10_000;

/**
 * Whether an event is announced; otherwise it is only listed. The thread's
 * choice from bb's thread menu comes first (`effectiveChoice`): Silent, or
 * Questions only for a finished or failed turn, keeps it quiet. Without a
 * choice of its own, a thread another thread started reports to that thread
 * — bb tells the parent when it finishes, fails or is interrupted — so unless
 * the user has asked for subagents too, the parent's announcement is the one
 * they hear. Then the kind of event must be switched on.
 */
export function isAnnounced(thread: ThreadDto, reason: AttentionReason, config: HeraldConfig, choice: ChoiceInputs): boolean {
  return choiceAllows(choiceFor(thread, config, choice), reason) && config.announce[reason];
}

/** The thread's effective choice: its own, the subagent rule, an ancestor's, or announce. */
function choiceFor(thread: ThreadDto, config: HeraldConfig, choice: ChoiceInputs): ThreadChoice {
  return effectiveChoice(choice, thread.parentThreadId !== null, config.announceSubagents).choice;
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
  /** The events whose sentences a tool is still writing; a reload's settling leaves these alone. */
  inFlightEventIds(): ReadonlySet<string>;
  /**
   * Stops recording: on unload, nothing an event still in flight learned is
   * kept. Resolves once every notification still waiting on its sentence has
   * gone out with the plain one: bb is muted for it, and the sentence will
   * not come.
   */
  dispose(): Promise<void>;
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
  /** Event ids with a tool run under way, until their sentence lands or is dropped. */
  const inFlight = new Set<string>();
  /**
   * The notifications waiting on a sentence being written, by event id. They
   * are the event's, not the entry's: an entry a newer event replaced, or a
   * banner taken back, does not mean bb told the user — bb was muted for it.
   * Whoever takes one from here sends it: the sentence when it comes, or the
   * plain one on unload.
   */
  const owedPushes = new Map<string, { owes: Promise<boolean>; subject: PushSubject; fallback: string }>();

  /** Heard at once, before any lookup, so a give-back of the level waits for bb's read of it. */
  function sawEvent(thread: ThreadDto): number {
    const at = now().getTime();
    deps.push?.saw(thread.id, at);
    return at;
  }

  /**
   * Every event still being looked up, with what its notification would say
   * with nothing looked up: registered as it arrives, so an unload whose
   * drain runs out can hand it to the next instance while storage still
   * works. A handed-over event sends nothing itself when its lookup returns.
   */
  const arrivals = new Map<number, { subject: PushSubject; fallback: string; event: PushEvent; handedOver: boolean }>();
  let arrivalCounter = 0;

  function arrive(thread: ThreadDto, at: number, what: { reason: AttentionReason; headline: string; detail: string | null; requestId: string | null }): number {
    arrivalCounter += 1;
    const subject = {
      threadId: thread.id,
      threadTitle: thread.title ?? thread.titleFallback,
      projectName: null,
      reason: what.reason,
      requestId: what.requestId,
      createdAt: new Date(at).toISOString(),
    };
    const fallback = fallbackSpeech({ ...subject, headline: what.headline, detail: what.detail });
    arrivals.set(arrivalCounter, { subject, fallback, event: { reason: what.reason, at }, handedOver: false });
    return arrivalCounter;
  }

  function handedOver(token: number): boolean {
    return arrivals.get(token)?.handedOver === true;
  }

  /** Whether Herald notifies this event itself; false without the push hooks. */
  function decidePush(thread: ThreadDto, event: PushEvent, config: HeraldConfig, choice: ChoiceInputs, takeOver = true): Promise<boolean> {
    if (deps.push === undefined) return Promise.resolve(false);
    const effective = choiceFor(thread, config, choice);
    return deps.push.decide(thread.id, () => Promise.resolve(effective), event, takeOver);
  }

  /** Handlers still running, and notifications being decided or sent: an unload waits for both. */
  const handlersRunning = new Set<Promise<void>>();
  const pushesRunning = new Set<Promise<void>>();

  function tracked(set: Set<Promise<void>>, work: Promise<void>): Promise<void> {
    set.add(work);
    void work.finally(() => set.delete(work));
    return work;
  }

  function pushWhen(owes: Promise<boolean>, subject: PushSubject, sentence: string): void {
    void tracked(
      pushesRunning,
      owes.then(async (yes) => {
        if (yes) await deps.push?.send(subject, sentence);
      }),
    );
  }

  /** Waits for every promise in the set, new ones included, for at most `until`. */
  async function drain(set: Set<Promise<void>>, until: number): Promise<void> {
    while (set.size > 0) {
      // The wall clock, not `deps.now`, which a test may hold still.
      const left = until - Date.now();
      if (left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all([...set]), new Promise((resolve) => (timer = setTimeout(resolve, left)))]);
      clearTimeout(timer);
    }
  }

  function sendOwed(eventId: string, sentence: string): void {
    const owed = owedPushes.get(eventId);
    if (owed === undefined) return;
    owedPushes.delete(eventId);
    pushWhen(owed.owes, owed.subject, sentence);
  }

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
    choice: ChoiceInputs;
    projectName: string | null;
    folder: string | null;
    lastUser: string | null;
    /** The whole of what the agent last said, for the prompt; the entry keeps only its start. */
    output: string | null;
    /** When the event arrived, before any lookup. */
    at: number;
    /** Its arrival (`arrive`). */
    token: number;
  }

  /**
   * An event whose lookups are done. A newer event or turn replaced it for
   * the banner, which stays as it is; but bb may have held its notification
   * back all the same — an earlier question still waits even when a later
   * one was answered — so its notification is still decided and sent, with
   * the plain sentence. `send` drops it when it is no longer news.
   */
  function admit(stale: boolean, recording: Recording): void {
    if (!stale) {
      record(recording);
      return;
    }
    if (handedOver(recording.token)) return;
    const base = baseOf(recording);
    // Settled only: an event a newer one replaced takes no level, so it cannot re-take a thread given back meanwhile.
    pushWhen(decidePush(recording.thread, { reason: recording.reason, at: recording.at }, recording.config, recording.choice, false), base, fallbackSpeech(base));
  }

  function baseOf(recording: Recording): Omit<AttentionEntry, "summary"> {
    const { thread, reason } = recording;
    return {
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
  }

  function record(recording: Recording): void {
    const { thread, reason, config, choice } = recording;
    const base = baseOf(recording);
    const fallback = fallbackSpeech(base);
    // Decided whatever is spoken: a mute of Herald's can suppress what bb
    // would have notified about an event Herald does not announce, and then
    // Herald notifies it with the plain sentence.
    const owes = handedOver(recording.token) ? Promise.resolve(false) : decidePush(thread, { reason, at: recording.at }, config, choice);
    // Switched off, silenced from the thread menu, or a subagent its parent
    // speaks for: listed in the panel, with its sentence, never spoken — and
    // no tool is run to write it.
    if (!isAnnounced(thread, reason, config, choice)) {
      deps.store.upsert({ ...base, summary: { status: "off", fallback } });
      deps.publish();
      remember(base, fallback);
      pushWhen(owes, base, fallback);
      return;
    }
    if (config.sentence === null) {
      deps.store.upsert({ ...base, summary: { status: "ready", text: fallback } });
      deps.publish();
      remember(base, fallback);
      pushWhen(owes, base, fallback);
      return;
    }
    // Listed at once with the plain sentence as its stand-in; the tool's
    // reply replaces it, or the stand-in is promoted when the tool fails.
    deps.store.upsert({ ...base, summary: { status: "pending", fallback } });
    deps.publish();
    inFlight.add(base.eventId);
    owedPushes.set(base.eventId, { owes, subject: base, fallback });
    const written = writeSentence(config.sentence, base, recording);
    // The notification goes with the event's own sentence, whatever became
    // of the entry meanwhile; `send` itself skips what is no longer news.
    void written.then((text) => sendOwed(base.eventId, text ?? fallback));
    void written
      .then((text) => settleSentence(base.threadId, base.eventId, text ?? fallback))
      .catch((error: unknown) => deps.log.error(`Settling the sentence for ${base.threadId} failed: ${reasonOf(error)}`))
      .finally(() => inFlight.delete(base.eventId));
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
   * A question or approval the user answered meanwhile fired no event, so it
   * is asked about first: answered, the entry is withdrawn, unspoken.
   */
  async function settleSentence(threadId: string, eventId: string, text: string): Promise<void> {
    const stillWaiting = () => {
      if (disposed) return null;
      const current = deps.store.get(threadId);
      return current !== null && current.eventId === eventId && current.summary.status === "pending" ? current : null;
    };
    const entry = stillWaiting();
    if (entry === null) return;
    if (entry.requestId !== null && !(await stillPending(threadId, entry.requestId))) {
      // Checked again after the wait: the thread may have moved on meanwhile.
      if (stillWaiting() !== null && deps.store.remove(threadId) !== null) deps.publish();
      return;
    }
    const current = stillWaiting();
    if (current === null) return;
    deps.store.upsert({ ...current, summary: { status: "ready", text } });
    deps.publish();
    remember(current, text);
  }

  /**
   * Whether the interaction still waits on the user. Fails closed: when bb
   * cannot say, the answer is no, and the entry is withdrawn rather than
   * left pending with nothing coming to settle it.
   */
  async function stillPending(threadId: string, requestId: string): Promise<boolean> {
    try {
      return await deps.events.interactionPending(threadId, requestId);
    } catch (error) {
      deps.log.warn(`Could not check whether ${requestId} on ${threadId} still waits; dropping its sentence: ${reasonOf(error)}`);
      return false;
    }
  }

  /** A sentence that landed — plain, or the model's — joins the thread's history. */
  function remember(entry: Omit<AttentionEntry, "summary">, text: string): void {
    deps.remember(entry.threadId, {
      eventId: entry.eventId,
      reason: entry.reason,
      createdAt: entry.createdAt,
      headline: entry.headline,
      text,
    });
  }

  /**
   * The thread's choice, or none when bb cannot say: a lookup that fails
   * announces as Herald's settings say rather than losing the announcement.
   */
  async function choiceOf(thread: ThreadDto): Promise<ChoiceInputs> {
    try {
      return await deps.choiceOf(thread);
    } catch (error) {
      deps.log.warn(`Could not read what ${thread.id} is set to announce; following Herald's settings: ${reasonOf(error)}`);
      return NO_CHOICE;
    }
  }

  /** Runs a handler's async work; a failure is logged, never left to reject inside the bb server. */
  function guarded(what: string, work: () => Promise<void>): Promise<void> {
    return tracked(
      handlersRunning,
      (async () => {
        try {
          await work();
        } catch (error) {
          deps.log.error(`Handling ${what} failed: ${reasonOf(error)}`);
        }
      })(),
    );
  }

  /**
   * A turn starting is the earliest Herald hears of a thread, so its bb level
   * is brought in line here, before the turn's end is notified — bb reads the
   * level a couple of seconds after each event. Only with the switch on.
   */
  function syncPush(thread: ThreadDto): void {
    const push = deps.push;
    if (push === undefined || thread.visibility === "hidden") return;
    void guarded("thread.active (notifications)", async () => {
      const config = await deps.readConfig();
      if (!config.push) return;
      await push.decide(thread.id, async () => choiceFor(thread, config, await choiceOf(thread)), null);
    });
  }

  return {
    active(thread) {
      movedOn(thread.id);
      syncPush(thread);
      // The sentence is the thread's last event and stays above the composer
      // through the next turn — unless it is still being written: the agent
      // working again, on its own or on a new prompt, makes it stale before
      // it is said, so it is taken back and never spoken.
      const current = deps.store.get(thread.id);
      if (current !== null && current.summary.status === "pending") removeEntry(thread.id);
    },

    idle(thread, lastAssistantText) {
      if (thread.visibility === "hidden") return Promise.resolve();
      const at = sawEvent(thread);
      return guarded("thread.idle", async () => {
        // bb assembles the turn's text itself, chunks and all; it is used as
        // it comes, with nothing added between the pieces.
        const output = lastAssistantText?.trim() ?? "";
        // A turn that produced no words — a compaction, a bare tool run —
        // gives the user nothing to hear. Checked before the repeat test, so
        // a silent end does not stand in for the turn end that follows it.
        if (output === "") return;
        if (isRepeatIdle(thread.id)) return;
        const token = arrive(thread, at, { reason: "finished", headline: "Finished", detail: firstWords(output, 60), requestId: null });
        try {
          const event = beginEvent(thread.id);
          const generation = generationOf(thread.id);
          const [config, context, choice] = await Promise.all([
            deps.readConfig(),
            deps.events.context(thread, { withRequest: true }),
            choiceOf(thread),
          ]);
          const stale = generationOf(thread.id) !== generation || !isLatest(thread.id, event);
          admit(stale, {
            thread,
            reason: "finished",
            eventId: `${thread.id}:idle:${now().getTime()}`,
            requestId: null,
            headline: "Finished",
            detail: firstWords(output, 60),
            config,
            choice,
            projectName: context.projectName,
            folder: context.folder,
            lastUser: context.lastRequest,
            output,
            at,
            token,
          });
        } finally {
          arrivals.delete(token);
        }
      });
    },

    failed(thread, error) {
      if (thread.visibility === "hidden") return Promise.resolve();
      const at = sawEvent(thread);
      const token = arrive(thread, at, { reason: "error", headline: error?.trim() || "The turn failed", detail: null, requestId: null });
      return guarded("thread.failed", async () => {
        try {
          const event = beginEvent(thread.id);
          const generation = generationOf(thread.id);
          const [config, context, interrupted, choice] = await Promise.all([
            deps.readConfig(),
            deps.events.context(thread, { withRequest: true }),
            deps.events.interruptedRecently(thread.id, INTERRUPT_GRACE_MS),
            choiceOf(thread),
          ]);
          if (interrupted) return;
          const stale = generationOf(thread.id) !== generation || !isLatest(thread.id, event);
          admit(stale, {
            thread,
            reason: "error",
            eventId: `${thread.id}:failed:${now().getTime()}`,
            requestId: null,
            headline: error?.trim() || "The turn failed",
            detail: null,
            config,
            choice,
            projectName: context.projectName,
            folder: context.folder,
            lastUser: context.lastRequest,
            output: null,
            at,
            token,
          });
        } finally {
          arrivals.delete(token);
        }
      });
    },

    interactionPending(thread, interaction) {
      if (thread.visibility === "hidden" || interaction.status !== "pending") return Promise.resolve();
      const at = sawEvent(thread);
      const described = describeInteraction(interaction);
      const token = arrive(thread, at, { reason: described.reason, headline: described.headline, detail: described.detail, requestId: interaction.id });
      return guarded("interaction.pending", async () => {
        try {
          const event = beginEvent(thread.id);
          const generation = generationOf(thread.id);
          const [config, context, choice] = await Promise.all([
            deps.readConfig(),
            deps.events.context(thread, { withRequest: false }),
            choiceOf(thread),
          ]);
          const stale = generationOf(thread.id) !== generation || !isLatest(thread.id, event);
          admit(stale, {
            thread,
            reason: described.reason,
            eventId: `${thread.id}:interaction:${interaction.id}`,
            requestId: interaction.id,
            headline: described.headline,
            detail: described.detail,
            config,
            choice,
            projectName: context.projectName,
            folder: context.folder,
            lastUser: null,
            output: null,
            at,
            token,
          });
        } finally {
          arrivals.delete(token);
        }
      });
    },

    gone(thread) {
      movedOn(thread.id);
      recentIdles.delete(thread.id);
      removeEntry(thread.id);
    },

    inFlightEventIds() {
      return inFlight;
    },

    async dispose() {
      disposed = true;
      // Handlers still looking things up finish first: their events settle
      // what they are owed (`admit`), within the instance's own unload.
      const until = Date.now() + DISPOSE_DRAIN_MS;
      await drain(handlersRunning, until);
      // Lookups still out: past this point bb may stop this instance's
      // storage and calls, so each such event is stored for the next one.
      const unfinished = [...arrivals.values()].filter((arrival) => !arrival.handedOver);
      for (const arrival of unfinished) arrival.handedOver = true;
      await Promise.all(unfinished.map((arrival) => deps.push?.handOver(arrival.subject, arrival.fallback, arrival.event)));
      for (const [eventId, { fallback }] of [...owedPushes]) sendOwed(eventId, fallback);
      await drain(pushesRunning, until);
    },
  };
}

