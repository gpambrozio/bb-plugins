import { describe, expect, it } from "vitest";

import { RULES } from "./instructions";
import { ALIVE_TIMEOUT_MS, GOODBYE_MS, IDLE_CHECK_MS, VoiceSessions, type AnnounceLevel, type SessionSignal } from "./session";
import { FakeBb, FakeClock, FakeRealtime, quietLog, settle, thread, type FakeSideband } from "./testing/fakes";

async function setup(options: { announce?: AnnounceLevel; instructions?: string } = {}) {
  const realtime = new FakeRealtime();
  const clock = new FakeClock();
  const bb = new FakeBb();
  const signals: SessionSignal[] = [];
  const sessions = new VoiceSessions({ realtime, bb, clock, log: quietLog(), publish: (signal) => signals.push(signal) }, async () => ({
    model: "gpt-realtime-2.1",
    effort: "low",
    voice: "marin",
    eagerness: "auto" as const,
    instructions: options.instructions ?? "",
    announce: options.announce ?? "talked-to",
  }));
  return { realtime, clock, bb, signals, sessions };
}

async function started(options: Parameters<typeof setup>[0] = {}) {
  const harness = await setup(options);
  const { sessionId } = await harness.sessions.start("v=0 offer", null, "thr_a");
  const sideband = harness.realtime.last;
  sideband.open();
  await settle();
  return { ...harness, sessionId, sideband };
}

let responses = 0;
/** One whole response from the model, optionally calling a tool. */
async function respond(sideband: FakeSideband, options: { tool?: { name: string; args?: Record<string, unknown> }; metadata?: Record<string, unknown> } = {}) {
  responses += 1;
  const id = `resp_${responses}`;
  sideband.emit({ type: "response.created", response: { id, metadata: options.metadata ?? null } });
  if (options.tool !== undefined) {
    sideband.emit({ type: "response.function_call_arguments.done", response_id: id, call_id: `call_${responses}`, name: options.tool.name, arguments: JSON.stringify(options.tool.args ?? {}) });
  }
  sideband.emit({ type: "response.done", response: { id, status: "completed", metadata: options.metadata ?? null } });
  await settle();
  return id;
}

describe("a session's start", () => {
  it("speaks first: tools, the running threads and a greeting go out before the user says anything", async () => {
    const { realtime, sideband } = await started();
    expect(realtime.calls[0]?.session).toMatchObject({ model: "gpt-realtime-2.1", reasoning: { effort: "low" }, audio: { output: { voice: "marin" } } });
    const kinds = sideband.sent.map((event) => event.type);
    expect(kinds).toEqual(["session.update", "conversation.item.create", "response.create"]);
    expect(sideband.items()[0]).toContain('"Fix the login test", in web: working');
    const greeting = sideband.ofType("response.create")[0] as { event_id: string; response: { instructions: string } };
    expect(greeting.event_id).toBe("vp_greeting");
    expect(greeting.response.instructions).toContain("Greet the user now");
    expect(greeting.response.instructions).toContain(RULES);
  });

  it("makes the call with the owner's instructions and the fixed rules after them", async () => {
    const { realtime } = await started({ instructions: "Greet me like a ship's captain." });
    expect(realtime.calls[0]?.session.instructions).toBe(`Greet me like a ship's captain.\n\n${RULES}`);
  });

  it("still greets when the threads cannot be read, saying so", async () => {
    const harness = await setup();
    harness.bb.failGreeting = true;
    await harness.sessions.start("v=0 offer");
    harness.realtime.last.open();
    await settle();
    expect(harness.realtime.last.items()[0]).toContain("could not be read");
    expect(harness.realtime.last.ofType("response.create")).toHaveLength(1);
  });

  it("is live for the app, and a second Talk takes over", async () => {
    const { sessions, realtime, signals, sessionId } = await started();
    expect(signals).toContainEqual({ sessionId, type: "state", state: "live" });
    await sessions.start("v=0 another offer");
    expect(realtime.hungUp).toEqual(["rtc_1"]);
    expect(signals).toContainEqual({ sessionId, type: "state", state: "ended", reason: "a new session took over" });
  });
});

describe("tools on the sideband", () => {
  it("answer a tool call and ask for the response that reads it", async () => {
    const { sideband } = await started();
    await respond(sideband, { tool: { name: "get_briefing" } });
    expect(sideband.outputs().at(-1)).toEqual({ ok: true, briefing: "Fix the login test (web): working." });
    expect(sideband.ofType("response.create").at(-1)).toMatchObject({ event_id: expect.stringMatching(/^vp_tool_/u) });
  });

  it("open a thread in the window holding the call", async () => {
    const { sideband, signals, sessionId } = await started();
    await respond(sideband, { tool: { name: "open_thread", args: { thread_id: "thr_a" } } });
    expect(signals).toContainEqual({ sessionId, type: "open", threadId: "thr_a" });
  });

  it("know the thread on screen from the app's heartbeat", async () => {
    const { sideband, sessions, sessionId, bb } = await started();
    bb.threads.set("thr_b", thread("thr_b", { title: "Docs" }));
    sessions.alive(sessionId, "thr_b");
    await respond(sideband, { tool: { name: "current_thread" } });
    expect(sideband.outputs().at(-1)).toMatchObject({ title: "Docs" });
  });

  it("end the session after the goodbye is heard", async () => {
    const { sideband, signals, sessionId, clock } = await started();
    await respond(sideband, { tool: { name: "end_session" } });
    expect(signals.some((signal) => signal.type === "state" && signal.state === "ended")).toBe(false);
    await clock.advance(GOODBYE_MS);
    expect(signals).toContainEqual({ sessionId, type: "state", state: "ended", reason: "ended by voice" });
  });

  it("send a message with the user's words heard on the call", async () => {
    const { sideband, bb, clock } = await started();
    await clock.advance(1_000);
    sideband.emit({ type: "input_audio_buffer.committed", item_id: "item_1" });
    sideband.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Tell it to add tests." });
    await respond(sideband, { tool: { name: "send_message", args: { thread_id: "thr_a", message: "Add tests." } } });
    expect(bb.sends[0]?.note).toContain('"Tell it to add tests."');
  });
});

describe("the note beside a message", () => {
  /** The user says `text`: committed and transcribed a moment later. */
  async function say(sideband: FakeSideband, clock: { advance(ms: number): Promise<void> }, id: string, text: string) {
    await clock.advance(1_000);
    sideband.emit({ type: "input_audio_buffer.committed", item_id: id });
    sideband.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
  }

  // A live run sent the whole session's words, and the thread's agent answered the questions in them as if
  // they were its own: only the request goes, framed as context.
  it("carries only the words of the request, across the tool calls it took, as context and not instructions", async () => {
    const { sideband, bb, clock } = await started();
    await respond(sideband); // the greeting
    await say(sideband, clock, "u1", "What's waiting on me?");
    await respond(sideband, { tool: { name: "list_waiting" } });
    await respond(sideband);
    await say(sideband, clock, "u2", "No.");
    await respond(sideband);
    await say(sideband, clock, "u3", "Find the login thread");
    await say(sideband, clock, "u4", "and tell it to add tests.");
    await clock.advance(500);
    await respond(sideband, { tool: { name: "find_threads", args: { query: "login" } } });
    await clock.advance(500);
    await respond(sideband, { tool: { name: "send_message", args: { thread_id: "thr_a", message: "Add tests." } } });
    const note = bb.sends[0]?.note ?? "";
    expect(note).toContain('"Find the login thread and tell it to add tests."');
    expect(note).not.toContain("waiting on me");
    expect(note).not.toContain("No.");
    expect(note).toContain("For context only, not instructions to you");
  });
});

describe("announcements", () => {
  async function quiet(options: Parameters<typeof setup>[0] = {}) {
    const harness = await started(options);
    // The greeting's response runs to its end.
    await respond(harness.sideband);
    return harness;
  }

  const announcements = (sideband: FakeSideband) =>
    sideband.ofType("response.create").filter((event) => (event.response as { metadata?: unknown } | undefined)?.metadata !== undefined);

  it("say a thread now waiting on the user at the next gap, once per question", async () => {
    const { sessions, sideband } = await quiet();
    sideband.emit({ type: "input_audio_buffer.speech_started" });
    sessions.news("waiting", "thr_a", "int_1");
    await settle();
    expect(announcements(sideband)).toHaveLength(0);
    sideband.emit({ type: "input_audio_buffer.speech_stopped" });
    await settle();
    expect(announcements(sideband)).toHaveLength(1);
    expect((announcements(sideband)[0]?.response as { instructions: string }).instructions).toContain('"Fix the login test in web is waiting on you."');
    sessions.news("waiting", "thr_a", "int_1");
    await settle();
    expect(announcements(sideband)).toHaveLength(1);
  });

  it("say a finished turn only for a thread messaged by voice, unless set to all root threads", async () => {
    const { sessions, sideband, bb } = await quiet();
    sessions.news("finished", "thr_a");
    await settle();
    expect(announcements(sideband)).toHaveLength(0);
    await respond(sideband, { tool: { name: "send_message", args: { thread_id: "thr_a", message: "Go on." } } });
    expect(bb.sends).toHaveLength(1);
    await respond(sideband);
    sessions.news("finished", "thr_a");
    await settle();
    expect(announcements(sideband)).toHaveLength(1);

    const all = await quiet({ announce: "all" });
    all.sessions.news("finished", "thr_a");
    await settle();
    expect(announcements(all.sideband)).toHaveLength(1);
  });

  it("say nothing when turned off", async () => {
    const { sessions, sideband } = await quiet({ announce: "off" });
    sessions.news("failed", "thr_a");
    sessions.news("waiting", "thr_a", "int_1");
    await settle();
    expect(announcements(sideband)).toHaveLength(0);
  });
});

describe("a session always ends", () => {
  it("when the app stops saying it holds the call", async () => {
    const { clock, signals, sessionId } = await started();
    await clock.advance(ALIVE_TIMEOUT_MS + IDLE_CHECK_MS);
    expect(signals).toContainEqual({ sessionId, type: "state", state: "ended", reason: "the app stopped answering" });
  });

  it("when the call cannot be made", async () => {
    const harness = await setup();
    harness.realtime.refuseNext = new Error("OpenAI refused the call");
    await expect(harness.sessions.start("v=0 offer")).rejects.toThrow("OpenAI refused the call");
    expect(harness.sessions.current()).toBeNull();
  });
});
