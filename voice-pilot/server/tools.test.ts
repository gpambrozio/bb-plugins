import { describe, expect, it } from "vitest";

import { DebugLog } from "./debug-log";
import { UtteranceLog } from "./policy";
import { PromptEdits } from "./prompt-edits";
import { CONFIRM_WINDOW_MS, TOOLS, VoiceTools, type ToolDeps } from "./tools";
import { FakeBb, FakeClock, commandApproval, providerQuestion, thread } from "./testing/fakes";

function setup(extra: Partial<ToolDeps> = {}) {
  const clock = new FakeClock();
  const bb = new FakeBb();
  const utterances = new UtteranceLog(clock);
  const debug = new DebugLog("vp_1", clock.now(), () => clock.now());
  const opened: string[] = [];
  const links: { url: string; label: string }[] = [];
  const sent: string[] = [];
  let ended = 0;
  let muted = 0;
  let focused: string | null = null;
  const tools = new VoiceTools({
    bb,
    clock,
    debug,
    words: (from, to) => utterances.between(from, to),
    open: (id) => opened.push(id),
    openLink: (url, label) => links.push({ url, label }),
    focused: () => focused,
    end: () => (ended += 1),
    mute: () => (muted += 1),
    sent: (id) => sent.push(id),
    ...extra,
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
  return { clock, bb, debug, tools, opened, links, sent, say, run, ended: () => ended, muted: () => muted, focus: (id: string | null) => (focused = id) };
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

const REPLY = [
  "Two pull requests are ready.",
  "",
  "```ui",
  'Card("Ready to merge", [',
  '  Table(["PR", "What", "Next"], [',
  '    ["https://github.com/acme/web/pull/20", "Login: remember the device", "You: merge"],',
  '    ["https://github.com/acme/api/pull/7", "Rate limits per key", "The reviewer"]',
  "  ])",
  "])",
  "```",
].join("\n");

describe("read_reply", () => {
  it("gives everything in the latest reply, its table row by row, with the links numbered", async () => {
    const { run, bb } = setup();
    bb.replies.set("thr_a", REPLY);
    expect(await run("read_reply", { thread_id: "thr_a" })).toEqual({
      ok: true,
      thread: "Fix the login test",
      reply: [
        "Two pull requests are ready.",
        "",
        "Ready to merge:",
        "- Row 1: PR: [link 1]; What: Login: remember the device; Next: You: merge",
        "- Row 2: PR: [link 2]; What: Rate limits per key; Next: The reviewer",
      ].join("\n"),
      links: [
        { link: 1, url: "https://github.com/acme/web/pull/20" },
        { link: 2, url: "https://github.com/acme/api/pull/7" },
      ],
      note: expect.stringMatching(/never read URLs/u),
    });
  });

  it("gives a long reply in parts, each with its own links", async () => {
    const { run, bb } = setup();
    const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the report, about https://example.com/item/${i + 1} and nothing else.`);
    bb.replies.set("thr_a", lines.join("\n"));
    const first = await run("read_reply", { thread_id: "thr_a" });
    expect(first).toMatchObject({ ok: true, part: 1, parts: expect.any(Number) });
    expect(JSON.stringify(first).length).toBeLessThan(4_000);
    const second = (await run("read_reply", { thread_id: "thr_a", part: 2 })) as { reply: string; links: { link: number }[] };
    expect(second.reply).not.toContain("Line 1 ");
    expect(second.links.length).toBeGreaterThan(0);
    expect(second.links.every((link) => second.reply.includes(`[link ${link.link}]`))).toBe(true);
  });

  it("says when there is no reply, and refuses a thread that is not there", async () => {
    const { run } = setup();
    expect(await run("read_reply", { thread_id: "thr_a" })).toEqual({ ok: true, thread: "Fix the login test", note: "Its agent has not replied yet." });
    expect(await run("read_reply", { thread_id: "thr_nope" })).toMatchObject({ ok: false });
  });
});

describe("open_link", () => {
  it("opens a link read in this session by its number, and says what it opened", async () => {
    const { run, bb, links } = setup();
    bb.replies.set("thr_a", REPLY);
    await run("read_reply", { thread_id: "thr_a" });
    expect(await run("open_link", { link: 2 })).toMatchObject({ ok: true, opened: "github.com/acme/api/pull/7" });
    expect(await run("open_link", { url: "https://github.com/acme/web/pull/20/" })).toMatchObject({ ok: true });
    expect(links).toEqual([
      { url: "https://github.com/acme/api/pull/7", label: "github.com/acme/api/pull/7" },
      { url: "https://github.com/acme/web/pull/20", label: "github.com/acme/web/pull/20" },
    ]);
  });

  it("opens a URL the model wrote only after the user says yes to its read-back", async () => {
    const { run, say, links } = setup();
    const url = "https://github.com/acme/web/pulls";
    expect(await run("open_link", { url })).toMatchObject({ ok: false, read_back: "Open github.com/acme/web/pulls? It is not a link from anything read in this session." });
    expect(links).toEqual([]);
    await say("hmm, not sure");
    expect(await run("open_link", { url })).toMatchObject({ ok: false, read_back: expect.any(String) });
    expect(links).toEqual([]);
    await say("yes, open it");
    expect(await run("open_link", { url })).toMatchObject({ ok: true, opened: "github.com/acme/web/pulls" });
    expect(links).toEqual([{ url, label: "github.com/acme/web/pulls" }]);
  });

  it("refuses an unknown link number, a link that is not http(s), and one with a password in it", async () => {
    const { run, links } = setup();
    expect(await run("open_link", { link: 9 })).toMatchObject({ ok: false, error: expect.stringMatching(/no such link/u) });
    expect(await run("open_link", { url: "file:///etc/passwd" })).toMatchObject({ ok: false, error: expect.stringMatching(/http or https/u) });
    expect(await run("open_link", { url: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(await run("open_link", { url: "https://user:secret@example.com/" })).toMatchObject({ ok: false, error: expect.stringMatching(/password/u) });
    expect(await run("open_link", {})).toMatchObject({ ok: false });
    expect(links).toEqual([]);
  });

  it("shows a thread link in bb, in the window holding the call", async () => {
    const { run, bb, opened, links } = setup();
    bb.replies.set("thr_a", "See [the worker's report](@thread:thr_a#msg=4).");
    expect(await run("read_reply", { thread_id: "thr_a" })).toMatchObject({ reply: "See the worker's report [link 1].", links: [{ link: 1, url: "bb:thread/thr_a#msg=4" }] });
    expect(await run("open_link", { link: 1 })).toEqual({ ok: true, opened: "the thread Fix the login test" });
    expect(opened).toEqual(["thr_a"]);
    expect(links).toEqual([]);
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
    // The thread is told that it is the one the words name, not some other thread to message.
    expect(bb.sends[0]?.note).toContain('The user sent the message above to this thread ("Fix the login test") by voice');
    expect(bb.sends[0]?.note).toContain("where their words name a thread, they mean this one");
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

  it("mute the microphone without ending the session, and say how to unmute", async () => {
    const { run, ended, muted } = setup();
    const answer = await run("mute_microphone");
    expect(answer).toMatchObject({ ok: true, muted: true });
    expect(JSON.stringify(answer)).toContain("tap Unmute");
    expect(muted()).toBe(1);
    expect(ended()).toBe(0);
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

describe("an edit of the voice's own instructions", () => {
  const NOW = "You are Voice Pilot.\n\nStyle: speak briefly.";
  function staging() {
    const rows = new Map<string, unknown>();
    const writes: string[] = [];
    const prompts = new PromptEdits({
      kv: { get: async <T>(key: string) => rows.get(key) as T | undefined, set: async (key, value) => void rows.set(key, value), delete: async (key) => void rows.delete(key) },
      instructions: { get: async () => NOW, set: async (text) => void writes.push(text) },
      clock: { now: () => 5_000 },
      log: { info: () => undefined, warn: () => undefined },
      changed: () => undefined,
    });
    return { prompts, writes, ...setup({ stageInstructions: (request) => prompts.stage(request) }) };
  }

  it("is a tool, and its description says it is staged for review and reaches the next session only", () => {
    const tool = TOOLS.find((item) => item.name === "propose_instructions_edit");
    expect(tool?.description).toMatch(/never applied by you: it is staged/u);
    expect(tool?.description).toMatch(/from the next voice session, never this one/u);
  });

  it("stages the edit, never applies it, and tells the voice what to say", async () => {
    const { run, prompts, writes, debug } = staging();
    const result = await run("propose_instructions_edit", { summary: "Call the user Sam", changes: [{ find: "speak briefly.", replace: "speak briefly, and call the user Sam." }] });
    expect(result).toMatchObject({ ok: true, staged: true });
    expect(String(result.note)).toMatch(/staged, not applied.*Voice page.*next voice session, not this one/u);
    expect(result).not.toHaveProperty("replaced_edit");
    expect(writes).toEqual([]);
    expect((await prompts.staged())?.proposed).toBe("You are Voice Pilot.\n\nStyle: speak briefly, and call the user Sam.");
    expect(debug.page(0).entries.at(-1)?.title).toBe("Staged an instructions edit for review: Call the user Sam");
  });

  it("says when it replaced the edit that was waiting", async () => {
    const { run } = staging();
    await run("propose_instructions_edit", { summary: "First", text: `${NOW}\n\nOne.` });
    const second = await run("propose_instructions_edit", { summary: "Second", text: `${NOW}\n\nTwo.` });
    expect(second).toMatchObject({ ok: true, replaced_edit: "First" });
    expect(String(second.note)).toMatch(/replaced the edit that was waiting/u);
  });

  it("refuses both or neither of changes and text, a malformed change, and a quote that is not there", async () => {
    const { run, prompts } = staging();
    expect(await run("propose_instructions_edit", { summary: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/either changes or the whole new text/u) });
    expect(await run("propose_instructions_edit", { summary: "x", text: "a", changes: [] })).toMatchObject({ ok: false });
    expect(await run("propose_instructions_edit", { summary: "x", changes: [{ find: 3 }] })).toMatchObject({ ok: false, error: expect.stringMatching(/find and a replace/u) });
    expect(await run("propose_instructions_edit", { summary: "x", changes: [{ find: "missing", replace: "y" }] })).toMatchObject({ ok: false, error: expect.stringMatching(/not in the instructions/u) });
    await expect(prompts.staged()).resolves.toBeNull();
  });

  it("is refused where nothing can stage it", async () => {
    const { run } = setup();
    expect(await run("propose_instructions_edit", { summary: "x", text: "y" })).toMatchObject({ ok: false });
  });
});
