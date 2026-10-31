/**
 * The hooks with Herald's push notifications: which events are handed to the
 * takeover with which choice, and what is sent — the plain sentence at once,
 * or the model's once it lands, or the plain one when Herald unloads first.
 */
import { describe, expect, it, vi } from "vitest";

import type { AttentionReason } from "../shared/herald";
import { NO_CHOICE, type ChoiceInputs, type ThreadChoice } from "../shared/thread-choice";
import { createHooks, DISPOSE_DRAIN_MS, type HeraldConfig, type HookDeps, type PushHooks } from "./hooks";
import type { EventsPort, PushPort, ThreadDto } from "./ports";
import { OUTBOX_PREFIX, PushTakeover, RELEASE_QUIET_MS, SEND_RETRY_MS, type PushSubject } from "./push";
import { AttentionStore } from "./store";
import { commandApproval, planApproval, question, recordingLog, settle, thread } from "./testing/fixtures";
import type { WrittenSentence } from "./writer";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  sentence: null,
  push: true,
};

let answered = false;
/** When set, the next context lookup waits for it. */
let holdNextContext: Promise<void> | null = null;
const events: EventsPort = {
  async context(_thread, { withRequest }) {
    const hold = holdNextContext;
    holdNextContext = null;
    if (hold !== null) await hold;
    return { projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Fix the login bug" : null };
  },
  interruptedRecently: async () => false,
  interactionPending: async () => !answered,
};

interface FakePush extends PushHooks {
  seen: string[];
  /** The `takeOver` of each decision, in order. */
  takeOvers: boolean[];
  decisions: Array<{ threadId: string; choice: ThreadChoice; reason: AttentionReason | null }>;
  sent: Array<{ subject: PushSubject; sentence: string }>;
  owes: boolean;
}

function fakePush(): FakePush {
  const fake: FakePush = {
    seen: [],
    takeOvers: [],
    decisions: [],
    sent: [],
    owes: true,
    saw(threadId) {
      fake.seen.push(threadId);
    },

    async decide(threadId, choiceOf, event, takeOver = true) {
      fake.takeOvers.push(takeOver);
      fake.decisions.push({ threadId, choice: await choiceOf(), reason: event?.reason ?? null });
      return event !== null && fake.owes;
    },
    async send(subject, sentence) {
      fake.sent.push({ subject, sentence });
    },
  };
  return fake;
}

function setup(options: { config?: HeraldConfig; choice?: ChoiceInputs; write?: HookDeps["writeSentence"]; push?: PushHooks } = {}) {
  answered = false;
  const push = fakePush();
  const store = new AttentionStore(null, recordingLog());
  const hooks = createHooks({
    store,
    readConfig: async () => options.config ?? CONFIG,
    events,
    choiceOf: async () => options.choice ?? NO_CHOICE,
    publish: vi.fn(),
    log: recordingLog(),
    writeSentence: options.write ?? (() => Promise.reject(new Error("no tool"))),
    remember: vi.fn(),
    push: options.push ?? push,
  });
  return { hooks, store, push };
}

function heldWriter() {
  const runs: Array<{ resolve: (written: WrittenSentence) => void; reject: (error: Error) => void }> = [];
  const write: HookDeps["writeSentence"] = () => new Promise<WrittenSentence>((resolve, reject) => runs.push({ resolve, reject }));
  /** Each answers the `index`th run, the last one by default. */
  return {
    write,
    release: (text: string, index = runs.length - 1) => runs[index]?.resolve({ kind: "sentence", text }),
    /** The tool ran and replied with nothing. */
    silence: (index = runs.length - 1) => runs[index]?.resolve({ kind: "silent" }),
    fail: (index = runs.length - 1) => runs[index]?.reject(new Error("my-llm exited with 1")),
  };
}

/**
 * The real takeover over a bb whose every thread is at its default level,
 * with interactions answered by id; what it sends is recorded.
 */
function realPush(
  answeredIds: Set<string>,
  pendingFails: { value: boolean },
  shared: { rows?: Map<string, unknown>; sendFails?: { value: boolean }; own?: Map<string, string>; invalid?: { value: boolean } } = {},
) {
  const own = shared.own ?? new Map<string, string>();
  /** bb has invalidated this instance's handles: every call it makes fails. */
  const live = () => {
    if (shared.invalid?.value === true) throw new Error("plugin instance disposed");
  };
  const sent: Array<{ threadId: string; body: string }> = [];
  const port: PushPort = {
    unavailable: async () => null,
    ancestors: async () => [],
    descendants: async () => [],
    ownLevels: async (ids) => new Map(ids.flatMap((id) => (own.has(id) ? [[id, own.get(id) as "muted"]] : []))),
    setOwnLevel: async (id, level) => void (level === "inherit" ? own.delete(id) : own.set(id, level)),
    defaults: async () => ({ defaultLevel: "all", childLevel: "input-only" }),
    send: async ({ threadId, body }) => {
      live();
      if (shared.sendFails?.value === true) throw new Error("relay down");
      sent.push({ threadId, body });
    },
  };
  const rows = shared.rows ?? new Map<string, unknown>();
  const push = new PushTakeover({
    port,
    kv: {
      get: async <T>(key: string) => (live(), rows.get(key) as T | undefined),
      set: async (key: string, value: unknown) => (live(), void rows.set(key, value)),
      delete: async (key: string) => (live(), void rows.delete(key)),
      list: async (prefix?: string) => (live(), [...rows.keys()].filter((key) => prefix === undefined || key.startsWith(prefix))),
    },
    enabled: async () => true,
    facts: async () => ({ kind: "open", status: "active", lastReadAt: 0, latestAttentionAt: 1 }),
    interactionPending: async (_threadId, id) => {
      if (pendingFails.value) throw new Error("bb is away");
      return !answeredIds.has(id);
    },
    log: recordingLog(),
  });
  void push.setReady();
  return { push, sent, own, rows };
}

const failed = (hooks: ReturnType<typeof setup>["hooks"], t: ThreadDto) => hooks.failed(t, "Out of credits");

describe("hooks with push notifications", () => {
  it("sends each announced kind once, with its sentence, for the thread it came from", async () => {
    const { hooks, push } = setup();
    const worker = thread({ id: "worker", parentThreadId: "coordinator", title: "Worker" });
    await hooks.interactionPending(worker, question());
    await hooks.interactionPending(thread({ id: "t2" }), planApproval("Add a cache."));
    await hooks.interactionPending(thread({ id: "t3" }), commandApproval("rm -rf build"));
    await hooks.idle(thread({ id: "t4" }), "I fixed auth.ts.");
    await failed(hooks, thread({ id: "t5" }));
    await settle();
    expect(push.sent.map(({ subject, sentence }) => [subject.threadId, subject.reason, sentence])).toEqual([
      ["worker", "question", "Worker has a question: Which DB? Options: Postgres / SQLite."],
      ["t2", "plan", "Login fix has a plan ready for your approval. Plan ready for your approval"],
      ["t3", "permission", "Login fix is asking for permission. Wants to run a command Command: rm -rf build."],
      ["t4", "finished", "Login fix finished. I fixed auth.ts."],
      ["t5", "error", "Login fix stopped with an error. Out of credits"],
    ]);
    // The worker's own id, never its parent's: a tap opens the thread the event came from.
    expect(push.sent[0]?.subject).toMatchObject({ threadId: "worker", threadTitle: "Worker", projectName: "Shop", requestId: "i1" });
  });

  it("hands the takeover each thread's effective choice: Default resolved through its parent and the settings", async () => {
    const child = thread({ id: "child", parentThreadId: "t1" });
    let run = setup();
    await run.hooks.idle(child, "Done.");
    await run.hooks.idle(thread(), "Done.");
    expect(run.push.decisions.map((d) => [d.threadId, d.choice])).toEqual([
      ["child", "silent"],
      ["t1", "announce"],
    ]);

    run = setup({ choice: { own: null, inherited: { choice: "questions", threadId: "t1", fromParent: true } }, config: { ...CONFIG, announceSubagents: true } });
    await run.hooks.idle(child, "Done.");
    expect(run.push.decisions[0]?.choice).toBe("questions");

    run = setup({ choice: { own: "announce", inherited: null } });
    await run.hooks.idle(child, "Done.");
    expect(run.push.decisions[0]?.choice).toBe("announce");
  });

  it("sends what the takeover owes even for an event Herald does not speak, with the plain sentence", async () => {
    const { hooks, push, store } = setup({ choice: { own: "questions", inherited: null } });
    await failed(hooks, thread());
    await settle();
    expect(store.get("t1")?.summary.status).toBe("off");
    expect(push.sent.map((s) => s.sentence)).toEqual(["Login fix stopped with an error. Out of credits"]);
  });

  it("sends nothing the takeover does not owe", async () => {
    const { hooks, push } = setup();
    push.owes = false;
    await hooks.idle(thread(), "Done.");
    await settle();
    expect(push.sent).toEqual([]);
  });

  it("brings the level in line on a turn start, only with the switch on, and sends nothing then", async () => {
    let run = setup();
    run.hooks.active(thread());
    await settle();
    expect(run.push.decisions).toEqual([{ threadId: "t1", choice: "announce", reason: null }]);

    run = setup({ config: { ...CONFIG, push: false } });
    run.hooks.active(thread());
    await settle();
    expect(run.push.decisions).toEqual([]);
    expect(run.push.sent).toEqual([]);
  });

  it("sends the model's sentence once it lands, not the plain one", async () => {
    const w = heldWriter();
    const { hooks, push } = setup({ config: { ...CONFIG, sentence: { command: "my-llm", prompt: "x", reply: "text" } }, write: w.write });
    await hooks.idle(thread(), "I fixed auth.ts.");
    await settle();
    expect(push.sent).toEqual([]);
    w.release("Login is fixed.");
    await settle();
    expect(push.sent.map((s) => s.sentence)).toEqual(["Login is fixed."]);
  });

  it("hands the takeover the model's sentence for an event whose banner was withdrawn; the takeover judges news", async () => {
    const w = heldWriter();
    const { hooks, push, store } = setup({ config: { ...CONFIG, sentence: { command: "my-llm", prompt: "x", reply: "text" } }, write: w.write });
    await hooks.interactionPending(thread(), question());
    answered = true;
    w.release("Too late.");
    await settle();
    expect(store.get("t1")).toBeNull();
    expect(push.sent.map((s) => s.sentence)).toEqual(["Too late."]);
  });

  it("sends the plain sentence on unload for a notification still waiting on its sentence", async () => {
    const w = heldWriter();
    const { hooks, push } = setup({ config: { ...CONFIG, sentence: { command: "my-llm", prompt: "x", reply: "text" } }, write: w.write });
    await hooks.interactionPending(thread(), question());
    await settle();
    await hooks.dispose();
    expect(push.sent.map((s) => s.sentence)).toEqual(["Login fix has a question: Which DB? Options: Postgres / SQLite."]);
    w.release("Late.");
    await settle();
    expect(push.sent).toHaveLength(1);
  });

  describe("when the tool replies with nothing", () => {
    const MODEL: HeraldConfig = { ...CONFIG, sentence: { command: "my-llm", prompt: "x", reply: "text" } };
    type Fire = (hooks: ReturnType<typeof setup>["hooks"]) => Promise<void>;
    const WAITING: Array<{ name: string; fire: Fire; plain: string }> = [
      { name: "question", fire: (hooks) => hooks.interactionPending(thread(), question()), plain: "Login fix has a question: Which DB? Options: Postgres / SQLite." },
      { name: "plan", fire: (hooks) => hooks.interactionPending(thread(), planApproval("1. Add a test.")), plain: "" },
      { name: "permission", fire: (hooks) => hooks.interactionPending(thread(), commandApproval("npm test")), plain: "" },
      { name: "error", fire: (hooks) => hooks.failed(thread(), "Rate limited"), plain: "" },
    ];

    it("sends nothing for a finished turn, though bb was muted for it, and the decision still drains on unload", async () => {
      const w = heldWriter();
      const { hooks, push, store } = setup({ config: MODEL, write: w.write });
      await hooks.idle(thread(), "Captain, shipshape.");
      await settle();
      w.silence();
      await settle();
      expect(push.decisions.map((d) => d.reason)).toEqual(["finished"]);
      expect(push.sent).toEqual([]);
      expect(store.get("t1")?.summary).toEqual({ status: "quiet", attentionAt: 0 });
      await hooks.dispose();
      expect(push.sent).toEqual([]);
    });

    it("sends the plain sentence for every event that waits on the user", async () => {
      for (const { name, fire, plain } of WAITING) {
        const w = heldWriter();
        const { hooks, push, store } = setup({ config: MODEL, write: w.write });
        await fire(hooks);
        await settle();
        const pending = store.get("t1")?.summary;
        const fallback = pending?.status === "pending" ? pending.fallback : "none";
        if (plain !== "") expect(fallback, name).toBe(plain);
        w.silence();
        await settle();
        expect(push.sent.map((s) => s.sentence), name).toEqual([fallback]);
        expect(store.get("t1")?.summary, name).toEqual({ status: "off", fallback });
      }
    });

    it("sends nothing for an event that waits on the user when Herald owes nothing (push off, or bb never muted)", async () => {
      const w = heldWriter();
      const { hooks, push } = setup({ config: MODEL, write: w.write });
      push.owes = false;
      await hooks.interactionPending(thread(), question());
      w.silence();
      await settle();
      expect(push.sent).toEqual([]);
    });

    it("sends the plain sentence for a finished turn whose tool failed rather than replied with nothing", async () => {
      const w = heldWriter();
      const { hooks, push } = setup({ config: MODEL, write: w.write });
      await hooks.idle(thread(), "Done.");
      await settle();
      w.fail();
      await settle();
      expect(push.sent.map((s) => s.sentence)).toEqual(["Login fix finished. Done."]);
    });

    it("sends the plain sentence on unload for a finished turn whose tool had not answered yet", async () => {
      const w = heldWriter();
      const { hooks, push } = setup({ config: MODEL, write: w.write });
      await hooks.idle(thread(), "Done.");
      await settle();
      await hooks.dispose();
      expect(push.sent.map((s) => s.sentence)).toEqual(["Login fix finished. Done."]);
      w.silence();
      await settle();
      expect(push.sent).toHaveLength(1);
    });

    it("with the real takeover: a quiet finished turn is notified by no one and leaves nothing to retry; a quiet question goes out plain", async () => {
      const real = realPush(new Set(), { value: false });
      const w = heldWriter();
      const { hooks } = setup({ config: MODEL, write: w.write, push: real.push });
      hooks.active(thread());
      await settle();
      expect(real.own.get("t1")).toBe("muted");
      await hooks.idle(thread(), "Captain, shipshape.");
      await settle();
      w.silence();
      await settle();
      expect(real.sent).toEqual([]);
      expect([...real.rows.keys()].filter((key) => key.startsWith(OUTBOX_PREFIX))).toEqual([]);

      hooks.active(thread());
      await hooks.interactionPending(thread(), question());
      await settle();
      w.silence();
      await settle();
      expect(real.sent).toEqual([{ threadId: "t1", body: "Login fix has a question: Which DB? Options: Postgres / SQLite." }]);
      expect([...real.rows.keys()].filter((key) => key.startsWith(OUTBOX_PREFIX))).toEqual([]);
    });
  });

  it("settles an event a newer one replaced without taking a level", async () => {
    const { hooks, push } = setup();
    let release: () => void = () => {};
    holdNextContext = new Promise((resolve) => (release = resolve));
    const first = hooks.interactionPending(thread(), question({ id: "qa" }));
    await hooks.interactionPending(thread(), question({ id: "qb" }));
    release();
    await first;
    await settle();
    expect(push.takeOvers).toEqual([true, false]);
  });

  it("hears of each event before its lookups", async () => {
    const { hooks, push } = setup();
    void hooks.idle(thread(), "Done.");
    expect(push.seen).toEqual(["t1"]);
  });

  describe("with the real takeover", () => {
    const MODEL: HeraldConfig = { ...CONFIG, sentence: { command: "my-llm", prompt: "x", reply: "text" } };

    it("notifies a question whose banner a second question replaced, and not the second once answered", async () => {
      const answeredIds = new Set<string>();
      const real = realPush(answeredIds, { value: false });
      const w = heldWriter();
      const { hooks, store } = setup({ config: MODEL, write: w.write, push: real.push });
      hooks.active(thread());
      await settle();
      expect(real.own.get("t1")).toBe("muted");
      await hooks.interactionPending(thread(), question({ id: "qa" }));
      await hooks.interactionPending(thread(), question({ id: "qb" }));
      await settle();
      expect(store.get("t1")?.requestId).toBe("qb");
      answeredIds.add("qb");
      w.release("Question B, answered already.", 1);
      w.release("Login fix asks which database to use.", 0);
      await settle();
      expect(real.sent).toEqual([{ threadId: "t1", body: "Login fix asks which database to use." }]);
    });

    it("notifies a question when bb cannot say whether it was answered", async () => {
      const pendingFails = { value: false };
      const real = realPush(new Set(), pendingFails);
      const w = heldWriter();
      const { hooks } = setup({ config: MODEL, write: w.write, push: real.push });
      hooks.active(thread());
      await settle();
      await hooks.interactionPending(thread(), question());
      await settle();
      pendingFails.value = true;
      w.release("Login fix asks which database to use.");
      await settle();
      expect(real.sent.map((sent) => sent.body)).toEqual(["Login fix asks which database to use."]);
    });

    it("notifies a question whose lookups finished after a later question's, though the later one was answered", async () => {
      const answeredIds = new Set<string>();
      const real = realPush(answeredIds, { value: false });
      const { hooks, store } = setup({ push: real.push });
      hooks.active(thread());
      await settle();
      let release: () => void = () => {};
      holdNextContext = new Promise((resolve) => (release = resolve));
      const first = hooks.interactionPending(thread(), question({ id: "qa" }));
      // B is answered at once, so the only notification that may go is A's.
      answeredIds.add("qb");
      await hooks.interactionPending(thread(), question({ id: "qb" }));
      await settle();
      expect(real.sent).toEqual([]);
      release();
      await first;
      await settle();
      // The banner keeps the newer question; the notification goes for the one still waiting.
      expect(store.get("t1")?.requestId).toBe("qb");
      expect(real.sent.map((sent) => sent.body)).toEqual(["Login fix has a question: Which DB? Options: Postgres / SQLite."]);
    });

    it("finishes an event still being looked up when Herald unloads, and leaves its failed send to the next instance", async () => {
      const rows = new Map<string, unknown>();
      const sendFails = { value: false };
      const old = realPush(new Set(), { value: false }, { rows, sendFails });
      const { hooks } = setup({ push: old.push });
      hooks.active(thread());
      await settle();
      let release: () => void = () => {};
      holdNextContext = new Promise((resolve) => (release = resolve));
      const pending = hooks.interactionPending(thread(), question());
      sendFails.value = true;
      const disposing = hooks.dispose();
      await settle();
      release();
      await pending;
      await disposing;
      // Stored within the unload itself, before Herald says it is done.
      expect([...rows.keys()].some((key) => key.startsWith(OUTBOX_PREFIX))).toBe(true);
      await old.push.close();
      // The next instance finds it, and sends it once bb can.
      vi.useFakeTimers();
      try {
        sendFails.value = false;
        const next = realPush(new Set(), { value: false }, { rows, sendFails });
        await vi.advanceTimersByTimeAsync(SEND_RETRY_MS[0]);
        expect(next.sent.map((sent) => sent.body)).toEqual(["Login fix has a question: Which DB? Options: Postgres / SQLite."]);
        await next.push.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends, while it unloads for good, the plain notification of an event whose lookup outlasts its drain", async () => {
      vi.useFakeTimers();
      try {
        const own = new Map<string, string>();
        const invalid = { value: false };
        const old = realPush(new Set(), { value: false }, { own, invalid });
        const { hooks } = setup({ push: old.push });
        hooks.active(thread());
        await vi.advanceTimersByTimeAsync(0);
        expect(own.get("t1")).toBe("muted");
        let release: () => void = () => {};
        holdNextContext = new Promise((resolve) => (release = resolve));
        const pending = hooks.interactionPending(thread(), question());
        // Disabled: no next instance. The drain runs out with the lookup still out.
        const disposing = hooks.dispose();
        await vi.advanceTimersByTimeAsync(DISPOSE_DRAIN_MS + 1);
        await disposing;
        expect(old.sent).toEqual([{ threadId: "t1", body: "Login fix has a question: Which DB? Options: Postgres / SQLite." }]);
        const closing = old.push.close();
        await vi.advanceTimersByTimeAsync(RELEASE_QUIET_MS + 1);
        await closing;
        expect(own.has("t1")).toBe(false);
        // bb invalidates the old handles; the lookup returning then sends nothing more.
        invalid.value = true;
        release();
        await pending;
        await vi.advanceTimersByTimeAsync(0);
        expect(old.sent).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends nothing on unload for an event bb was never muted for", async () => {
      vi.useFakeTimers();
      try {
        const old = realPush(new Set(), { value: false });
        const { hooks } = setup({ push: old.push, config: { ...CONFIG, push: false } });
        let release: () => void = () => {};
        holdNextContext = new Promise((resolve) => (release = resolve));
        const pending = hooks.interactionPending(thread(), question());
        const disposing = hooks.dispose();
        await vi.advanceTimersByTimeAsync(DISPOSE_DRAIN_MS + 1);
        await disposing;
        release();
        await pending;
        await vi.advanceTimersByTimeAsync(0);
        expect(old.sent).toEqual([]);
        expect([...old.rows.keys()].some((key) => key.startsWith(OUTBOX_PREFIX))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
