/**
 * Updates a newer one overtook before their sentence was ready are carried
 * into the next sentence the tool writes for that thread, oldest first, until
 * one lands; nothing a thread said is lost because it said more right after.
 */
import { describe, expect, it, vi } from "vitest";

import { NO_CHOICE } from "../shared/thread-choice";
import { createHooks, type HeraldConfig, type HookDeps } from "./hooks";
import type { EventsPort } from "./ports";
import { AttentionStore } from "./store";
import { CARRY_MAX_UPDATES } from "./carry";
import { question, recordingLog, settle, thread } from "./testing/fixtures";
import type { WrittenSentence } from "./writer";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  sentence: { command: "my-llm", prompt: "Event: {{event}}\nOutput: {{output}}", reply: "claude-json" },
  push: false,
};

let questionAnswered = false;
const events: EventsPort = {
  async context(_thread, { withRequest }) {
    return { projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Review the PR" : null };
  },
  async interruptedRecently() {
    return false;
  },
  async interactionPending() {
    return !questionAnswered;
  },
};

/** A writer where every run waits for the test to answer it, by its index. */
function runs() {
  const calls: Array<{ prompt: string; answer: (written: WrittenSentence) => void }> = [];
  const write: HookDeps["writeSentence"] = (_command, prompt) =>
    new Promise<WrittenSentence>((resolve) => calls.push({ prompt, answer: resolve }));
  return {
    write,
    calls,
    prompt: (index: number) => calls[index]?.prompt ?? "",
    say: (index: number, text: string) => calls[index]?.answer({ kind: "sentence", text }),
    silence: (index: number) => calls[index]?.answer({ kind: "silent" }),
  };
}

function setup(write: HookDeps["writeSentence"], config: HeraldConfig = CONFIG) {
  const store = new AttentionStore(null, recordingLog());
  const remembered = vi.fn();
  const log = recordingLog();
  const hooks = createHooks({ store, readConfig: async () => config, events, choiceOf: async () => NO_CHOICE, publish: vi.fn(), log, writeSentence: write, remember: remembered, now: ticking() });
  return { hooks, store, remembered, log };
}

/** A clock that moves a second on every reading, so each event has its own id. */
function ticking(): () => Date {
  let at = 1_700_000_000_000;
  return () => new Date((at += 1_000));
}

/** One turn of a thread: it starts, and ends saying `output`. */
async function turn(hooks: ReturnType<typeof setup>["hooks"], output: string, id = "t1") {
  hooks.active(thread({ id }));
  await hooks.idle(thread({ id }), output);
}

const REVIEW = "Review done: two findings, both fixed. PR https://github.com/o/r/pull/7 is green.";
const SHIPSHAPE = "Captain, shipshape.";

describe("hooks carrying overtaken updates", () => {
  it("gives the tool a substantive update that two quick no-op turns overtook, and speaks it", async () => {
    const w = runs();
    const { hooks, store, remembered } = setup(w.write);
    await turn(hooks, REVIEW);
    await turn(hooks, SHIPSHAPE);
    await turn(hooks, SHIPSHAPE);
    expect(w.calls).toHaveLength(3);
    // The first two runs answer late: their entries were taken back by the next turn.
    w.say(0, "Too late.");
    w.silence(1);
    await settle();
    const last = w.prompt(2);
    expect(last).toContain(REVIEW);
    expect(last.split(SHIPSHAPE)).toHaveLength(3);
    // Oldest first, each one told apart.
    expect(last.indexOf(REVIEW)).toBeLessThan(last.indexOf(SHIPSHAPE));
    expect(last).toContain("Update 1 of 3");
    expect(last).toContain("Update 3 of 3, the latest");
    w.say(2, "The review is done and the PR is green.");
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "The review is done and the PR is green." });
    expect(remembered).toHaveBeenCalledTimes(1);
  });

  it("forgets what a spoken sentence covered", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, REVIEW);
    await turn(hooks, "Second.");
    w.say(1, "Both done.");
    await settle();
    await turn(hooks, "Third.");
    expect(w.prompt(2)).toBe("Event: finished its turn\nOutput: Third.");
  });

  it("forgets what a chosen silence covered", async () => {
    const w = runs();
    const { hooks, store } = setup(w.write);
    await turn(hooks, SHIPSHAPE);
    await turn(hooks, SHIPSHAPE);
    expect(w.prompt(1)).toContain("Update 1 of 2");
    w.silence(1);
    await settle();
    expect(store.get("t1")?.summary.status).toBe("quiet");
    await turn(hooks, "Next.");
    expect(w.prompt(2)).toBe("Event: finished its turn\nOutput: Next.");
  });

  it("keeps carrying while every run is overtaken", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, "One.");
    await turn(hooks, "Two.");
    await turn(hooks, "Three.");
    w.say(0, "Late.");
    w.say(1, "Late.");
    await settle();
    const last = w.prompt(2);
    expect(last.indexOf("One.")).toBeLessThan(last.indexOf("Two."));
    expect(last.indexOf("Two.")).toBeLessThan(last.indexOf("Three."));
  });

  it("carries a finished turn the next turn overtook while it was still being looked up", async () => {
    const w = runs();
    let release: () => void = () => {};
    let gated = true;
    const slow: EventsPort = {
      ...events,
      async context(thread, options) {
        if (gated) {
          gated = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return events.context(thread, options);
      },
    };
    const store = new AttentionStore(null, recordingLog());
    const hooks = createHooks({ store, readConfig: async () => CONFIG, events: slow, choiceOf: async () => NO_CHOICE, publish: vi.fn(), log: recordingLog(), writeSentence: w.write, remember: vi.fn(), now: ticking() });
    const first = hooks.idle(thread(), REVIEW);
    hooks.active(thread());
    release();
    await first;
    expect(w.calls).toHaveLength(0);
    await hooks.idle(thread(), SHIPSHAPE);
    expect(w.prompt(0)).toContain(REVIEW);
    expect(w.prompt(0)).toContain("Update 2 of 2, the latest");
  });

  it("never merges updates from different threads", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, "Alpha work.", "t1");
    await turn(hooks, "Beta work.", "t2");
    await turn(hooks, "Alpha again.", "t1");
    expect(w.prompt(1)).toBe("Event: finished its turn\nOutput: Beta work.");
    expect(w.prompt(2)).toContain("Alpha work.");
    expect(w.prompt(2)).not.toContain("Beta work.");
  });

  it("carries a finished turn into a question that follows it", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, REVIEW);
    hooks.active(thread());
    await hooks.interactionPending(thread(), question());
    const prompt = w.prompt(1);
    expect(prompt).toContain("Event: asks the developer a question");
    expect(prompt).toContain(REVIEW);
    expect(prompt).toContain("Update 2 of 2, the latest: asks the developer a question");
  });

  it("keeps carrying past a question answered before its sentence landed", async () => {
    questionAnswered = false;
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, REVIEW);
    await hooks.interactionPending(thread(), question());
    questionAnswered = true;
    w.say(1, "Which database?");
    await settle();
    questionAnswered = false;
    await turn(hooks, "Done.");
    expect(w.prompt(2)).toContain(REVIEW);
  });

  it(`keeps at most ${CARRY_MAX_UPDATES} earlier updates, drops the oldest, and says so`, async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    const count = CARRY_MAX_UPDATES + 3;
    for (let index = 1; index <= count; index += 1) await turn(hooks, `Update number ${index}.`);
    const last = w.prompt(count - 1);
    expect(last).not.toContain("Update number 1.");
    expect(last).not.toContain("Update number 2.");
    expect(last).toContain("Update number 3.");
    expect(last).toContain(`Update number ${count}.`);
    expect(last).toContain("2 older updates were left out");
  });

  it("caps the carried text, dropping the oldest", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    for (const letter of ["a", "b", "c", "d"]) await turn(hooks, letter.repeat(10_000));
    const last = w.prompt(3);
    expect(last.length).toBeLessThan(15_000);
    expect(last).not.toContain("aaaa");
    expect(last).toContain("dddd");
    expect(last).toContain("left out");
  });

  it("forgets what a thread carried when it is archived", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, REVIEW);
    hooks.gone(thread());
    await hooks.idle(thread(), "After.");
    expect(w.prompt(1)).toBe("Event: finished its turn\nOutput: After.");
  });

  it("keeps what was carried past an event that is not announced", async () => {
    const w = runs();
    let config: HeraldConfig = CONFIG;
    const store = new AttentionStore(null, recordingLog());
    const hooks = createHooks({ store, readConfig: async () => config, events, choiceOf: async () => NO_CHOICE, publish: vi.fn(), log: recordingLog(), writeSentence: w.write, remember: vi.fn(), now: ticking() });
    await turn(hooks, REVIEW);
    config = { ...CONFIG, announce: { ...CONFIG.announce, finished: false } };
    await turn(hooks, "Not announced.");
    expect(store.get("t1")?.summary.status).toBe("off");
    config = CONFIG;
    await turn(hooks, "Announced again.");
    expect(w.calls).toHaveLength(2);
    expect(w.prompt(1)).toContain(REVIEW);
    expect(w.prompt(1)).not.toContain("Not announced.");
  });

  it("carries nothing when the plain sentence is spoken", async () => {
    const w = runs();
    let config: HeraldConfig = CONFIG;
    const store = new AttentionStore(null, recordingLog());
    const hooks = createHooks({ store, readConfig: async () => config, events, choiceOf: async () => NO_CHOICE, publish: vi.fn(), log: recordingLog(), writeSentence: w.write, remember: vi.fn(), now: ticking() });
    await turn(hooks, REVIEW);
    config = { ...CONFIG, sentence: null };
    await turn(hooks, "Plain.");
    config = CONFIG;
    await turn(hooks, "Model again.");
    expect(w.prompt(1)).toBe("Event: finished its turn\nOutput: Model again.");
  });
});
