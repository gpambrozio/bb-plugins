/**
 * The hooks with a model writing the sentence: the entry is listed at once
 * with its plain fallback while the tool runs, the tool's reply replaces it,
 * and a reply that fails, or arrives after the thread moved on, never does.
 */
import { describe, expect, it, vi } from "vitest";

import { createHooks, type HeraldConfig, type HookDeps } from "./hooks";
import type { EventsPort } from "./ports";
import { AttentionStore } from "./store";
import { question, recordingLog, settle, thread } from "./testing/fixtures";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  sentence: { command: "my-llm --fast", prompt: "Thread: {{thread}}\nEvent: {{event}}\nRequest: {{request}}\nOutput: {{output}}" },
};

const events: EventsPort = {
  async context(_thread, { withRequest }) {
    return { projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Fix the login bug" : null };
  },
  async interruptedRecently() {
    return false;
  },
};

function setup(write: HookDeps["writeSentence"], config: HeraldConfig = CONFIG) {
  const store = new AttentionStore(null, recordingLog());
  const publish = vi.fn();
  const remembered = vi.fn();
  const log = recordingLog();
  const hooks = createHooks({ store, readConfig: async () => config, events, publish, log, writeSentence: write, remember: remembered });
  return { hooks, store, publish, log, remembered };
}

/** A writer whose reply the test releases. */
function heldWriter() {
  let release: (text: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const calls: Array<{ command: string[]; prompt: string }> = [];
  const write: HookDeps["writeSentence"] = (command, prompt) => {
    calls.push({ command, prompt });
    return new Promise<string>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
  };
  return { write, calls, release: (text: string) => release(text), fail: (error: Error) => fail(error) };
}

describe("hooks with a model-written sentence", () => {
  it("lists the entry with its fallback while the tool writes, then speaks what the tool wrote", async () => {
    const w = heldWriter();
    const { hooks, store, publish, remembered } = setup(w.write);
    await hooks.idle(thread(), "I fixed auth.ts and added a test.");
    expect(store.get("t1")?.summary).toEqual({ status: "pending", fallback: "Login fix finished. I fixed auth.ts and added a test." });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(w.calls[0]?.command).toEqual(["my-llm", "--fast"]);
    expect(w.calls[0]?.prompt).toBe(
      "Thread: Login fix\nEvent: finished its turn\nRequest: Fix the login bug\nOutput: I fixed auth.ts and added a test.",
    );
    expect(remembered).not.toHaveBeenCalled();
    w.release("Login fix is done; nothing is left for you.");
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix is done; nothing is left for you." });
    expect(publish).toHaveBeenCalledTimes(2);
    // Remembered once it has landed, with the model's words.
    expect(remembered).toHaveBeenCalledTimes(1);
    expect(remembered).toHaveBeenCalledWith("t1", expect.objectContaining({ text: "Login fix is done; nothing is left for you." }));
  });

  it("falls back to the plain sentence when the tool fails, and says why in the log", async () => {
    const w = heldWriter();
    const { hooks, store, log } = setup(w.write);
    await hooks.interactionPending(thread(), question());
    w.fail(new Error("my-llm: command not found"));
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix has a question: Which DB? Options: Postgres / SQLite." });
    expect(log.lines.some((line) => line.includes("my-llm: command not found"))).toBe(true);
  });

  it("falls back when the command cannot be read", async () => {
    const w = heldWriter();
    const { hooks, store } = setup(w.write, { ...CONFIG, sentence: { command: 'my-llm "oops', prompt: "x" } });
    await hooks.idle(thread(), "Done.");
    await settle();
    expect(w.calls).toHaveLength(0);
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix finished. Done." });
  });

  it("takes back a sentence still being written when the agent works again, and keeps one already written", async () => {
    const w = heldWriter();
    const { hooks, store, publish, remembered } = setup(w.write);
    await hooks.idle(thread(), "Done.");
    w.release("Login fix is done.");
    await settle();
    expect(store.get("t1")?.summary.status).toBe("ready");
    hooks.active(thread());
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix is done." });

    publish.mockClear();
    remembered.mockClear();
    await hooks.idle(thread({ id: "t2" }), "Done.");
    hooks.active(thread({ id: "t2" }));
    expect(store.get("t2")).toBeNull();
    expect(publish).toHaveBeenCalledTimes(2);
    // Taken back before it was said: not part of the thread's history either.
    w.release("Too late.");
    await settle();
    expect(remembered).not.toHaveBeenCalled();
  });

  it("drops a sentence that arrives after the thread moved on", async () => {
    const w = heldWriter();
    const { hooks, store, publish } = setup(w.write);
    await hooks.idle(thread(), "Done.");
    hooks.active(thread());
    expect(store.get("t1")).toBeNull();
    w.release("Login fix is done.");
    await settle();
    expect(store.get("t1")).toBeNull();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("drops a sentence that arrives after a newer event replaced its entry", async () => {
    const first = heldWriter();
    const second = heldWriter();
    let turn = 0;
    const { hooks, store } = setup((command, prompt) => (turn++ === 0 ? first.write(command, prompt) : second.write(command, prompt)));
    await hooks.idle(thread(), "First.");
    hooks.active(thread());
    await hooks.interactionPending(thread(), question());
    first.release("Stale.");
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "pending", fallback: "Login fix has a question: Which DB? Options: Postgres / SQLite." });
    second.release("Login fix wants to know which database to use.");
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix wants to know which database to use." });
  });

  it("keeps a long request and a long detail from swamping the prompt", async () => {
    const w = heldWriter();
    const longEvents: EventsPort = {
      ...events,
      async context() {
        return { projectName: "Shop", folder: "repo", lastRequest: "r".repeat(20_000) };
      },
    };
    const store = new AttentionStore(null, recordingLog());
    const hooks = createHooks({ store, readConfig: async () => CONFIG, events: longEvents, publish: vi.fn(), log: recordingLog(), writeSentence: w.write, remember: vi.fn() });
    await hooks.idle(thread(), "o".repeat(20_000));
    expect(w.calls[0]?.prompt.length).toBeLessThan(6_000);
  });

  it("never runs the tool for an entry that is not announced", async () => {
    const w = heldWriter();
    const { hooks, store } = setup(w.write, { ...CONFIG, announce: { ...CONFIG.announce, finished: false } });
    await hooks.idle(thread(), "Done.");
    expect(w.calls).toHaveLength(0);
    expect(store.get("t1")?.summary).toEqual({ status: "off", fallback: "Login fix finished. Done." });
  });

  it("keeps a sentence that lands after unload out of the store", async () => {
    const w = heldWriter();
    const { hooks, store } = setup(w.write);
    await hooks.idle(thread(), "Done.");
    hooks.dispose();
    w.release("Too late.");
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "pending", fallback: "Login fix finished. Done." });
  });
});
