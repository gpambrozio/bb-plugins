/**
 * One voice session: a WebRTC call to OpenAI Realtime whose audio runs device ⇄ OpenAI, while this server
 * holds the call's sideband for the tools, the greeting and the announcements. Adapted from
 * firstmate-voice's session (same call, renewal, idle end and hooks), with bb's own threads in place of the
 * first mate's board.
 *
 * - **It speaks first.** As soon as the sideband is open, the tools are set, the running threads go in as an
 *   item (`greeting.ts`) and a greeting is asked for: no word from you is needed.
 * - **One live session.** `VoiceSessions` keeps at most one; a new Talk takes over from the old.
 * - **Renewal at the cap.** OpenAI ends a session at 60 minutes. At 57 the app is asked for a new offer, a
 *   second call is made with the same config, seeded with a recap, and the first call is hung up once the
 *   app's new leg connected.
 * - **The idle end.** Ten minutes with no speech, no response and no announcement end the session.
 * - **Hang up from the server,** and treat a call that already ended as ended.
 * - **Paused, not ended, on the phone.** bb's mobile app is suspended when it leaves the screen, which cuts
 *   the microphone and the audio. A session started there (`pausable`) is paused instead: its call is hung
 *   up (no voice time is spent) and the session keeps what it knows (the recent talk, the numbered links,
 *   the threads it sent to, the news that came meanwhile). When the app comes back it sends a new offer
 *   (`resume`): a new call, seeded with a recap, says it is back and then the news. A pause that lasts
 *   `PAUSE_END_MS` ends the session. A phone that went before it could say so (no heartbeat, or the call
 *   gone) is paused the same way.
 * - Transcripts live in memory for the session only, and never reach the plugin log. The debug log
 *   (`debug-log.ts`) keeps them, with everything else, in memory until the next Talk, for the app only.
 * - **The voice hooks** (`hooks.ts`) run the owner's hook file on their machine as listening, the voice's
 *   speech and your talking start and stop, from the same sideband events; nothing here waits for them.
 */
import { Announcer, finishedAnnouncement, newsAnnouncement, newsItem, type ThreadNews } from "./announce";
import type { BbPort, ThreadInfo } from "./bb-port";
import { DebugLog, EMPTY_DEBUG_PAGE, type DebugPage } from "./debug-log";
import { greetingItem } from "./greeting";
import type { HookRunner, HookTarget, SessionHooks } from "./hooks";
import { GREETING_NOW, RENEWAL_NOTE, RESUME_NOTE, RESUME_NOW, standingInstructions } from "./instructions";
import { UtteranceLog, isNoise } from "./policy";
import { errorText, type Clock, type Log, type RealtimeEvent, type RealtimePort, type Sideband } from "./ports";
import { LinkList, parts, readableReply } from "./rich";
import { VoiceTools, realtimeTools } from "./tools";

export const RENEW_AFTER_MS = 57 * 60_000;
/** How long the app has to send a renewal offer before the session ends. */
export const RENEW_GRACE_MS = 2 * 60_000;
/** How long the app has, once the renewal's call is made, to say its new leg connected before the session ends. */
export const RENEW_ACK_MS = 30_000;
export const IDLE_END_MS = 10 * 60_000;
export const IDLE_CHECK_MS = 15_000;
/** A session the app has not said it holds for this long ends (the app says so every `ALIVE_EVERY_MS`). */
export const ALIVE_TIMEOUT_MS = 50_000;
/** After end_session, long enough for the goodbye to be heard. */
export const GOODBYE_MS = 2_500;
const SIDEBAND_RETRIES = 2;
/** How long a response this side asked for may take to start before announcements stop waiting for it. */
const STUCK_RESPONSE_MS = 20_000;
export const TOOL_OUTPUT_MAX = 4_000;
/** The most of a finished turn's reply put in the conversation; read_reply has the rest. */
export const FINISHED_REPLY_CHARS = 4_000;
const RECAP_ITEMS = 10;
/** A paused session ends after this long away. */
export const PAUSE_END_MS = 30 * 60_000;
/** The most news kept for a paused session, to be told on its return. */
const MISSED_MAX = 20;
/** How long a turn's transcript is waited for before announcements stop waiting. */
export const WORDS_WAIT_MS = 6_000;

export type Eagerness = "low" | "medium" | "high" | "auto";
/** Which thread news is said while a session is live. */
export type AnnounceLevel = "talked-to" | "all" | "off";

export interface SessionConfig {
  model: string;
  effort: string;
  voice: string;
  eagerness: Eagerness;
  /** The owner's part of the standing instructions; blank for the default. */
  instructions: string;
  announce: AnnounceLevel;
}

/** Why a call is made: the session's start, the hour's renewal, or the app back on the screen after a pause. */
type CallReason = "start" | "renew" | "resume";
const CALL_REASONS: Record<CallReason, string> = { start: "the start", renew: "a renewal", resume: "back from a pause" };

/** The session a call is created with. Tools follow on the sideband. */
export function callSession(config: SessionConfig): Record<string, unknown> {
  return {
    type: "realtime",
    model: config.model,
    instructions: standingInstructions(config.instructions),
    reasoning: { effort: config.effort },
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        // Laptop and phone speakers are the usual case; echo cancellation in the browser does the rest.
        noise_reduction: { type: "far_field" },
        // The server does not answer a turn by itself: background noise can pass for speech, and a turn whose
        // transcript has no words is not answered (`VoiceSession.heard`).
        turn_detection: { type: "semantic_vad", eagerness: config.eagerness, create_response: false, interrupt_response: true },
      },
      output: { voice: config.voice },
    },
  };
}

/** What the server tells the app about a session, on the realtime channel. */
export type SessionSignal =
  | { sessionId: string; type: "state"; state: "live" | "paused" | "ended"; reason?: string }
  | { sessionId: string; type: "renew" }
  | { sessionId: string; type: "open"; threadId: string; label?: string }
  | { sessionId: string; type: "open-link"; url: string; label: string }
  | { sessionId: string; type: "mute" };

export interface SessionDeps {
  realtime: RealtimePort;
  bb: BbPort;
  clock: Clock;
  log: Log;
  publish(signal: SessionSignal): void;
  /** The voice hooks; none in tests that do not need them. */
  hooks?: HookRunner;
}

/** How long a plugin that stops waits for the last session's closing hooks. */
export const HOOKS_DISPOSE_WAIT_MS = 3_000;

type Exchange = { at: number; who: "user" | "voice"; text: string };

/** What this side sent on the sideband, for the debug log; a tool's answer is logged with its name instead. */
function traceSent(debug: DebugLog, event: Record<string, unknown>, standing: string): void {
  switch (event.type) {
    case "session.update":
      debug.add("briefing", "Tools set on the call", JSON.stringify(event.session, null, 2));
      break;
    case "conversation.item.create": {
      const item = event.item as { id?: unknown; type?: unknown; content?: { text?: unknown }[] } | undefined;
      if (item?.type !== "message") break;
      const text = (item.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
      debug.add("context", `Put in the conversation${typeof item.id === "string" ? ` as ${item.id}` : ""}`, text);
      break;
    }
    case "response.create": {
      const response = event.response as { instructions?: unknown; metadata?: { vp_announcement?: unknown } } | undefined;
      const instructions = typeof response?.instructions === "string" ? response.instructions : undefined;
      const now = instructions?.startsWith(standing) === true ? instructions.slice(standing.length) : instructions;
      const announcement = response?.metadata?.vp_announcement;
      if (typeof announcement === "string") debug.add("announce", `Announcement ${announcement} asked for (the standing instructions, then this)`, now);
      else if (event.event_id === "vp_greeting") debug.add("briefing", "Greeting asked for (the standing instructions, then this)", now);
      else if (event.event_id === "vp_resume") debug.add("briefing", "The cue that the voice is back asked for (the standing instructions, then this)", now);
      else if (typeof event.event_id === "string" && event.event_id.startsWith("vp_turn_")) debug.add("turn", "Asked for the response to what you said");
      else debug.add("turn", "Asked for the response that reads the tool's answer");
      break;
    }
    default:
      break;
  }
}

/** JSON laid out to read, or the text as it was. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One Realtime call within a session: its sideband and everything tied to the call's own conversation. */
class Call {
  sideband: Sideband | null = null;
  open = false;
  retries = 0;
  ending = false;
  readonly announcer: Announcer;
  /** When each response started, by id: a tool counts only your words said before the response that called it. */
  readonly responses = new Map<string, number>();
  /** Responses this side made to announce something. */
  readonly announcements = new Map<string, string>();
  lastResponseId: string | null = null;
  activeResponses = 0;
  /** A tool's output is in; the response that reads it waits for the one under way to finish. */
  pendingCreate = false;
  /** When this side last asked for a response that has not started yet; null when none is outstanding. */
  askedAt: number | null = null;
  /** The user is talking, by the server's speech detection. */
  userTalking = false;
  /** Turns that ended and whose transcript has not come yet, oldest first: announcements wait for them. */
  awaitingWords: number[] = [];
  turnCount = 0;
  /** Words heard while the user went on talking: answered at the end of their next turn. */
  wordsPending = false;
  counter = 0;

  constructor(
    readonly callId: string,
    readonly session: VoiceSession,
  ) {
    this.announcer = new Announcer({
      respond: (instructions, id) =>
        this.send({
          type: "response.create",
          event_id: `${id}_rc`,
          response: { instructions: `${session.standing}\n\nNow: ${instructions}`, metadata: { vp_announcement: id } },
        }),
    });
  }

  send(event: Record<string, unknown>): void {
    if (this.sideband === null || !this.open) {
      this.session.debug.add("error", `Not sent, the connection to OpenAI is closed: ${event.type}`);
      return;
    }
    if (event.type === "response.create") this.askedAt = this.session.clock.now();
    this.sideband.send(event);
    traceSent(this.session.debug, event, `${this.session.standing}\n\nNow: `);
  }

  addItem(text: string): void {
    this.counter += 1;
    this.send({ type: "conversation.item.create", item: { id: `vp_item_${this.counter}`, type: "message", role: "system", content: [{ type: "input_text", text }] } });
  }

  /** Asks for the response that reads a tool's output, now or once the one under way has finished. */
  respondToTool(): void {
    this.respond("vp_tool_");
  }

  /** Asks for the response to what the user said, now or once the one under way has finished. */
  respondToUser(): void {
    this.respond("vp_turn_");
  }

  private respond(prefix: string): void {
    if (this.activeResponses > 0) {
      this.pendingCreate = true;
      return;
    }
    this.announcer.responseStarted();
    this.send({ type: "response.create", event_id: `${prefix}${++this.counter}` });
  }
}

export class VoiceSession {
  readonly utterances: UtteranceLog;
  readonly clock: Clock;
  readonly standing: string;
  private readonly tools: VoiceTools;
  private call: Call | null = null;
  private retiring: Call | null = null;
  private ended = false;
  private lastActivity: number;
  /** When the app last said it still holds the call: a closed tab or a suspended phone stops saying so. */
  private lastAlive: number;
  private readonly timers = new Set<unknown>();
  private renewTimer: unknown = null;
  private readonly exchanges: Exchange[] = [];
  /** The thread on the screen of the window holding the call, as the app last said. */
  private focusedThread: string | null = null;
  /** Threads this session sent to or started: their finished turns are announced. */
  private readonly touched = new Set<string>();
  /** Interactions already announced, so each is said once. */
  private readonly announcedWaits = new Set<string>();
  /** Every link read in this session, numbered: replies read with read_reply and finished turns' replies. */
  private readonly links = new LinkList();
  /** Whether leaving the screen pauses this session rather than ending it: one started in bb's mobile app. */
  pausable = false;
  /** When the session was paused; null while it is not. */
  private pausedAt: number | null = null;
  /** News that came while paused, to be put to the next call when the app comes back. */
  private missed: ((call: Call) => void)[] = [];

  constructor(
    readonly id: string,
    private readonly deps: SessionDeps,
    private readonly config: SessionConfig,
    private readonly onEnded: (session: VoiceSession) => void,
    /** Everything this session got and did, for the app's debug view. */
    readonly debug: DebugLog = new DebugLog(id, deps.clock.now(), () => deps.clock.now()),
    /** This session's voice hooks, on the machine whose app holds the call; null runs none. */
    private readonly hooks: SessionHooks | null = null,
  ) {
    this.clock = deps.clock;
    this.standing = standingInstructions(config.instructions);
    this.utterances = new UtteranceLog(deps.clock);
    this.lastActivity = deps.clock.now();
    this.lastAlive = deps.clock.now();
    this.tools = new VoiceTools({
      bb: deps.bb,
      sent: (threadId) => this.touched.add(threadId),
      requestStart: (askedAt) => this.requestStart(askedAt),
      clock: deps.clock,
      debug: this.debug,
      words: (from, to) => this.utterances.between(from, to),
      open: (threadId, label) => {
        this.debug.add("session", `Showing a thread in the window holding the call: ${threadId}`);
        this.deps.publish({ sessionId: this.id, type: "open", threadId, ...(label === undefined ? {} : { label }) });
      },
      openLink: (url, label) => this.deps.publish({ sessionId: this.id, type: "open-link", url, label }),
      mute: () => this.deps.publish({ sessionId: this.id, type: "mute" }),
      links: this.links,
      focused: () => this.focusedThread,
      end: () => this.later(GOODBYE_MS, () => void this.end("ended by voice")),
    });
  }

  /** The start of the last response before you last spoke by `askedAt`: where the words of your request begin. */
  private requestStart(askedAt: number): number {
    const spoke = this.utterances.lastCommitBefore(askedAt);
    if (spoke === null) return askedAt;
    const starts = [...(this.call?.responses.values() ?? [])].filter((start) => start < spoke);
    return starts.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...starts);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  /** Makes the first call. Answers the SDP answer for the device. */
  async start(sdp: string): Promise<string> {
    const { model, effort, voice, eagerness } = this.config;
    this.debug.add("session", "Listening started", `Model ${model}, reasoning ${effort}, voice ${voice}, turn taking ${eagerness}.`);
    const answer = await this.openCall(sdp, "start");
    // Only once OpenAI has made the call: a start with no real offer or no credential runs no hook.
    this.hooks?.start();
    this.every(IDLE_CHECK_MS, () => this.checkIdle());
    this.deps.publish({ sessionId: this.id, type: "state", state: "live" });
    return answer;
  }

  /**
   * A second call at the time cap, from the app's new offer. The first is hung up only once the app says its
   * new leg connected (`renewed`); a renewal the device cannot connect ends the session within `RENEW_ACK_MS`.
   */
  async renew(sdp: string): Promise<string> {
    if (this.ended) throw new Error("This voice session has ended.");
    if (this.pausedAt !== null) throw new Error("This voice session is paused.");
    const previous = this.call;
    this.debug.add("session", "The app sent a renewal offer");
    if (this.retiring !== null) {
      // A second offer while one renewal is unconfirmed: that unconfirmed call goes, the original stays.
      if (previous !== null) await this.hangup(previous);
    } else {
      if (previous !== null) previous.ending = true;
      this.retiring = previous;
    }
    return this.openCall(sdp, "renew");
  }

  /** The app's new leg connected: retire the old call and start the next hour. */
  async renewed(): Promise<void> {
    if (this.ended || this.retiring === null) return;
    const retiring = this.retiring;
    this.retiring = null;
    if (this.renewTimer !== null) this.clock.clearTimeout(this.renewTimer);
    this.renewTimer = this.clock.setTimeout(() => this.askRenewal(), RENEW_AFTER_MS);
    this.debug.add("session", "The renewal's leg connected on the device; the old call is hung up");
    await this.hangup(retiring);
  }

  /** The app still holds the call; `threadId` is the thread on its screen now, if any. */
  alive(threadId?: string | null): void {
    this.lastAlive = this.clock.now();
    if (threadId !== undefined) this.focusedThread = threadId;
  }

  /** The thread on the screen of the window holding the call changed. */
  focus(threadId: string | null): void {
    this.focusedThread = threadId;
  }

  /**
   * Something happened to a thread: said at the next gap when the Announce setting covers it. A thread
   * waiting on you is said once per interaction; a finished turn only for root threads (`all`) or threads
   * this session sent to or started (`talked-to`), told from the turn's reply (`reply`, else read from bb),
   * which goes in the conversation in full first.
   */
  async news(news: ThreadNews, threadId: string, interactionId?: string, reply?: string | null): Promise<void> {
    if (this.ended || this.config.announce === "off") return;
    if (news === "waiting") {
      const key = `${threadId}/${interactionId ?? ""}`;
      if (this.announcedWaits.has(key)) return;
      this.announcedWaits.add(key);
    }
    let thread;
    try {
      thread = await this.deps.bb.thread(threadId);
    } catch (error) {
      this.debug.add("error", `Could not read the thread to announce it (${news})`, errorText(error));
      return;
    }
    if (thread === null || this.ended) return;
    if (news === "finished" && !this.touched.has(threadId) && !(this.config.announce === "all" && thread.isRoot)) return;
    if (news === "finished") return this.finished(thread, reply);
    this.onCall((call) => {
      const id = call.announcer.enqueue(newsAnnouncement(news, thread.title, thread.project));
      this.debug.add("announce", `Queued announcement ${id}: "${thread.title}" ${news}`);
    });
  }

  /**
   * A finished turn: its reply in the conversation, in full up to `FINISHED_REPLY_CHARS`, then the
   * announcement. `given` is the idle event's reply: null when the turn wrote none (a compaction, a turn
   * stopped first), which is not then filled in from an earlier turn; read from bb only when not given.
   */
  private async finished(thread: ThreadInfo, given: string | null | undefined): Promise<void> {
    let reply = given ?? null;
    if (given === undefined) {
      try {
        reply = await this.deps.bb.reply(thread.id);
      } catch (error) {
        this.debug.add("error", `Could not read the finished turn's reply of "${thread.title}"`, errorText(error));
        reply = null;
      }
    }
    if (this.ended || (this.call === null && this.pausedAt === null)) return;
    // Read now, so its links keep their numbers whenever it is told.
    const text = reply === null ? "" : readableReply(reply, this.links).text;
    const withReply = text !== "";
    this.onCall((call) => {
      if (withReply) {
        const [head = "", ...rest] = parts(text, FINISHED_REPLY_CHARS);
        call.addItem(newsItem(thread.title, thread.project, head, rest.length > 0));
      }
      const turn = { title: thread.title, project: thread.project, withReply };
      const id = call.announcer.enqueue(finishedAnnouncement([turn]), turn);
      this.debug.add("announce", `Queued announcement ${id}: "${thread.title}" finished${withReply ? ", with its reply" : ", no reply to tell"}`);
    });
  }

  /**
   * bb left the phone's screen (`reason` says how it was noticed): the calls are hung up and the session waits
   * for the app to come back. Answers whether the session is paused; one that is not `pausable` is not.
   */
  async pause(reason: string): Promise<boolean> {
    if (this.ended || !this.pausable) return false;
    if (this.pausedAt !== null && this.call === null) return true;
    this.pausedAt ??= this.clock.now();
    if (this.renewTimer !== null) this.clock.clearTimeout(this.renewTimer);
    this.renewTimer = null;
    const calls = [this.call, this.retiring].filter((call): call is Call => call !== null);
    this.call = null;
    this.retiring = null;
    this.debug.add("session", `Paused: ${reason}. It picks up when bb is back on the screen`);
    this.deps.log.info(`Voice session ${this.id} paused: ${reason}.`);
    this.deps.publish({ sessionId: this.id, type: "state", state: "paused", reason });
    await Promise.all(calls.map((call) => this.hangup(call)));
    return true;
  }

  /**
   * The app is back with a new offer: a new call, seeded with the recent talk and the news that came while
   * away, which says it is back. An app that went away without the pause reaching the server resumes the
   * same way: the call it left is hung up first.
   */
  async resume(sdp: string): Promise<string> {
    if (this.ended) throw new Error("This voice session has ended.");
    const away = this.pausedAt === null ? null : this.clock.now() - this.pausedAt;
    // Paused until the new call is primed: news that comes meanwhile waits for it.
    this.pausedAt ??= this.clock.now();
    const calls = [this.call, this.retiring].filter((call): call is Call => call !== null);
    this.call = null;
    this.retiring = null;
    await Promise.all(calls.map((call) => this.hangup(call)));
    this.debug.add("session", `The app is back${away === null ? "" : ` after ${Math.round(away / 1000)} s`}: a new call picks the session up`);
    const answer = await this.openCall(sdp, "resume");
    this.lastAlive = this.clock.now();
    this.deps.publish({ sessionId: this.id, type: "state", state: "live" });
    return answer;
  }

  /** Runs `fn` on the live call, or keeps it for the next one while paused. */
  private onCall(fn: (call: Call) => void): void {
    if (this.call !== null && this.pausedAt === null) return fn(this.call);
    if (this.pausedAt === null) return;
    this.missed.push(fn);
    if (this.missed.length > MISSED_MAX) this.missed.shift();
  }

  async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    // Not awaited: a hook never holds the call up. `VoiceSessions.dispose` waits for it, briefly.
    void this.hooks?.end(reason);
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    if (this.renewTimer !== null) this.clock.clearTimeout(this.renewTimer);
    const calls = [this.call, this.retiring].filter((call): call is Call => call !== null);
    this.call = null;
    this.retiring = null;
    await Promise.all(calls.map((call) => this.hangup(call)));
    this.debug.add("session", `The session ended: ${reason}`);
    this.deps.log.info(`Voice session ${this.id} ended: ${reason}.`);
    this.deps.publish({ sessionId: this.id, type: "state", state: "ended", reason });
    this.onEnded(this);
  }

  // --- Calls -----------------------------------------------------------------------------------------

  private async openCall(sdp: string, why: CallReason): Promise<string> {
    const session = callSession(this.config);
    let made: { callId: string; answerSdp: string; connection?: string };
    try {
      made = await this.deps.realtime.createCall({ sdp, session });
    } catch (error) {
      this.debug.add("error", "OpenAI did not make the call", errorText(error));
      throw error;
    }
    const { callId, answerSdp } = made;
    const { instructions, ...rest } = session;
    const over = made.connection === undefined ? "" : ` over the ${made.connection === "api-key" ? "OpenAI API key" : "ChatGPT subscription"}`;
    this.debug.add("briefing", `Call ${callId} made (${CALL_REASONS[why]})${over}, with this session`, JSON.stringify(rest, null, 2));
    this.debug.add("briefing", "Standing instructions", String(instructions));
    if (this.ended) {
      void this.deps.realtime.hangup(callId).catch(() => undefined);
      throw new Error("The voice session ended while the call was being made.");
    }
    const call = new Call(callId, this);
    this.call = call;
    this.deps.log.info(`Voice session ${this.id}: call ${callId} made (${why})${over}, model ${this.config.model}, reasoning ${this.config.effort}.`);
    this.openSideband(call, why);
    if (this.renewTimer !== null) this.clock.clearTimeout(this.renewTimer);
    this.renewTimer =
      why !== "renew"
        ? this.clock.setTimeout(() => this.askRenewal(), RENEW_AFTER_MS)
        : this.clock.setTimeout(() => void this.end("the renewal did not connect on the device"), RENEW_ACK_MS);
    return answerSdp;
  }

  private askRenewal(): void {
    if (this.ended) return;
    this.debug.add("session", "The hour's cap is near: the app is asked for a renewal");
    this.deps.publish({ sessionId: this.id, type: "renew" });
    this.renewTimer = this.clock.setTimeout(() => void this.end("the hour's time limit came with no renewal"), RENEW_GRACE_MS);
  }

  private openSideband(call: Call, why: CallReason): void {
    call.sideband = this.deps.realtime.openSideband(call.callId, {
      onOpen: () => {
        call.open = true;
        if (call.retries === 0) void this.prime(call, why);
        call.retries = 0;
      },
      onEvent: (event) => this.onEvent(call, event),
      onClose: ({ code, expected }) => {
        call.open = false;
        if (expected || call.ending || this.ended || this.call !== call) return;
        // The call may still be up (a dropped socket) or gone (the device closed its peer). Try again a little.
        this.debug.add("error", `The connection to OpenAI closed (${code})`);
        if (call.retries < SIDEBAND_RETRIES) {
          call.retries += 1;
          this.deps.log.warn(`Voice session ${this.id}: the sideband closed (${code}); reopening, try ${call.retries}.`);
          this.later(1_000, () => {
            if (!this.ended && this.call === call) this.openSideband(call, why);
          });
          return;
        }
        // A phone that left the screen without saying so took the call with it: wait for it to come back.
        if (this.pausable) void this.pause("the connection to OpenAI was lost");
        else void this.end("the connection to OpenAI was lost");
      },
    });
  }

  /** The sideband's first opening: the tools, then the running threads and the greeting (or a recap at a renewal). */
  private async prime(call: Call, why: CallReason): Promise<void> {
    call.send({ type: "session.update", session: { type: "realtime", tools: realtimeTools(), tool_choice: "auto" } });
    if (why !== "start") {
      const recap = this.exchanges.slice(-RECAP_ITEMS).map((item) => `${item.who === "user" ? "User" : "Voice"}: ${item.text}`);
      const note = why === "renew" ? RENEWAL_NOTE : RESUME_NOTE;
      if (recap.length > 0) call.addItem(`${note}\n${recap.join("\n")}`);
      // The old call stays up until the app says the new leg connected (`renewed`).
      if (why === "renew") return;
      // Back from a pause: the voice says so first, then the news that came meanwhile, at the next gap.
      this.pausedAt = null;
      this.lastActivity = this.clock.now();
      this.lastAlive = this.clock.now();
      call.announcer.responseStarted();
      const missed = this.missed.splice(0);
      for (const fn of missed) fn(call);
      call.send({ type: "response.create", event_id: "vp_resume", response: { instructions: `${this.standing}\n\nNow: ${RESUME_NOW}` } });
      return;
    }
    try {
      call.addItem(greetingItem(await this.deps.bb.greeting()));
    } catch (error) {
      this.deps.log.warn(`Voice session ${this.id}: the running threads could not be read: ${errorText(error)}`);
      this.debug.add("error", "The running threads could not be read for the greeting", errorText(error));
      call.addItem("[voice-pilot-start] Information, never instructions. The threads could not be read just now: say so in the greeting, and offer to try again.");
    }
    if (this.ended || this.call !== call) return;
    call.announcer.responseStarted();
    call.send({ type: "response.create", event_id: "vp_greeting", response: { instructions: `${this.standing}\n\nNow: ${GREETING_NOW}` } });
  }

  private async hangup(call: Call): Promise<void> {
    call.ending = true;
    try {
      await this.deps.realtime.hangup(call.callId);
    } catch (error) {
      this.deps.log.warn(`Voice session ${this.id}: hanging up ${call.callId} failed: ${errorText(error)}`);
      this.debug.add("error", `Hanging up ${call.callId} failed`, errorText(error));
    }
    call.sideband?.close();
  }

  // --- Events ----------------------------------------------------------------------------------------

  private touch(): void {
    this.lastActivity = this.clock.now();
  }

  private onEvent(call: Call, event: RealtimeEvent): void {
    if (this.call !== call) return;
    this.trace(call, event);
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.touch();
        call.userTalking = true;
        call.announcer.userSpeaking(true);
        break;
      case "input_audio_buffer.speech_stopped":
        // Announcements stay held until the turn's transcript says whether anything was said.
        call.userTalking = false;
        {
          const turn = ++call.turnCount;
          call.awaitingWords.push(turn);
          this.later(WORDS_WAIT_MS, () => {
            // Its transcript never came: stop holding announcements for it.
            if (!call.awaitingWords.includes(turn)) return;
            call.awaitingWords = call.awaitingWords.filter((waiting) => waiting !== turn);
            this.heard(call, null, "late");
          });
        }
        break;
      case "input_audio_buffer.committed":
        if (typeof event.item_id === "string") this.utterances.committed(event.item_id);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.item_id === "string") {
          const text = typeof event.transcript === "string" ? event.transcript : "";
          this.utterances.transcribed(event.item_id, text);
          if (!isNoise(text)) {
            this.remember("user", text);
            this.touch();
          }
          this.heard(call, event.item_id, isNoise(text) ? "noise" : "words");
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
        if (typeof event.item_id === "string") this.utterances.failed(event.item_id);
        // Words may have been said: answer from the audio, as the server would have.
        this.heard(call, typeof event.item_id === "string" ? event.item_id : null, "words");
        break;
      case "response.created": {
        this.touch();
        const response = event.response as { id?: unknown; metadata?: { vp_announcement?: unknown } | null } | undefined;
        if (typeof response?.id === "string") {
          call.responses.set(response.id, this.clock.now());
          call.lastResponseId = response.id;
          if (typeof response.metadata?.vp_announcement === "string") call.announcements.set(response.id, response.metadata.vp_announcement);
        }
        call.activeResponses += 1;
        call.askedAt = null;
        call.announcer.responseStarted();
        break;
      }
      case "response.done": {
        this.touch();
        const response = event.response as { id?: unknown; status?: unknown; metadata?: { vp_announcement?: unknown } | null } | undefined;
        call.activeResponses = Math.max(0, call.activeResponses - 1);
        const announcement = typeof response?.metadata?.vp_announcement === "string" ? response.metadata.vp_announcement : null;
        if (announcement !== null && typeof response?.id === "string") call.announcements.set(response.id, announcement);
        const status = typeof response?.status === "string" ? response.status : "completed";
        if (call.pendingCreate && call.activeResponses === 0) {
          call.pendingCreate = false;
          call.announcer.responseDone(status, announcement, true);
          call.send({ type: "response.create", event_id: `vp_tool_${++call.counter}` });
        } else {
          call.announcer.responseDone(status, announcement, call.activeResponses > 0);
        }
        break;
      }
      case "response.output_audio_transcript.done":
        if (typeof event.transcript === "string") this.remember("voice", event.transcript);
        break;
      case "output_audio_buffer.started":
        call.announcer.audio(true);
        break;
      case "output_audio_buffer.stopped": {
        const responseId = typeof event.response_id === "string" ? event.response_id : call.lastResponseId;
        call.announcer.audioEnded(false, responseId === null ? null : (call.announcements.get(responseId) ?? null));
        break;
      }
      case "output_audio_buffer.cleared": {
        const responseId = typeof event.response_id === "string" ? event.response_id : call.lastResponseId;
        call.announcer.audioEnded(true, responseId === null ? null : (call.announcements.get(responseId) ?? null));
        break;
      }
      case "response.function_call_arguments.done":
        void this.runTool(call, event);
        break;
      case "error": {
        const error = event.error as { code?: unknown; message?: unknown; event_id?: unknown } | undefined;
        const eventId = typeof error?.event_id === "string" ? error.event_id : "";
        this.deps.log.warn(`Voice session ${this.id}: OpenAI error ${String(error?.code ?? "?")} on ${eventId || "an event"}.`);
        if (eventId.startsWith("vp_")) {
          call.askedAt = null;
          // A tool's response waits for the one under way; anything else of ours did not start after all.
          if (error?.code === "conversation_already_has_active_response" && (eventId.startsWith("vp_tool_") || eventId.startsWith("vp_turn_"))) call.pendingCreate = true;
          else call.announcer.refused();
        }
        break;
      }
      default:
        break;
    }
    this.hooks?.event(event, call.activeResponses > 0);
  }

  /**
   * A turn's transcript came (`words` or `noise`), or never did (`late`, after `WORDS_WAIT_MS`). Words are
   * answered, unless the user is talking again: then their next turn's end answers both. Noise is not
   * answered, and its item leaves the conversation, so the model never hears it as a turn. Either way the
   * announcements held for the transcript may go.
   */
  private heard(call: Call, itemId: string | null, what: "words" | "noise" | "late"): void {
    if (this.call !== call || this.ended) return;
    if (what !== "late") call.awaitingWords.shift();
    if (what === "noise" && itemId !== null) call.send({ type: "conversation.item.delete", item_id: itemId });
    if (what === "words") call.wordsPending = true;
    const settled = !call.userTalking && call.awaitingWords.length === 0;
    if (call.wordsPending && settled) {
      call.wordsPending = false;
      call.respondToUser();
    }
    if (settled) call.announcer.userSpeaking(false);
  }

  /** A call event, for the debug log: what was heard and said, turns, interruptions, tool calls and errors. */
  private trace(call: Call, event: RealtimeEvent): void {
    const debug = this.debug;
    const responseId = typeof event.response_id === "string" ? event.response_id : call.lastResponseId;
    const announcement = responseId === null ? undefined : call.announcements.get(responseId);
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        debug.add("turn", "You started speaking");
        break;
      case "input_audio_buffer.speech_stopped":
        debug.add("turn", "You stopped speaking");
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof event.transcript === "string" ? event.transcript : "";
        if (isNoise(text)) debug.add("turn", "Ignored: only noise was heard, no words, so no answer", text.trim() === "" ? undefined : text);
        else debug.add("heard", "You said", text);
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        debug.add("error", "Your words could not be transcribed", event.error === undefined ? undefined : JSON.stringify(event.error));
        break;
      case "response.created": {
        const response = event.response as { id?: unknown; metadata?: { vp_announcement?: unknown } | null } | undefined;
        const mark = typeof response?.metadata?.vp_announcement === "string" ? ` (announcement ${response.metadata.vp_announcement})` : "";
        debug.add("turn", `Response ${String(response?.id ?? "?")} started${mark}`);
        break;
      }
      case "response.done": {
        const response = event.response as { id?: unknown; status?: unknown; status_details?: unknown } | undefined;
        const status = typeof response?.status === "string" ? response.status : "completed";
        const details = response?.status_details == null ? undefined : JSON.stringify(response.status_details);
        const title = `Response ${String(response?.id ?? "?")} ${status}`;
        if (status === "completed") debug.add("turn", title);
        else if (status === "cancelled" || status === "incomplete") debug.add("interrupted", title, details);
        else debug.add("error", title, details);
        break;
      }
      case "response.output_audio_transcript.done": {
        if (typeof event.transcript !== "string") break;
        debug.add("said", `The voice said${announcement !== undefined ? ` (announcement ${announcement})` : ""}`, event.transcript);
        break;
      }
      case "output_audio_buffer.started":
        debug.add("turn", "The voice's audio started");
        break;
      case "output_audio_buffer.stopped":
        debug.add("turn", "The voice's audio stopped");
        break;
      case "output_audio_buffer.cleared":
        debug.add("interrupted", `You talked over the voice; its audio was cut${announcement !== undefined ? ` (announcement ${announcement}, said again once)` : ""}`);
        break;
      case "response.function_call_arguments.done": {
        let args = typeof event.arguments === "string" ? event.arguments : "";
        try {
          args = JSON.stringify(JSON.parse(args), null, 2);
        } catch {
          // Shown as it came.
        }
        debug.add("tool-call", `Tool call: ${typeof event.name === "string" ? event.name : "?"}`, args);
        break;
      }
      case "error": {
        const error = event.error as { code?: unknown; message?: unknown; event_id?: unknown } | undefined;
        debug.add("error", `OpenAI error ${String(error?.code ?? "?")}${typeof error?.event_id === "string" ? ` on ${error.event_id}` : ""}`, typeof error?.message === "string" ? error.message : undefined);
        break;
      }
      default:
        break;
    }
  }

  private remember(who: Exchange["who"], text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.exchanges.push({ at: this.clock.now(), who, text: trimmed.slice(0, 400) });
    if (this.exchanges.length > 2 * RECAP_ITEMS) this.exchanges.shift();
  }

  private checkIdle(): void {
    if (this.pausedAt !== null) {
      if (this.clock.now() - this.pausedAt >= PAUSE_END_MS) void this.end("bb was away for thirty minutes");
      return;
    }
    if (this.clock.now() - this.lastActivity >= IDLE_END_MS) {
      void this.end("quiet for ten minutes");
      return;
    }
    // OpenAI can keep a call whose page vanished for a long while; the app's heartbeat says it is gone.
    if (this.clock.now() - this.lastAlive >= ALIVE_TIMEOUT_MS) {
      // A phone suspended before it could say it left the screen: paused, as if it had.
      if (this.pausable) void this.pause("the app stopped answering");
      else void this.end("the app stopped answering");
      return;
    }
    // A response this side asked for that never started must not hold announcements back for good.
    const call = this.call;
    if (call !== null && call.askedAt !== null && this.clock.now() - call.askedAt > STUCK_RESPONSE_MS) {
      call.askedAt = null;
      call.announcer.refused();
      call.announcer.pump();
    }
  }

  // --- Tools -----------------------------------------------------------------------------------------

  private async runTool(call: Call, event: RealtimeEvent): Promise<void> {
    const name = typeof event.name === "string" ? event.name : "";
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    const responseId = typeof event.response_id === "string" ? event.response_id : "";
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof event.arguments === "string" && event.arguments !== "" ? JSON.parse(event.arguments) : {};
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
    const output = await this.tools.run(name, args, call.responses.get(responseId) ?? this.clock.now());
    if (this.ended || this.call !== call) return;
    let text = JSON.stringify(output);
    if (text.length > TOOL_OUTPUT_MAX) text = JSON.stringify({ ok: true, note: "cut short", data: text.slice(0, TOOL_OUTPUT_MAX) });
    this.deps.log.info(`Voice session ${this.id}: tool ${name} answered.`);
    this.debug.add("tool-result", `Tool answer: ${name}`, prettyJson(text));
    call.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: text } });
    if (name !== "end_session") call.respondToTool();
  }

  // --- Timers ----------------------------------------------------------------------------------------

  private later(ms: number, fn: () => void): void {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
  }

  private every(ms: number, fn: () => void): void {
    const tick = () => {
      if (this.ended) return;
      fn();
      this.later(ms, tick);
    };
    this.later(ms, tick);
  }
}

/** At most one live session; a new one takes over from the old. */
export class VoiceSessions {
  private live: VoiceSession | null = null;
  private counter = 0;
  /** The current session's debug log, or the last one's until the next Talk. */
  private debug: DebugLog | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly config: () => Promise<SessionConfig>,
  ) {}

  current(): VoiceSession | null {
    return this.live;
  }

  /** `hooks` is where this session's voice hooks run: the machine of the window that tapped Talk, or none. */
  async start(
    sdp: string,
    hooks: HookTarget | null = null,
    threadId: string | null = null,
    pausable = false,
  ): Promise<{ sessionId: string; answerSdp: string }> {
    await this.live?.end("a new session took over");
    this.counter += 1;
    const id = `vp_${this.deps.clock.now().toString(36)}_${this.counter}`;
    const clock = this.deps.clock;
    this.debug = new DebugLog(id, clock.now(), () => clock.now());
    const session = new VoiceSession(
      id,
      this.deps,
      await this.config(),
      (ended) => {
        if (this.live === ended) this.live = null;
      },
      this.debug,
      hooks === null ? null : (this.deps.hooks?.session(hooks, this.debug) ?? null),
    );
    session.focus(threadId);
    session.pausable = pausable;
    this.live = session;
    try {
      return { sessionId: id, answerSdp: await session.start(sdp) };
    } catch (error) {
      await session.end("the call could not be made");
      throw error;
    }
  }

  private find(sessionId: string): VoiceSession {
    if (this.live === null || this.live.id !== sessionId) throw new Error("That voice session is no longer live.");
    return this.live;
  }

  async renew(sessionId: string, sdp: string): Promise<{ answerSdp: string }> {
    return { answerSdp: await this.find(sessionId).renew(sdp) };
  }

  async renewed(sessionId: string): Promise<void> {
    await this.find(sessionId).renewed();
  }

  async end(sessionId: string, reason: string): Promise<void> {
    if (this.live?.id === sessionId) await this.live.end(reason);
  }

  /** bb left the screen of the phone holding the call: answers whether the session is paused (false when it is not live). */
  async pause(sessionId: string, reason: string): Promise<boolean> {
    if (this.live?.id !== sessionId) return false;
    return this.live.pause(reason);
  }

  /** The phone is back: a new call for the same session. */
  async resume(sessionId: string, sdp: string): Promise<{ answerSdp: string }> {
    return { answerSdp: await this.find(sessionId).resume(sdp) };
  }

  /** Thread news for the live session, if any. */
  news(news: ThreadNews, threadId: string, interactionId?: string, reply?: string | null): void {
    void this.live?.news(news, threadId, interactionId, reply);
  }

  /** The debug log's entries after `afterSeq`: the current session's, or the last one's. */
  debugPage(afterSeq: number): DebugPage {
    return this.debug?.page(afterSeq) ?? EMPTY_DEBUG_PAGE;
  }

  /** The app's heartbeat, with the thread on its screen; answers whether its session is still the live one. */
  alive(sessionId: string, threadId?: string | null): boolean {
    if (this.live?.id !== sessionId) return false;
    this.live.alive(threadId);
    return true;
  }

  focus(sessionId: string, threadId: string | null): void {
    if (this.live?.id === sessionId) this.live.focus(threadId);
  }

  async dispose(): Promise<void> {
    await this.live?.end("the plugin stopped");
    // The closing hooks (the open pairs, then "listening-stopped") get a moment to reach the machine.
    const runner = this.deps.hooks;
    if (runner === undefined) return;
    let timer: unknown;
    await Promise.race([runner.drained(), new Promise<void>((resolve) => (timer = this.deps.clock.setTimeout(resolve, HOOKS_DISPOSE_WAIT_MS)))]);
    this.deps.clock.clearTimeout(timer);
  }
}
