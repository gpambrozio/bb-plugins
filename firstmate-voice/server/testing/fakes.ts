/**
 * Plain in-memory stand-ins for OpenAI's Realtime API, firstmate-crew's `voice.v1` and time, for tests.
 * The fake sideband records what the server sends and lets a test play the call's events.
 */
import type { VoiceBrief, VoiceCard, VoiceSent } from "../../shared/crew-voice";
import type { Clock, CrewPort, Log, RealtimeEvent, RealtimePort, Sideband, SidebandHandlers } from "../ports";

// --- Time ------------------------------------------------------------------------------------------

export class FakeClock implements Clock {
  private time = Date.UTC(2026, 10, 13, 14, 0);
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Moves time on, running each timer that falls due in order, and lets promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.fn();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// --- OpenAI ----------------------------------------------------------------------------------------

export class FakeSideband implements Sideband {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  constructor(
    readonly callId: string,
    private readonly handlers: SidebandHandlers,
  ) {}

  send(event: Record<string, unknown>): void {
    this.sent.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose({ code: 1000, reason: "", expected: true });
  }

  open(): void {
    this.handlers.onOpen();
  }

  emit(event: RealtimeEvent): void {
    this.handlers.onEvent(event);
  }

  /** The call's side closes it: the device closed its peer, or the network dropped. */
  drop(code = 1006): void {
    this.closed = true;
    this.handlers.onClose({ code, reason: "", expected: false });
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter((event) => event.type === type);
  }

  /** The text of every system item the server added. */
  items(): string[] {
    return this.ofType("conversation.item.create")
      .map((event) => event.item as { type?: string; content?: { text?: string }[] })
      .filter((item) => item.type === "message")
      .map((item) => item.content?.[0]?.text ?? "");
  }

  /** The outputs of every function call the server answered, parsed. */
  outputs(): Record<string, unknown>[] {
    return this.ofType("conversation.item.create")
      .map((event) => event.item as { type?: string; output?: string })
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output ?? "{}") as Record<string, unknown>);
  }
}

export class FakeRealtime implements RealtimePort {
  readonly calls: { callId: string; sdp: string; session: Record<string, unknown> }[] = [];
  readonly hungUp: string[] = [];
  readonly sidebands: FakeSideband[] = [];
  refuseNext: Error | null = null;

  async createCall(input: { sdp: string; session: Record<string, unknown> }) {
    if (this.refuseNext !== null) {
      const error = this.refuseNext;
      this.refuseNext = null;
      throw error;
    }
    const callId = `rtc_${this.calls.length + 1}`;
    this.calls.push({ callId, sdp: input.sdp, session: input.session });
    return { callId, answerSdp: `answer for ${callId}` };
  }

  async hangup(callId: string): Promise<void> {
    this.hungUp.push(callId);
  }

  openSideband(callId: string, handlers: SidebandHandlers): Sideband {
    const sideband = new FakeSideband(callId, handlers);
    this.sidebands.push(sideband);
    return sideband;
  }

  /** The newest sideband. */
  get last(): FakeSideband {
    const sideband = this.sidebands.at(-1);
    if (sideband === undefined) throw new Error("No sideband was opened.");
    return sideband;
  }
}

// --- firstmate-crew --------------------------------------------------------------------------------

export function brief(overrides: Partial<VoiceBrief> = {}): VoiceBrief {
  return {
    v: 1,
    at: "2026-11-13T14:00:00.000Z",
    etag: "e1",
    firstMate: { status: "idle", waiting: false, lastReply: null, repliedAt: null },
    captainsCall: [
      {
        ref: "c1",
        title: "Fix the flaky login test",
        project: "web",
        kind: null,
        column: "idle",
        pr: "web #42",
        hold: "merge web#42?",
        lastWord: { state: "done", text: { untrusted: true, head: "PR web #42 checks green", tail: "", chars: 23 } },
        actions: [
          { ref: "c1.a1", label: "Merge", tapOnly: "a merge" },
          { ref: "c1.a2", label: "Hold", tapOnly: null },
        ],
        blockedBy: null,
        since: null,
      },
    ],
    working: [],
    blocked: [],
    failed: [],
    parked: [],
    idle: [],
    queued: [],
    queuedMore: 0,
    landed: [],
    suggestions: [{ ref: "s1", label: "Review loop on web#42", tapOnly: null }],
    watches: { failing: [] },
    ...overrides,
  };
}

export function card(ref: string, overrides: Partial<VoiceCard> = {}): VoiceCard {
  if (ref.startsWith("s")) {
    return {
      ref,
      etag: "es1",
      kind: "suggestion",
      title: "Review loop on web#42",
      project: null,
      column: null,
      pr: null,
      hold: null,
      lastWord: null,
      pressable: [{ ref, label: "Review loop on web#42", tapOnly: null, readBack: 'Press the suggestion "Review loop on web#42"?' }],
      ...overrides,
    };
  }
  return {
    ref,
    etag: "ec1",
    kind: "card",
    title: "Fix the flaky login test",
    project: "web",
    column: "idle",
    pr: "web #42",
    hold: "merge web#42?",
    lastWord: null,
    pressable: [
      { ref: `${ref}.a1`, label: "Merge", tapOnly: "a merge", readBack: 'Press "Merge" on Fix the flaky login test, web pull request 42?' },
      { ref: `${ref}.a2`, label: "Hold", tapOnly: null, readBack: 'Press "Hold" on Fix the flaky login test, web pull request 42?' },
    ],
    ...overrides,
  };
}

export class FakeCrew implements CrewPort {
  current: VoiceBrief = brief();
  cards = new Map<string, VoiceCard>([
    ["c1", card("c1")],
    ["s1", card("s1")],
  ]);
  replyText = "Aye, captain: rebased and pushed.";
  readonly asks: string[] = [];
  readonly answers: { ref: string; words: string }[] = [];
  readonly presses: { ref: string; etag: string }[] = [];
  pressRefusal: Error | null = null;

  async brief(): Promise<VoiceBrief> {
    return this.current;
  }

  async card(ref: string): Promise<VoiceCard> {
    const found = this.cards.get(ref);
    if (found === undefined) throw Object.assign(new Error(`There is no ${ref} on the board now.`), { code: "not_found" });
    return found;
  }

  async reply() {
    return { reply: { untrusted: true as const, head: this.replyText, tail: "", chars: this.replyText.length }, repliedAt: "2026-11-13T14:05:00.000Z", status: "idle" };
  }

  async ask(words: string): Promise<VoiceSent> {
    this.asks.push(words);
    return { delivery: "sent" };
  }

  async answer(ref: string, words: string): Promise<VoiceSent> {
    this.answers.push({ ref, words });
    return { delivery: "sent" };
  }

  async press(ref: string, etag: string): Promise<VoiceSent> {
    if (this.pressRefusal !== null) throw this.pressRefusal;
    this.presses.push({ ref, etag });
    return { delivery: "sent" };
  }

  async mateThreadId(): Promise<string | null> {
    return "thr_mate";
  }
}

export function quietLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}
