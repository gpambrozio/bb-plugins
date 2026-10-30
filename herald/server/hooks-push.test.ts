/**
 * The hooks with Herald's push notifications: which events are handed to the
 * takeover with which choice, and what is sent — the plain sentence at once,
 * or the model's once it lands, or the plain one when Herald unloads first.
 */
import { describe, expect, it, vi } from "vitest";

import type { AttentionReason } from "../shared/herald";
import { NO_CHOICE, type ChoiceInputs, type ThreadChoice } from "../shared/thread-choice";
import { createHooks, type HeraldConfig, type HookDeps, type PushHooks } from "./hooks";
import type { EventsPort, ThreadDto } from "./ports";
import type { PushSubject } from "./push";
import { AttentionStore } from "./store";
import { commandApproval, planApproval, question, recordingLog, settle, thread } from "./testing/fixtures";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  sentence: null,
  push: true,
};

let answered = false;
const events: EventsPort = {
  context: async (_thread, { withRequest }) => ({ projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Fix the login bug" : null }),
  interruptedRecently: async () => false,
  interactionPending: async () => !answered,
};

interface FakePush extends PushHooks {
  decisions: Array<{ threadId: string; choice: ThreadChoice; reason: AttentionReason | null }>;
  sent: Array<{ subject: PushSubject; sentence: string }>;
  owes: boolean;
}

function fakePush(): FakePush {
  const fake: FakePush = {
    decisions: [],
    sent: [],
    owes: true,
    async decide(threadId, choiceOf, reason) {
      fake.decisions.push({ threadId, choice: await choiceOf(), reason });
      return reason !== null && fake.owes;
    },
    async send(subject, sentence) {
      fake.sent.push({ subject, sentence });
    },
  };
  return fake;
}

function setup(options: { config?: HeraldConfig; choice?: ChoiceInputs; write?: HookDeps["writeSentence"] } = {}) {
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
    push,
  });
  return { hooks, store, push };
}

function heldWriter() {
  let release: (text: string) => void = () => {};
  const write: HookDeps["writeSentence"] = () => new Promise<string>((resolve) => (release = resolve));
  return { write, release: (text: string) => release(text) };
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
    const { hooks, push } = setup({ config: { ...CONFIG, sentence: { command: "my-llm", prompt: "x" } }, write: w.write });
    await hooks.idle(thread(), "I fixed auth.ts.");
    await settle();
    expect(push.sent).toEqual([]);
    w.release("Login is fixed.");
    await settle();
    expect(push.sent.map((s) => s.sentence)).toEqual(["Login is fixed."]);
  });

  it("sends nothing for a question answered while its sentence was written", async () => {
    const w = heldWriter();
    const { hooks, push } = setup({ config: { ...CONFIG, sentence: { command: "my-llm", prompt: "x" } }, write: w.write });
    await hooks.interactionPending(thread(), question());
    answered = true;
    w.release("Too late.");
    await settle();
    expect(push.sent).toEqual([]);
  });

  it("sends the plain sentence on unload for a notification still waiting on its sentence", async () => {
    const w = heldWriter();
    const { hooks, push } = setup({ config: { ...CONFIG, sentence: { command: "my-llm", prompt: "x" } }, write: w.write });
    await hooks.interactionPending(thread(), question());
    await settle();
    await hooks.dispose();
    expect(push.sent.map((s) => s.sentence)).toEqual(["Login fix has a question: Which DB? Options: Postgres / SQLite."]);
    w.release("Late.");
    await settle();
    expect(push.sent).toHaveLength(1);
  });
});
