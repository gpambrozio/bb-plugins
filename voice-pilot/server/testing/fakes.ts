/**
 * Plain in-memory stand-ins for OpenAI's Realtime API, bb and time, for tests. The fake sideband records what
 * the server sends and lets a test play the call's events; `FakeBb` is a small bb of threads, projects and
 * pending interactions that records every change.
 */
import type { BbPort, ThreadInfo } from "../bb-port";
import type { GreetingList } from "../greeting";
import type { Clock, Log, RealtimeEvent, RealtimePort, Sideband, SidebandHandlers } from "../ports";
import type { Answers, Decision } from "../questions";

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

// --- bb --------------------------------------------------------------------------------------------

export function thread(id: string, patch: Partial<ThreadInfo> = {}): ThreadInfo {
  return { id, title: `Thread ${id}`, projectId: "proj_web", project: "web", status: "working", waitsOnYou: false, isRoot: true, updatedAt: 1, ...patch };
}

/** A provider's question, as bb lists it. */
export function providerQuestion(threadId: string, id = "int_q1", patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    threadId,
    status: "pending",
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "q0",
          prompt: "Which database should it use?",
          shortLabel: "Database",
          multiSelect: false,
          allowFreeText: true,
          required: true,
          options: [
            { value: "q0o0", label: "Postgres (Recommended)", description: "The one already in use" },
            { value: "q0o1", label: "SQLite" },
          ],
        },
      ],
    },
    ...patch,
  };
}

/** An approval for a command, as bb lists it. */
export function commandApproval(threadId: string, id = "int_a1", decisions = ["allow_once", "allow_for_session", "deny"]): Record<string, unknown> {
  return {
    id,
    threadId,
    status: "pending",
    payload: { kind: "approval", availableDecisions: decisions, reason: "To run the tests", subject: { kind: "command", command: "npm test", cwd: "/w", itemId: "i1", actions: [], sessionGrant: null } },
  };
}

export class FakeBb implements BbPort {
  threads = new Map<string, ThreadInfo>([["thr_a", thread("thr_a", { title: "Fix the login test" })]]);
  projectList = [
    { id: "proj_web", name: "web" },
    { id: "proj_personal", name: "Personal" },
  ];
  pending = new Map<string, unknown[]>();
  greetingList: GreetingList = { threads: [{ title: "Fix the login test", project: "web", status: "working", waitsOnYou: false }], more: 0 };
  briefingText = "Fix the login test (web): working.";
  readonly sends: { threadId: string; message: string; note: string }[] = [];
  readonly starts: { projectId: string; prompt: string; note: string }[] = [];
  readonly stops: string[] = [];
  readonly answers: { threadId: string; interactionId: string; via: string; answers: Answers }[] = [];
  readonly decisions: { threadId: string; interactionId: string; decision: Decision }[] = [];
  failGreeting = false;

  async briefing() {
    return this.briefingText;
  }
  async threadDetail(threadId: string) {
    const found = this.threads.get(threadId);
    return found === undefined ? null : `${found.title}: the agent said it is done.`;
  }
  async greeting() {
    if (this.failGreeting) throw new Error("bb did not answer");
    return this.greetingList;
  }
  async thread(threadId: string) {
    return this.threads.get(threadId) ?? null;
  }
  async search(query: string) {
    return [...this.threads.values()].filter((entry) => entry.title.toLowerCase().includes(query.toLowerCase()));
  }
  async projects() {
    return this.projectList;
  }
  async waiting() {
    return [...this.threads.values()].filter((entry) => entry.waitsOnYou);
  }
  async interactions(threadId: string) {
    return this.pending.get(threadId) ?? [];
  }
  private settle(threadId: string, interactionId: string) {
    this.pending.set(threadId, (this.pending.get(threadId) ?? []).filter((entry) => (entry as { id: string }).id !== interactionId));
  }
  async answer(threadId: string, interactionId: string, via: "provider" | "plugin", answers: Answers) {
    this.answers.push({ threadId, interactionId, via, answers });
    this.settle(threadId, interactionId);
  }
  async decide(threadId: string, interactionId: string, decision: Decision) {
    this.decisions.push({ threadId, interactionId, decision });
    this.settle(threadId, interactionId);
  }
  async send(threadId: string, message: string, note: string) {
    this.sends.push({ threadId, message, note });
    return "sent" as const;
  }
  async start(projectId: string, prompt: string, note: string) {
    this.starts.push({ projectId, prompt, note });
    return { id: "thr_new" };
  }
  async stop(threadId: string) {
    this.stops.push(threadId);
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
