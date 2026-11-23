import { describe, expect, it } from "vitest";

import { DebugLog } from "./debug-log";
import { UtteranceLog } from "./policy";
import { CONFIRM_WINDOW_MS, TOOLS, VoiceTools } from "./tools";
import { FakeBb, FakeClock, commandApproval, providerQuestion, thread } from "./testing/fakes";

function setup() {
  const clock = new FakeClock();
  const bb = new FakeBb();
  const utterances = new UtteranceLog(clock);
  const debug = new DebugLog("vp_1", clock.now(), () => clock.now());
  const opened: string[] = [];
  const sent: string[] = [];
  let ended = 0;
  let focused: string | null = null;
  const tools = new VoiceTools({
    bb,
    clock,
    debug,
    words: (from, to) => utterances.between(from, to),
    open: (id) => opened.push(id),
    focused: () => focused,
    end: () => (ended += 1),
    sent: (id) => sent.push(id),
  });
  let n = 0;
  /** The user says `text`, a moment later. */
  const say = async (text: string) => {
    await clock.advance(500);
    n += 1;
    utterances.committed(`u${n}`);
    utterances.transcribed(`u${n}`, text);
  };
  /** A tool call from a response that starts now. */
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    await clock.advance(200);
    return tools.run(name, args, clock.now());
  };
  return { clock, bb, debug, tools, opened, sent, say, run, ended: () => ended, focus: (id: string | null) => (focused = id) };
}

describe("the tool list", () => {
  it("has no tool that merges, archives, deletes, renames or changes settings", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names.filter((name) => /merge|archive|delete|remove|rename|setting|permission|publish|plugin_command|cli/iu.test(name))).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining(["get_briefing", "read_question", "answer_question", "decide_request", "confirm_decision", "send_message", "end_session"]),
    );
  });
});

describe("reads", () => {
  it("give the whole briefing in one call, and a thread in depth", async () => {
    const { run } = setup();
    expect(await run("get_briefing")).toEqual({ ok: true, briefing: "Fix the login test (web): working." });
    expect(await run("get_thread", { thread_id: "thr_a" })).toEqual({ ok: true, thread: "Fix the login test: the agent said it is done." });
    expect(await run("get_thread", { thread_id: "thr_nope" })).toMatchObject({ ok: false });
    expect(await run("get_thread", { thread_id: "../etc" })).toMatchObject({ ok: false });
  });

  it("find threads by topic and name the one on screen", async () => {
    const { run, focus } = setup();
    expect(await run("find_threads", { query: "login" })).toMatchObject({ ok: true, threads: [{ thread_id: "thr_a", title: "Fix the login test", project: "web" }] });
    expect(await run("current_thread")).toEqual({ ok: true, note: "No thread is on the user's screen." });
    focus("thr_a");
    expect(await run("current_thread")).toMatchObject({ ok: true, title: "Fix the login test" });
  });

  it("open a thread in the window holding the call", async () => {
    const { run, opened } = setup();
    expect(await run("open_thread", { thread_id: "thr_a" })).toEqual({ ok: true, opened: "Fix the login test" });
    expect(await run("open_thread", { thread_id: "thr_missing" })).toMatchObject({ ok: false });
    expect(opened).toEqual(["thr_a"]);
  });
});

describe("sends", () => {
  it("send the model's message with the user's own words beside it, for the agent only, and say what went", async () => {
    const { run, say, bb, sent } = setup();
    await say("Tell the login one to also add tests for the error path.");
    const result = await run("send_message", { thread_id: "thr_a", message: "Also add tests for the error path." });
    expect(result).toEqual({ ok: true, thread: "Fix the login test", sent: "Also add tests for the error path.", delivery: "sent" });
    expect(bb.sends).toHaveLength(1);
    expect(bb.sends[0]?.message).toBe("Also add tests for the error path.");
    expect(bb.sends[0]?.note).toContain('"Tell the login one to also add tests for the error path."');
    expect(sent).toEqual(["thr_a"]);
  });

  it("carry in the next note only the words said since the last send", async () => {
    const { run, say, bb, clock } = setup();
    await say("First thing.");
    await run("send_message", { thread_id: "thr_a", message: "First thing." });
    await clock.advance(3_000);
    await say("Second thing.");
    await run("send_message", { thread_id: "thr_a", message: "Second thing." });
    expect(bb.sends[1]?.note).toContain('"Second thing."');
    expect(bb.sends[1]?.note).not.toContain("First thing.");
  });

  it("refuse an empty message, an unknown thread, and a burst", async () => {
    const { run, bb } = setup();
    expect(await run("send_message", { thread_id: "thr_a", message: "  " })).toMatchObject({ ok: false });
    expect(await run("send_message", { thread_id: "thr_zzz", message: "hi" })).toMatchObject({ ok: false });
    expect(await run("send_message", { thread_id: "thr_a", message: "one" })).toMatchObject({ ok: true });
    expect(await run("send_message", { thread_id: "thr_a", message: "two" })).toMatchObject({ ok: false, error: expect.stringContaining("Too many") });
    expect(bb.sends.map((send) => send.message)).toEqual(["one"]);
  });

  it("start a thread in a known project only", async () => {
    const { run, bb, sent } = setup();
    expect(await run("start_thread", { project_id: "proj_nope", prompt: "Fix CI" })).toMatchObject({ ok: false });
    expect(await run("start_thread", { project_id: "proj_web", prompt: "Fix the CI timeout." })).toEqual({ ok: true, thread_id: "thr_new", project: "web", sent: "Fix the CI timeout." });
    expect(bb.starts.map((start) => start.prompt)).toEqual(["Fix the CI timeout."]);
    expect(sent).toEqual(["thr_new"]);
  });

  it("stop a thread", async () => {
    const { run, bb } = setup();
    expect(await run("stop_thread", { thread_id: "thr_a" })).toEqual({ ok: true, stopped: "Fix the login test" });
    expect(bb.stops).toEqual(["thr_a"]);
  });

  it("end the session", async () => {
    const { run, ended } = setup();
    expect(await run("end_session")).toEqual({ ok: true });
    expect(ended()).toBe(1);
  });
});

describe("bb's questions", () => {
  function withQuestion() {
    const harness = setup();
    harness.bb.threads.set("thr_a", thread("thr_a", { title: "Fix the login test", waitsOnYou: true }));
    harness.bb.pending.set("thr_a", [providerQuestion("thr_a")]);
    return harness;
  }

  it("list the threads waiting on the user", async () => {
    const { run } = withQuestion();
    expect(await run("list_waiting")).toMatchObject({ ok: true, threads: [{ thread_id: "thr_a", status: "working, waiting on the user" }] });
  });

  it("are read aloud with their options before they can be answered", async () => {
    const { run, bb, say } = withQuestion();
    await say("Postgres.");
    expect(await run("answer_question", { thread_id: "thr_a", interaction_id: "int_q1", answers: [{ options: ["1"] }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("read_question first"),
    });
    const read = await run("read_question", { thread_id: "thr_a" });
    expect(read).toMatchObject({ ok: true, waiting: [{ interaction_id: "int_q1", kind: "question", read_aloud: expect.stringContaining("1. Postgres") }] });
    expect(bb.answers).toEqual([]);
  });

  it("are answered with the user's choice, and the result says what was sent", async () => {
    const { run, bb, say } = withQuestion();
    await run("read_question", { thread_id: "thr_a" });
    await say("The second one.");
    const result = await run("answer_question", { thread_id: "thr_a", interaction_id: "int_q1", answers: [{ options: ["2"] }] });
    expect(result).toEqual({ ok: true, thread: "Fix the login test", answered: "SQLite", note: "Say back what was sent." });
    expect(bb.answers).toEqual([{ threadId: "thr_a", interactionId: "int_q1", via: "provider", answers: { q0: { selected: ["q0o1"] } } }]);
  });

  it("take the user's own words since the question was read, word for word, never earlier ones", async () => {
    const { run, bb, say } = withQuestion();
    await say("Something said before the question.");
    await run("read_question", { thread_id: "thr_a" });
    await say("Whatever staging uses.");
    await run("answer_question", { thread_id: "thr_a", interaction_id: "int_q1", answers: [{ use_spoken_words: true }] });
    expect(bb.answers[0]?.answers).toEqual({ q0: { selected: [], freeText: "Whatever staging uses." } });
  });

  it("refuse an option the question does not have, and one answered elsewhere since", async () => {
    const { run, bb } = withQuestion();
    await run("read_question", { thread_id: "thr_a" });
    expect(await run("answer_question", { thread_id: "thr_a", interaction_id: "int_q1", answers: [{ options: ["MySQL"] }] })).toMatchObject({ ok: false });
    bb.pending.set("thr_a", []);
    expect(await run("answer_question", { thread_id: "thr_a", interaction_id: "int_q1", answers: [{ options: [1] }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no longer waits"),
    });
    expect(bb.answers).toEqual([]);
  });

  it("must be read again after a while", async () => {
    const { run, clock, bb } = withQuestion();
    await run("read_question", { thread_id: "thr_a" });
    await clock.advance(11 * 60_000);
    expect(await run("answer_question", { thread_id: "thr_a", interaction_id: "int_q1", answers: [{ options: [1] }] })).toMatchObject({ ok: false });
    expect(bb.answers).toEqual([]);
  });
});

describe("approvals", () => {
  function withApproval() {
    const harness = setup();
    harness.bb.pending.set("thr_a", [commandApproval("thr_a")]);
    return harness;
  }

  it("are read back and sent only after the user says yes to the read-back", async () => {
    const { run, bb, say } = withApproval();
    await run("read_question", { thread_id: "thr_a" });
    await say("Approve it.");
    const prepared = await run("decide_request", { thread_id: "thr_a", interaction_id: "int_a1", decision: "allow_once" });
    expect(prepared).toMatchObject({ ok: true, read_back: 'Approve the request from "Fix the login test" to run a command: npm test, this once?' });
    // The "approve it" that led here was said before the read-back: it is no yes to it.
    expect(await run("confirm_decision")).toMatchObject({ ok: false });
    expect(bb.decisions).toEqual([]);
    await say("Yes.");
    expect(await run("confirm_decision")).toEqual({ ok: true, sent: "approve it this once", note: "Say back what was sent." });
    expect(bb.decisions).toEqual([{ threadId: "thr_a", interactionId: "int_a1", decision: "allow_once" }]);
  });

  it("are not sent on a no, a maybe or silence", async () => {
    for (const words of ["No, wait.", "Yes, but not yet.", null]) {
      const { run, bb, say } = withApproval();
      await run("read_question", { thread_id: "thr_a" });
      await run("decide_request", { thread_id: "thr_a", interaction_id: "int_a1", decision: "allow_once" });
      if (words !== null) await say(words);
      expect(await run("confirm_decision")).toMatchObject({ ok: false });
      expect(bb.decisions).toEqual([]);
    }
  });

  it("offer only the decisions bb offers, and need a read first", async () => {
    const { run, bb } = setup();
    bb.pending.set("thr_a", [commandApproval("thr_a", "int_a1", ["allow_once", "deny"])]);
    expect(await run("decide_request", { thread_id: "thr_a", interaction_id: "int_a1", decision: "allow_once" })).toMatchObject({ ok: false });
    await run("read_question", { thread_id: "thr_a" });
    expect(await run("decide_request", { thread_id: "thr_a", interaction_id: "int_a1", decision: "allow_for_session" })).toMatchObject({ ok: false });
    expect(await run("confirm_decision")).toMatchObject({ ok: false, error: expect.stringContaining("nothing to confirm") });
  });

  it("expire when the yes comes too late", async () => {
    const { run, bb, say, clock } = withApproval();
    await run("read_question", { thread_id: "thr_a" });
    await run("decide_request", { thread_id: "thr_a", interaction_id: "int_a1", decision: "deny" });
    await clock.advance(CONFIRM_WINDOW_MS + 1);
    await say("Yes.");
    expect(await run("confirm_decision")).toMatchObject({ ok: false });
    expect(bb.decisions).toEqual([]);
  });

  it("cannot be answered as a question, nor a question decided as an approval", async () => {
    const { run, bb } = withApproval();
    bb.pending.set("thr_a", [commandApproval("thr_a"), providerQuestion("thr_a")]);
    await run("read_question", { thread_id: "thr_a" });
    expect(await run("answer_question", { thread_id: "thr_a", interaction_id: "int_a1", answers: [{ options: [1] }] })).toMatchObject({ ok: false });
    expect(await run("decide_request", { thread_id: "thr_a", interaction_id: "int_q1", decision: "allow_once" })).toMatchObject({ ok: false });
  });
});
