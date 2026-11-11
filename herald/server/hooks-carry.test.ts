/**
 * Updates a newer one overtook before their sentence was ready are carried
 * into the next sentence the tool writes for that thread, oldest first, until
 * one lands; nothing a thread said is lost because it said more right after.
 */
import { describe, expect, it, vi } from "vitest";

import { NO_CHOICE, type ChoiceInputs } from "../shared/thread-choice";
import { createHooks, type HeraldConfig, type HookDeps } from "./hooks";
import type { EventsPort } from "./ports";
import { AttentionStore } from "./store";
import { CARRY_MAX_UPDATES } from "./carry";
import { question, recordingLog, settle, thread } from "./testing/fixtures";
import type { ReplyFormat } from "../shared/herald";
import { MAX_IN_FLIGHT, SentenceWriter, type WrittenSentence } from "./writer";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  sentence: { command: "my-llm", prompt: "Event: {{event}}\nOutput: {{output}}", reply: "claude-json" },
  push: false,
};

let questionAnswered = false;
const events: EventsPort = {
  async context(_thread, { withRequest }) {
    return { projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Review the PR" : null, turnRequest: null };
  },
  async interruptedRecently() {
    return false;
  },
  async interactionPending() {
    return !questionAnswered;
  },
};

/** A writer where every run waits for the test to answer it, by its index, and rejects when its run is stopped. */
function runs() {
  const calls: Array<{ prompt: string; answer: (written: WrittenSentence) => void; stopped: boolean }> = [];
  const write: HookDeps["writeSentence"] = (_command, prompt, _reply, signal) =>
    new Promise<WrittenSentence>((resolve, reject) => {
      const call = { prompt, answer: resolve, stopped: false };
      calls.push(call);
      signal.addEventListener("abort", () => {
        call.stopped = true;
        reject(new Error("The run was aborted."));
      });
    });
  return {
    write,
    calls,
    prompt: (index: number) => calls[index]?.prompt ?? "",
    say: (index: number, text: string) => calls[index]?.answer({ kind: "sentence", text }),
    silence: (index: number) => calls[index]?.answer({ kind: "silent" }),
  };
}

interface Options {
  config?: () => HeraldConfig;
  events?: EventsPort;
  choiceOf?: HookDeps["choiceOf"];
}

function setup(write: HookDeps["writeSentence"], options: Options = {}) {
  const store = new AttentionStore(null, recordingLog());
  const remembered = vi.fn();
  const log = recordingLog();
  const config = options.config ?? (() => CONFIG);
  const hooks = createHooks({
    store,
    readConfig: async () => config(),
    events: options.events ?? events,
    choiceOf: options.choiceOf ?? (async () => NO_CHOICE),
    publish: vi.fn(),
    log,
    writeSentence: write,
    remember: remembered,
    now: ticking(),
  });
  return { hooks, store, remembered, log };
}

/** A clock that moves a second on every reading, so each event has its own id. */
function ticking(): () => Date {
  let at = 1_700_000_000_000;
  return () => new Date((at += 1_000));
}

/** One turn of a thread: it starts, ends saying `output`, and its run (if any) has started. */
async function turn(hooks: ReturnType<typeof setup>["hooks"], output: string, id = "t1") {
  hooks.active(thread({ id }));
  await hooks.idle(thread({ id }), output);
  await settle();
}

/** A turn whose lookups the test holds (`deferredLookups`): it ends, and its handler is left waiting. */
async function heldTurn(hooks: ReturnType<typeof setup>["hooks"], output: string) {
  hooks.active(thread());
  void hooks.idle(thread(), output);
  await settle();
}

/**
 * Events whose context lookup for a given output waits until the test
 * releases it: the lookups of one turn answering after a later turn's.
 */
function deferredLookups() {
  const gates = new Map<string, () => void>();
  let holdNext = false;
  const port: EventsPort = {
    ...events,
    async context(thread, options) {
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => gates.set("held", resolve));
      }
      return events.context(thread, options);
    },
  };
  return {
    port,
    holdNext: () => (holdNext = true),
    release: () => gates.get("held")?.(),
  };
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
    await settle();
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
    await settle();
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

  it("stops the run a newer turn overtook, and lets a question's run be", async () => {
    const w = runs();
    const { hooks } = setup(w.write);
    await turn(hooks, REVIEW);
    await turn(hooks, SHIPSHAPE);
    expect(w.calls.map((call) => call.stopped)).toEqual([true, false]);
    await hooks.interactionPending(thread(), question({ id: "qa" }));
    await settle();
    await hooks.interactionPending(thread(), question({ id: "qb" }));
    await settle();
    // The finished turn's run was stopped by the first question; the questions both still run.
    expect(w.calls.map((call) => call.stopped)).toEqual([true, true, false, false]);
  });

  it("keeps carrying past a tool that failed: the plain sentence covers only its own update", async () => {
    let fail = false;
    const w = runs();
    const write: HookDeps["writeSentence"] = (command, prompt, reply, signal) => (fail ? Promise.reject(new Error("busy")) : w.write(command, prompt, reply, signal));
    const { hooks, store } = setup(write);
    await turn(hooks, REVIEW);
    fail = true;
    await turn(hooks, "Failed one.");
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix finished. Failed one." });
    fail = false;
    await turn(hooks, "Next.");
    expect(w.prompt(1)).toContain(REVIEW);
    expect(w.prompt(1)).not.toContain("Failed one.");
  });

  describe("with the real writer's two slots", () => {
    /** A tool that takes a moment, then sums up the review, and says nothing about anything else. */
    const TOOL = [
      process.execPath,
      "-e",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>setTimeout(()=>process.stdout.write(s.includes("Review done")?"The review is done and the PR is green.":""),300))`,
      "--",
    ];
    const REAL: HeraldConfig = { ...CONFIG, sentence: { command: TOOL.map((word) => JSON.stringify(word)).join(" "), prompt: CONFIG.sentence?.prompt ?? "", reply: "text" as ReplyFormat } };

    function real() {
      const log = recordingLog();
      const writer = new SentenceWriter(log);
      const parts = setup((command, prompt, reply, signal) => writer.write(command, prompt, reply, signal), { config: () => REAL });
      return { ...parts, writer, writerLog: log };
    }

    async function settled(store: AttentionStore) {
      await vi.waitFor(() => expect(store.get("t1")?.summary.status).not.toBe("pending"), { timeout: 10_000, interval: 50 });
    }

    it(`speaks a review two quick no-op turns overtook, within ${MAX_IN_FLIGHT} tools at once`, async () => {
      const { hooks, store, remembered, log, writer } = real();
      try {
        await turn(hooks, REVIEW);
        await turn(hooks, SHIPSHAPE);
        await turn(hooks, SHIPSHAPE);
        await settled(store);
        expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "The review is done and the PR is green." });
        expect(remembered).toHaveBeenCalledTimes(1);
        expect(log.lines.some((line) => line.includes("busy"))).toBe(false);
      } finally {
        await writer.dispose();
      }
    });

    it("keeps a burst of no-op turns quiet", async () => {
      const { hooks, store, remembered, log, writer } = real();
      try {
        await turn(hooks, SHIPSHAPE);
        await turn(hooks, SHIPSHAPE);
        await turn(hooks, SHIPSHAPE);
        await settled(store);
        expect(store.get("t1")?.summary.status).toBe("quiet");
        expect(remembered).not.toHaveBeenCalled();
        expect(log.lines.some((line) => line.includes("busy"))).toBe(false);
      } finally {
        await writer.dispose();
      }
    });
  });

  describe("when lookups answer out of order", () => {
    it("gives a later run an update whose lookups are still out, in arrival order", async () => {
      const lookups = deferredLookups();
      const w = runs();
      const { hooks } = setup(w.write, { events: lookups.port });
      lookups.holdNext();
      await heldTurn(hooks, REVIEW);
      expect(w.calls).toHaveLength(0);
      await turn(hooks, SHIPSHAPE);
      const first = w.prompt(0);
      expect(first).toContain("[Update 1 of 2: finished its turn]\n" + REVIEW);
      expect(first).toContain("[Update 2 of 2, the latest: finished its turn]\n" + SHIPSHAPE);
    });

    it("keeps arrival order when the older lookups answer during a later run", async () => {
      const lookups = deferredLookups();
      const w = runs();
      const { hooks } = setup(w.write, { events: lookups.port });
      lookups.holdNext();
      await heldTurn(hooks, REVIEW);
      await turn(hooks, "Second.");
      lookups.release();
      await settle();
      await turn(hooks, "Third.");
      const last = w.prompt(1);
      expect(last.indexOf(REVIEW)).toBeGreaterThan(-1);
      expect(last.indexOf(REVIEW)).toBeLessThan(last.indexOf("Second."));
      expect(last.indexOf("Second.")).toBeLessThan(last.indexOf("Third."));
    });

    it("does not bring an update back when its lookups answer after a silent run covered it", async () => {
      const lookups = deferredLookups();
      const w = runs();
      const { hooks } = setup(w.write, { events: lookups.port });
      lookups.holdNext();
      await heldTurn(hooks, REVIEW);
      await turn(hooks, SHIPSHAPE);
      w.silence(0);
      await settle();
      lookups.release();
      await settle();
      await turn(hooks, "Next.");
      expect(w.prompt(1)).toBe("Event: finished its turn\nOutput: Next.");
    });
  });

  describe("a late lookup after the thread was reset", () => {
    it("does not bring back what an archive or a delete forgot", async () => {
      // server.ts sends thread.archived and thread.deleted both to hooks.gone.
      const lookups = deferredLookups();
      const w = runs();
      const { hooks } = setup(w.write, { events: lookups.port });
      lookups.holdNext();
      await heldTurn(hooks, REVIEW);
      hooks.gone(thread());
      lookups.release();
      await settle();
      await turn(hooks, "After unarchiving.");
      expect(w.prompt(0)).toBe("Event: finished its turn\nOutput: After unarchiving.");
    });

    it("does not bring back what a plain sentence spoke for", async () => {
      let config = CONFIG;
      const lookups = deferredLookups();
      const w = runs();
      const { hooks } = setup(w.write, { events: lookups.port, config: () => config });
      lookups.holdNext();
      await heldTurn(hooks, REVIEW);
      config = { ...CONFIG, sentence: null };
      await turn(hooks, "Plain.");
      lookups.release();
      await settle();
      config = CONFIG;
      await turn(hooks, "Model again.");
      expect(w.calls).toHaveLength(1);
      expect(w.prompt(0)).toBe("Event: finished its turn\nOutput: Model again.");
    });
  });

  describe("caps for an event with no update of its own", () => {
    for (const [kind, end] of [
      ["question", (hooks: ReturnType<typeof setup>["hooks"]) => hooks.interactionPending(thread(), question())],
      ["error", (hooks: ReturnType<typeof setup>["hooks"]) => hooks.failed(thread(), "The tool crashed")],
    ] as const) {
      it(`gives the ${kind} event at most ${CARRY_MAX_UPDATES} earlier updates, and says how many were left out`, async () => {
        const w = runs();
        const { hooks } = setup(w.write);
        for (let index = 1; index <= CARRY_MAX_UPDATES + 1; index += 1) await turn(hooks, `Update number ${index}.`);
        hooks.active(thread());
        await end(hooks);
        await settle();
        const prompt = w.prompt(CARRY_MAX_UPDATES + 1);
        expect(prompt).toContain(`${CARRY_MAX_UPDATES + 1} updates from this thread`);
        expect(prompt).not.toContain("Update number 1.");
        expect(prompt).toContain("Update number 2.");
        expect(prompt).toContain("1 older update was left out");
      });

      it(`gives the ${kind} event at most the carried characters`, async () => {
        const w = runs();
        const { hooks } = setup(w.write);
        for (const letter of ["a", "b", "c"]) await turn(hooks, letter.repeat(3_000));
        hooks.active(thread());
        await end(hooks);
        await settle();
        const prompt = w.prompt(3);
        expect(prompt).not.toContain("aaaa");
        expect(prompt).toContain("bbbb");
        expect(prompt).toContain("cccc");
        expect(prompt).toContain("1 older update was left out");
        expect(prompt.length).toBeLessThan(7_000);
      });
    }
  });

  describe("a finished turn no tool writes for", () => {
    const DISABLED = "FINISHED ANNOUNCEMENTS ARE OFF: do not carry me";

    it("never reaches a question's prompt while its context is still being read", async () => {
      const lookups = deferredLookups();
      const w = runs();
      const config = { ...CONFIG, announce: { ...CONFIG.announce, finished: false } };
      const { hooks } = setup(w.write, { events: lookups.port, config: () => config });
      lookups.holdNext();
      await heldTurn(hooks, DISABLED);
      hooks.active(thread());
      await hooks.interactionPending(thread(), question());
      await settle();
      expect(w.calls).toHaveLength(1);
      expect(w.prompt(0)).not.toContain(DISABLED);
      lookups.release();
      await settle();
      expect(w.calls.every((call) => !call.prompt.includes(DISABLED))).toBe(true);
    });

    it("never reaches a question's prompt on a Questions-only thread", async () => {
      const lookups = deferredLookups();
      const w = runs();
      const questionsOnly: ChoiceInputs = { own: "questions", inherited: null };
      const { hooks } = setup(w.write, { events: lookups.port, choiceOf: async () => questionsOnly });
      lookups.holdNext();
      await heldTurn(hooks, DISABLED);
      hooks.active(thread());
      await hooks.interactionPending(thread(), question());
      await settle();
      expect(w.prompt(0)).toContain("Event: asks the developer a question");
      expect(w.prompt(0)).not.toContain(DISABLED);
    });

    it("waits for an earlier turn's choice before giving it to a run", async () => {
      let answerChoice: (choice: ChoiceInputs) => void = () => {};
      let slowNext = true;
      const w = runs();
      const { hooks } = setup(w.write, {
        choiceOf: () => {
          if (!slowNext) return Promise.resolve(NO_CHOICE);
          slowNext = false;
          return new Promise<ChoiceInputs>((resolve) => (answerChoice = resolve));
        },
      });
      hooks.active(thread());
      void hooks.idle(thread(), REVIEW);
      await settle();
      hooks.active(thread());
      await hooks.interactionPending(thread(), question());
      await settle();
      // The question's run waits on the review's choice before it is written.
      expect(w.calls).toHaveLength(0);
      answerChoice(NO_CHOICE);
      await settle();
      expect(w.calls).toHaveLength(1);
      expect(w.prompt(0)).toContain(REVIEW);
    });
  });
});
