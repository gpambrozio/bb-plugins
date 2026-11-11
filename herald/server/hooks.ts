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
import type { AttentionEntry, AttentionReason, HistoryItem, ReplyFormat } from "../shared/herald";
import type { SentenceSettings } from "../shared/settings";
import { choiceAllows, effectiveChoice, NO_CHOICE, type ChoiceInputs, type ThreadChoice } from "../shared/thread-choice";
import { CarriedUpdates, combinedOutput, type Carried } from "./carry";
import { fillTemplate, splitCommandLine } from "./command-line";
import type { EventsPort, Interaction, Log, ThreadDto } from "./ports";
import type { PushEvent, PushSubject } from "./push";
import type { AttentionStore } from "./store";
import { describeInteraction, displayName, fallbackSpeech, firstWords, preview } from "./timeline";
import type { WrittenSentence } from "./writer";

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
  /**
   * Runs the tool with the prompt on stdin and resolves to its sentence, or
   * to `silent` when it ran and answered nothing (an empty reply, or a null
   * or empty summary in JSON); rejects on any failure, and when `signal`
   * aborts — which frees the run's slot by the time it has rejected.
   */
  writeSentence: (command: string[], prompt: string, reply: ReplyFormat, signal: AbortSignal) => Promise<WrittenSentence>;
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

/**
 * How long a run waits for the run it overtook to stop. Aborting one rejects
 * at once and frees its slot, so this only bounds a run that ignores it.
 */
export const OVERTAKEN_STOP_MS = 2_000;

/**
 * How long a run waits for bb to say whether earlier held turns are ones a
 * tool writes for (their config and choice reads). One still undecided
 * after this is left out of the run's prompt and stays held.
 */
export const ELIGIBILITY_WAIT_MS = 5_000;

const NOTHING_EARLIER: Carried = { updates: [], dropped: 0, seqs: [] };

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

/**
 * Whether the event waits on the user. A tool's silence keeps such an event
 * from being spoken, never from being listed or notified, and its
 * `speak: false` changes nothing for it; a finished turn it keeps quiet is
 * gone altogether, and one it asks not to speak is only written down.
 */
function waitsOnUser(reason: AttentionReason): boolean {
  return reason !== "finished";
}

/** What became of a tool run: what it wrote, its chosen silence, or a failure (the plain sentence). */
type WriteOutcome = WrittenSentence | { kind: "failed" };

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
  /** Each thread's finished turns no landed sentence has covered yet (`carry.ts`). */
  const carried = new CarriedUpdates();
  /**
   * Each thread's newest tool run for a finished turn. A newer run stops it
   * before starting — its update is carried into the newer one's prompt — so
   * one thread never holds both of the writer's slots with sentences that can
   * no longer land, and takes over the notification it owed. A question's run
   * is never stopped: an earlier question still waits on the user when a
   * later one is answered, and its notification is its own.
   */
  const runs = new Map<string, { eventId: string; controller: AbortController; done: Promise<unknown> }>();

  /** Heard at once, before any lookup, so a give-back of the level waits for bb's read of it. */
  function sawEvent(thread: ThreadDto): number {
    const at = now().getTime();
    deps.push?.saw(thread.id, at);
    return at;
  }

  /**
   * Every event still being looked up, with what its notification would say
   * with nothing looked up: registered as it arrives, so an unload whose
   * drain runs out can settle it while its storage and calls still work —
   * after the unload, bb may invalidate them. An event settled that way
   * sends nothing itself when its lookup returns.
   */
  const arrivals = new Map<number, { subject: PushSubject; fallback: string; event: PushEvent; settled: boolean }>();
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
    arrivals.set(arrivalCounter, { subject, fallback, event: { reason: what.reason, at }, settled: false });
    return arrivalCounter;
  }

  function settledOnUnload(token: number): boolean {
    return arrivals.get(token)?.settled === true;
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

  /**
   * Settles a written event's notification: `sentence` goes out if Herald
   * owes it, and null sends nothing — a finished turn the tool kept silent.
   * The decision is still waited for, so an unload drains it like any other.
   */
  function sendOwed(eventId: string, sentence: string | null): void {
    const owed = owedPushes.get(eventId);
    if (owed === undefined) return;
    owedPushes.delete(eventId);
    if (sentence === null) void tracked(pushesRunning, owed.owes.then(() => undefined));
    else pushWhen(owed.owes, owed.subject, sentence);
  }

  /**
   * What a written event's notification says: the tool's sentence, the plain
   * one, or nothing for a finished turn the tool kept quiet or asked not to
   * speak. An event that waits on the user is always notified.
   */
  function pushSentence(reason: AttentionReason, outcome: WriteOutcome, fallback: string): string | null {
    switch (outcome.kind) {
      case "sentence":
        return outcome.text;
      case "unspoken":
        return waitsOnUser(reason) ? outcome.text : null;
      case "silent":
        return waitsOnUser(reason) ? fallback : null;
      case "failed":
        return fallback;
    }
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
    /**
     * What the prompt's `{{request}}` gets: the message the turn took in (a
     * child's report included), else the user's last prompt (`lastUser`).
     */
    request: string | null;
    /** When the event arrived, before any lookup. */
    at: number;
    /** Its arrival (`arrive`). */
    token: number;
    /** Its place in the thread's order, taken as it arrived (`CarriedUpdates.arrive`). */
    seq: number;
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
    // Overtaken before its run could start: what it said stays held for the
    // next run, unless no tool would have written for it.
    if (!toolWrites(recording)) carried.withdraw(recording.thread.id, recording.seq);
    if (settledOnUnload(recording.token)) return;
    const base = baseOf(recording);
    // Settled only: an event a newer one replaced takes no level, so it cannot re-take a thread given back meanwhile.
    pushWhen(decidePush(recording.thread, { reason: recording.reason, at: recording.at }, recording.config, recording.choice, false), base, fallbackSpeech(base));
  }

  /** Whether a tool writes this event's sentence, as its lookups say. */
  function toolWrites({ thread, reason, config, choice }: Recording): boolean {
    return config.sentence !== null && isAnnounced(thread, reason, config, choice);
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
    const owes = settledOnUnload(recording.token) ? Promise.resolve(false) : decidePush(thread, { reason, at: recording.at }, config, choice);
    // Switched off, silenced from the thread menu, or a subagent its parent
    // speaks for: listed in the panel, with its sentence, never spoken — and
    // no tool is run to write it.
    if (!isAnnounced(thread, reason, config, choice)) {
      // Not spoken: what came before waits for the next announced event, without this one.
      carried.withdraw(thread.id, recording.seq);
      deps.store.upsert({ ...base, summary: { status: "off", fallback } });
      deps.publish();
      remember(base, fallback);
      pushWhen(owes, base, fallback);
      return;
    }
    if (config.sentence === null) {
      // Spoken without a tool: there is no run to give what was carried to.
      carried.coveredThrough(thread.id, recording.seq);
      deps.store.upsert({ ...base, summary: { status: "ready", text: fallback } });
      deps.publish();
      remember(base, fallback);
      pushWhen(owes, base, fallback);
      return;
    }
    // Listed at once with the plain sentence as its stand-in; the tool's
    // reply replaces it, or the stand-in is promoted when the tool fails. An
    // empty reply is the tool's choice of silence (`settleSentence`).
    deps.store.upsert({ ...base, summary: { status: "pending", fallback } });
    deps.publish();
    inFlight.add(base.eventId);
    // The run this one overtakes can no longer land: it is stopped, so its
    // slot is free for this one, and what it owed goes out with this
    // sentence, which covers its update too.
    const overtaken = runs.get(thread.id);
    let owesAny = owes;
    if (overtaken !== undefined) {
      overtaken.controller.abort();
      const owedBefore = owedPushes.get(overtaken.eventId);
      if (owedBefore !== undefined) {
        owedPushes.delete(overtaken.eventId);
        owesAny = Promise.all([owedBefore.owes, owes]).then(([before, mine]) => before || mine);
      }
    }
    owedPushes.set(base.eventId, { owes: owesAny, subject: base, fallback });
    const controller = new AbortController();
    const run = writeSentence(config.sentence, base, recording, controller.signal, overtaken?.done ?? null);
    const written = run.then(({ outcome }) => outcome);
    if (reason === "finished") {
      const run = { eventId: base.eventId, controller, done: written };
      runs.set(thread.id, run);
      void written.finally(() => {
        if (runs.get(thread.id) === run) runs.delete(thread.id);
      });
    } else {
      // Not one a newer run may stop; a finished turn's run before it was stopped above.
      runs.delete(thread.id);
    }
    // The notification goes with the event's own sentence, whatever became
    // of the entry meanwhile; `send` itself skips what is no longer news.
    void written.then((outcome) => sendOwed(base.eventId, pushSentence(reason, outcome, fallback)));
    void run
      .then(async ({ outcome, given }) => {
        if (!(await settleSentence(base.threadId, base.eventId, outcome, fallback, thread.latestAttentionAt))) return;
        // The tool's sentence or silence covered every update it was given;
        // the plain sentence, after a failure, only this event's own.
        if (outcome.kind === "failed") carried.withdraw(thread.id, recording.seq);
        else carried.covered(thread.id, recording.seq, given);
      })
      .catch((error: unknown) => deps.log.error(`Settling the sentence for ${base.threadId} failed: ${reasonOf(error)}`))
      .finally(() => inFlight.delete(base.eventId));
  }

  /**
   * What the tool wrote, its silence, or `failed` — with the reason logged —
   * and the earlier updates it was given. Never rejects. The run it overtook
   * (`overtaken`) is let go first, and the updates held for the thread are
   * read only once every earlier one is known to be one a tool writes for, or
   * not (`ELIGIBILITY_WAIT_MS` at most).
   */
  async function writeSentence(
    sentence: SentenceSettings,
    base: Omit<AttentionEntry, "summary">,
    recording: Recording,
    signal: AbortSignal,
    overtaken: Promise<unknown> | null,
  ): Promise<{ outcome: WriteOutcome; given: Carried }> {
    let earlier = NOTHING_EARLIER;
    try {
      const command = splitCommandLine(sentence.command);
      if (overtaken !== null) await stopped(overtaken);
      await carried.decided(base.threadId, recording.seq, ELIGIBILITY_WAIT_MS);
      if (signal.aborted) throw new Error("overtaken");
      earlier = carried.earlier(base.threadId, recording.seq);
      if (earlier.updates.length > 0) {
        const left = earlier.dropped > 0 ? `, ${earlier.dropped} older left out` : "";
        deps.log.info(`The sentence for ${base.threadId}'s ${base.reason} event also covers ${earlier.updates.length} earlier update(s) a newer one overtook${left}.`);
      }
      const prompt = fillTemplate(sentence.prompt, {
        thread: displayName(base),
        project: base.projectName,
        folder: base.folder,
        event: EVENT_PHRASES[base.reason],
        headline: cut(base.headline, PROMPT_PART_MAX),
        detail: cut(base.detail, PROMPT_PART_MAX),
        request: cut(recording.request, PROMPT_PART_MAX),
        output: combinedOutput(earlier, { event: EVENT_PHRASES[base.reason], output: cut(recording.output, PROMPT_OUTPUT_MAX) }),
      });
      const written = await deps.writeSentence(command, prompt, sentence.reply, signal);
      if (signal.aborted) throw new Error("overtaken");
      if (written.kind === "silent") deps.log.info(`The tool chose to say nothing for ${base.threadId}'s ${base.reason} event; Herald does not speak it.`);
      if (written.kind === "unspoken") {
        deps.log.info(
          waitsOnUser(base.reason)
            ? `The tool asked not to speak ${base.threadId}'s ${base.reason} event; it waits on the user, so Herald speaks it all the same.`
            : `The tool wrote ${base.threadId}'s ${base.reason} event down without speaking it; Herald remembers it, unspoken.`,
        );
      }
      return { outcome: written, given: earlier };
    } catch (error) {
      if (signal.aborted) deps.log.info(`The sentence for ${base.threadId}'s ${base.reason} event was stopped: a newer event's sentence covers it.`);
      else deps.log.warn(`The sentence for ${base.threadId} falls back to the plain one: ${reasonOf(error)}`);
      return { outcome: { kind: "failed" }, given: earlier };
    }
  }

  /** Waits for a stopped run to end, at most `OVERTAKEN_STOP_MS`. */
  async function stopped(run: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise((resolve) => (timer = setTimeout(resolve, OVERTAKEN_STOP_MS)))]);
    clearTimeout(timer);
  }

  /**
   * Lands a sentence on the entry it was written for — only while that entry
   * is still the one waiting. The thread may have moved on, or a newer event
   * may have replaced it; a sentence about an earlier event is stale news.
   * A question or approval the user answered meanwhile fired no event, so it
   * is asked about first: answered, the entry is withdrawn, unspoken.
   *
   * A tool that answered nothing keeps the event quiet: a finished turn
   * becomes `quiet` — unspoken, unlisted, not remembered, and its entry tells
   * the page to leave bb's unread flag for it alone, up to `attentionAt` (bb's
   * attention time for the thread as the event arrived); an event that waits
   * on the user stays listed with the plain sentence, as one not announced (`off`).
   * A sentence the tool asked not to speak lands on a finished turn as
   * `written` — listed and remembered like a spoken one, never spoken — and
   * on an event that waits on the user as `ready`, spoken as before.
   *
   * Resolves whether something landed — a sentence, the plain one, or the
   * tool's silence — rather than being dropped or withdrawn.
   */
  async function settleSentence(threadId: string, eventId: string, outcome: WriteOutcome, fallback: string, attentionAt: number): Promise<boolean> {
    const stillWaiting = () => {
      if (disposed) return null;
      const current = deps.store.get(threadId);
      return current !== null && current.eventId === eventId && current.summary.status === "pending" ? current : null;
    };
    const entry = stillWaiting();
    if (entry === null) return false;
    if (entry.requestId !== null && !(await stillPending(threadId, entry.requestId))) {
      // Checked again after the wait: the thread may have moved on meanwhile.
      if (stillWaiting() !== null && deps.store.remove(threadId) !== null) deps.publish();
      return false;
    }
    const current = stillWaiting();
    if (current === null) return false;
    if (outcome.kind === "silent") {
      deps.store.upsert({ ...current, summary: waitsOnUser(current.reason) ? { status: "off", fallback } : { status: "quiet", attentionAt } });
      deps.publish();
      return true;
    }
    if (outcome.kind === "unspoken" && !waitsOnUser(current.reason)) {
      deps.store.upsert({ ...current, summary: { status: "written", text: outcome.text } });
      deps.publish();
      remember(current, outcome.text);
      return true;
    }
    const text = outcome.kind === "failed" ? fallback : outcome.text;
    deps.store.upsert({ ...current, summary: { status: "ready", text } });
    deps.publish();
    remember(current, text);
    return true;
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
        // Held before any lookup, in the order turns ended (`carry.ts`), and
        // known to be one a tool writes for from the config and the choice
        // alone: a later run waits for that, never for the context lookup.
        const configRead = deps.readConfig();
        const choiceRead = choiceOf(thread);
        const eligible = Promise.all([configRead, choiceRead]).then(
          ([config, choice]) => config.sentence !== null && isAnnounced(thread, "finished", config, choice),
        );
        const seq = carried.arrive(thread.id, { event: EVENT_PHRASES.finished, output: cut(output, PROMPT_OUTPUT_MAX) ?? output }, eligible);
        try {
          const event = beginEvent(thread.id);
          const generation = generationOf(thread.id);
          const [config, context, choice] = await Promise.all([configRead, deps.events.context(thread, { withRequest: true }), choiceRead]);
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
            request: context.turnRequest ?? context.lastRequest,
            at,
            token,
            seq,
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
      const seq = carried.arrive(thread.id, null);
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
            request: context.turnRequest ?? context.lastRequest,
            at,
            token,
            seq,
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
      const seq = carried.arrive(thread.id, null);
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
            request: null,
            at,
            token,
            seq,
          });
        } finally {
          arrivals.delete(token);
        }
      });
    },

    gone(thread) {
      movedOn(thread.id);
      recentIdles.delete(thread.id);
      carried.forget(thread.id);
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
      // storage and calls, and there may be no next instance (a disable, a
      // removal). So each such event is decided now, from the records as
      // they stand — no level changes — and sent with the plain sentence.
      for (const arrival of arrivals.values()) {
        if (arrival.settled || deps.push === undefined) continue;
        arrival.settled = true;
        pushWhen(deps.push.decide(arrival.subject.threadId, () => Promise.resolve("silent"), arrival.event, false), arrival.subject, arrival.fallback);
      }
      for (const [eventId, { fallback }] of [...owedPushes]) sendOwed(eventId, fallback);
      // Their own window: the lookups may have used all of the first.
      await drain(pushesRunning, Date.now() + DISPOSE_DRAIN_MS);
    },
  };
}

