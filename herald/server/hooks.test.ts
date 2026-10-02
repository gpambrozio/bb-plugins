import { describe, expect, it, vi } from "vitest";

import { createHooks, INTERRUPT_GRACE_MS, TURN_REPEAT_WINDOW_MS, type HeraldConfig, type HookDeps } from "./hooks";
import type { EventsPort } from "./ports";
import { AttentionStore } from "./store";
import { commandApproval, question, recordingLog, thread } from "./testing/fixtures";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  sentence: null,
};

interface FakeEvents extends EventsPort {
  interrupted: boolean;
  /** Runs inside the context lookup, to land an event while a handler awaits. */
  during: (() => void) | null;
}

function fakeEvents(): FakeEvents {
  const events: FakeEvents = {
    interrupted: false,
    during: null,
    async context(_thread, { withRequest }) {
      events.during?.();
      return { projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Fix the login bug" : null };
    },
    async interruptedRecently() {
      return events.interrupted;
    },
  };
  return events;
}

function setup(overrides: Partial<HookDeps> = {}, config: HeraldConfig = CONFIG) {
  let clock = Date.parse("2026-09-15T10:00:00.000Z");
  const store = new AttentionStore(null, recordingLog());
  const events = fakeEvents();
  const publish = vi.fn();
  const log = recordingLog();
  const hooks = createHooks({
    store,
    readConfig: async () => config,
    events,
    publish,
    writeSentence: () => Promise.reject(new Error("no tool in these tests")),
    log,
    now: () => new Date(clock),
    ...overrides,
  });
  return {
    hooks,
    store,
    events,
    publish,
    log,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createHooks", () => {
  it("records a question with its plain sentence", async () => {
    const { hooks, store, publish } = setup();
    await hooks.interactionPending(thread(), question());
    expect(store.get("t1")).toMatchObject({
      reason: "question",
      requestId: "i1",
      eventId: "t1:interaction:i1",
      headline: "Which DB?",
      detail: "Postgres / SQLite",
      projectName: "Shop",
      threadTitle: "Login fix",
      lastRequest: null,
      summary: { status: "ready", text: "Login fix has a question: Which DB? Options: Postgres / SQLite." },
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("turns a finished turn into an entry and ignores a silent one", async () => {
    const { hooks, store } = setup();
    await hooks.idle(thread(), "   ");
    expect(store.get("t1")).toBeNull();
    await hooks.idle(thread(), "I fixed auth.ts and added a test.");
    expect(store.get("t1")).toMatchObject({
      reason: "finished",
      headline: "Finished",
      detail: "I fixed auth.ts and added a test.",
      lastRequest: "Fix the login bug",
      summary: { status: "ready", text: "Login fix finished. I fixed auth.ts and added a test." },
    });
  });

  it("takes the turn's text as bb assembled it, without adding spaces", async () => {
    const { hooks, store } = setup();
    await hooks.idle(thread(), "Understood: no age cutoff, just drop closed sessions.\n");
    expect(store.get("t1")?.detail).toBe("Understood: no age cutoff, just drop closed sessions.");
  });

  it("names a failed turn", async () => {
    const { hooks, store } = setup();
    await hooks.failed(thread(), "Out of credits");
    expect(store.get("t1")).toMatchObject({ reason: "error", headline: "Out of credits", detail: null });
    await hooks.failed(thread({ id: "t2" }), null);
    expect(store.get("t2")?.headline).toBe("The turn failed");
  });

  it("does not announce the failure that follows the user interrupting a pending interaction", async () => {
    const { hooks, store, events } = setup();
    events.interrupted = true;
    await hooks.failed(thread(), "[ede_diagnostic] stop_reason=tool_use");
    expect(store.get("t1")).toBeNull();
  });

  it("asks about interruptions within the grace period", async () => {
    const { hooks, events } = setup();
    const asked = vi.spyOn(events, "interruptedRecently");
    await hooks.failed(thread(), "boom");
    expect(asked).toHaveBeenCalledWith("t1", INTERRUPT_GRACE_MS);
  });

  it("drops a repeated turn end, but not the next turn's", async () => {
    const { hooks, store, publish, advance } = setup();
    await hooks.idle(thread(), "Done.");
    const first = store.get("t1")?.eventId;
    advance(1000);
    await hooks.idle(thread(), "Done.");
    expect(store.get("t1")?.eventId).toBe(first);
    expect(publish).toHaveBeenCalledTimes(1);

    // A new turn in between makes it a new turn end.
    hooks.active(thread());
    advance(1000);
    await hooks.idle(thread(), "Done again.");
    expect(store.get("t1")?.eventId).not.toBe(first);

    // And so does the window running out.
    advance(TURN_REPEAT_WINDOW_MS + 1);
    await hooks.idle(thread({ id: "t2" }), "One.");
    advance(TURN_REPEAT_WINDOW_MS + 1);
    const before = store.get("t2")?.eventId;
    await hooks.idle(thread({ id: "t2" }), "One.");
    expect(store.get("t2")?.eventId).not.toBe(before);
  });

  it("drops what it learned when the thread moved on while it was loading", async () => {
    const { hooks, store, events } = setup();
    events.during = () => hooks.active(thread());
    await hooks.idle(thread(), "Done.");
    expect(store.get("t1")).toBeNull();
    await hooks.interactionPending(thread(), question());
    expect(store.get("t1")).toBeNull();
  });

  it("leaves hidden threads alone", async () => {
    const { hooks, store } = setup();
    const worker = thread({ originPluginId: "other", visibility: "hidden" });
    await hooks.idle(worker, "Done.");
    await hooks.failed(worker, "boom");
    await hooks.interactionPending(worker, question());
    expect(store.list()).toEqual([]);
  });

  it("ignores an interaction that is no longer pending", async () => {
    const { hooks, store } = setup();
    await hooks.interactionPending(thread(), { ...question(), status: "resolved" });
    expect(store.get("t1")).toBeNull();
  });

  it("lists without announcing when the event kind is switched off", async () => {
    const { hooks, store } = setup({}, { ...CONFIG, announce: { ...CONFIG.announce, finished: false } });
    await hooks.idle(thread(), "Done.");
    expect(store.get("t1")?.summary).toEqual({ status: "off", fallback: "Login fix finished. Done." });
  });

  it("leaves a thread another thread started to the one that started it", async () => {
    const { hooks, store } = setup();
    await hooks.idle(thread({ parentThreadId: "parent" }), "Done.");
    await hooks.interactionPending(thread({ id: "t2", parentThreadId: "parent" }), question());
    expect(store.get("t1")?.summary.status).toBe("off");
    expect(store.get("t2")?.summary.status).toBe("off");
  });

  it("announces subagents too when the user asks for them", async () => {
    const { hooks, store } = setup({}, { ...CONFIG, announceSubagents: true });
    await hooks.idle(thread({ parentThreadId: "parent" }), "Done.");
    expect(store.get("t1")?.summary.status).toBe("ready");
  });

  it("clears an entry when the thread moves on or goes away", async () => {
    const { hooks, store, publish } = setup();
    await hooks.interactionPending(thread(), question());
    publish.mockClear();
    // A new turn keeps a sentence already written: it stays above the composer until the next event.
    hooks.active(thread());
    expect(store.get("t1")).not.toBeNull();
    expect(publish).not.toHaveBeenCalled();

    await hooks.idle(thread({ id: "t2" }), "Done.");
    hooks.gone(thread({ id: "t2" }));
    expect(store.get("t2")).toBeNull();
  });

  it("does not let an older event's slow lookup land over a newer one in the same turn", async () => {
    const { hooks, store, events } = setup();
    const lookups: Array<() => void> = [];
    const original = events.context.bind(events);
    events.context = (thread, options) =>
      new Promise((resolve) => lookups.push(() => void original(thread, options).then(resolve)));
    const older = hooks.interactionPending(thread(), question({ id: "older" }));
    const newer = hooks.interactionPending(thread(), question({ id: "newer" }));
    // The newer question's lookup answers first, the older one's last.
    lookups[1]?.();
    await newer;
    lookups[0]?.();
    await older;
    expect(store.get("t1")?.eventId).toBe("t1:interaction:newer");
  });

  it("says the start of a huge command, and keeps all of it on the card", async () => {
    const { hooks, store } = setup();
    const command = `echo ${"x".repeat(3000)}`;
    await hooks.interactionPending(thread(), commandApproval(command));
    const entry = store.get("t1");
    expect(entry?.detail).toBe(command);
    const spoken = entry?.summary.status === "ready" ? entry.summary.text : "";
    expect(spoken.startsWith("Login fix is asking for permission. Wants to run a command Command: echo xxx")).toBe(true);
    expect(spoken.length).toBeLessThan(500);
  });

  it("logs a handler that fails instead of rejecting into the bb server", async () => {
    const { hooks, log } = setup({
      readConfig: async () => {
        throw new Error("settings unreadable");
      },
    });
    await expect(hooks.idle(thread(), "Done.")).resolves.toBeUndefined();
    expect(log.lines).toContain("error: Handling thread.idle failed: settings unreadable");
  });
});
