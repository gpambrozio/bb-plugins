import { describe, expect, it, vi, type Mock } from "vitest";

import { DEFAULT_SUMMARIZER } from "../shared/herald";
import { HelperOutcomes } from "./helpers";
import { createHooks, INTERRUPT_GRACE_MS, TURN_REPEAT_WINDOW_MS, type HeraldConfig, type HookDeps } from "./hooks";
import type { EventsPort } from "./ports";
import { AttentionStore } from "./store";
import type { Summary, SummaryRequest } from "./summarize";
import { commandApproval, question, recordingLog, settle, thread } from "./testing/fixtures";

const CONFIG: HeraldConfig = {
  announce: { question: true, plan: true, permission: true, finished: true, error: true },
  announceSubagents: false,
  // The helper path is what most of these tests exercise; the plain path has its own.
  modelSummaries: true,
  deleteHelpers: true,
  timeoutMs: 90_000,
  summarizer: DEFAULT_SUMMARIZER,
};

type SummarizeMock = Mock<(request: SummaryRequest, config: HeraldConfig) => Promise<Summary>>;

interface FakeEvents extends EventsPort {
  running: boolean;
  answered: boolean;
  interrupted: boolean;
  /** Runs inside the context lookup, to land an event while a handler awaits. */
  during: (() => void) | null;
}

function fakeEvents(): FakeEvents {
  const events: FakeEvents = {
    running: false,
    answered: false,
    interrupted: false,
    during: null,
    async context(_thread, { withRequest }) {
      events.during?.();
      return { projectName: "Shop", folder: "repo", lastRequest: withRequest ? "Fix the login bug" : null };
    },
    async isRunning() {
      return events.running;
    },
    async interactionPending() {
      return !events.answered;
    },
    async interruptedRecently() {
      return events.interrupted;
    },
  };
  return events;
}

/**
 * Most tests only care about the sentence; `finished` follows it unless a test
 * holds it to stand for a helper that is slow to stop.
 */
function setup(
  overrides: Omit<Partial<HookDeps>, "summarize"> & { summarize?: SummarizeMock; finished?: () => Promise<void> } = {},
  config: HeraldConfig = CONFIG,
) {
  let clock = Date.parse("2026-09-15T10:00:00.000Z");
  const store = new AttentionStore(null, recordingLog());
  const events = fakeEvents();
  const outcomes = new HelperOutcomes();
  const publish = vi.fn();
  const log = recordingLog();
  const summarize: SummarizeMock =
    overrides.summarize ??
    vi.fn(async (): Promise<Summary> => ({ text: "Login fix asks which database to use.", model: "claude-code/haiku" }));
  const hooks = createHooks({
    pluginId: "herald",
    store,
    readConfig: async () => config,
    events,
    outcomes,
    publish,
    log,
    now: () => new Date(clock),
    ...overrides,
    summarize: (request, cfg) => {
      const result = summarize(request, cfg);
      const settled = result.then(
        () => {},
        () => {},
      );
      return { result, finished: overrides.finished === undefined ? settled : settled.then(overrides.finished) };
    },
  });
  return {
    hooks,
    store,
    events,
    outcomes,
    publish,
    log,
    summarize,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createHooks", () => {
  it("records a question as pending, then fills in the summary", async () => {
    const { hooks, store, summarize, publish } = setup();
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
    });
    await settle();
    expect(store.get("t1")?.summary).toEqual({
      status: "ready",
      text: "Login fix asks which database to use.",
      model: "claude-code/haiku",
    });
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({
      thread: { id: "t1", title: "Login fix", projectName: "Shop", folder: "repo" },
      reason: "question",
      output: "",
      lastUser: null,
    });
    // Once for the pending entry, once for the summary.
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("turns a finished turn into an entry and ignores a silent one", async () => {
    const { hooks, store, summarize } = setup();
    await hooks.idle(thread(), "   ");
    expect(store.get("t1")).toBeNull();
    await hooks.idle(thread(), "I fixed auth.ts and added a test.");
    expect(store.get("t1")).toMatchObject({
      reason: "finished",
      headline: "Finished",
      detail: "I fixed auth.ts and added a test.",
      lastRequest: "Fix the login bug",
    });
    await settle();
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({
      output: "I fixed auth.ts and added a test.",
      lastUser: "Fix the login bug",
    });
  });

  it("hands the turn's text over as bb assembled it, without adding spaces", async () => {
    const { hooks, summarize } = setup();
    await hooks.idle(thread(), "Understood: no age cutoff, just drop closed sessions.\n");
    await settle();
    expect(summarize.mock.calls[0]?.[0].output).toBe("Understood: no age cutoff, just drop closed sessions.");
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
    const { hooks, store, summarize, advance } = setup();
    await hooks.idle(thread(), "Done.");
    const first = store.get("t1")?.eventId;
    advance(1000);
    await hooks.idle(thread(), "Done.");
    expect(store.get("t1")?.eventId).toBe(first);
    await settle();
    expect(summarize).toHaveBeenCalledTimes(1);

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

  it("says nothing and takes the entry back when the thread outran the summary", async () => {
    const releases: Array<(summary: Summary) => void> = [];
    const { hooks, store, publish } = setup({
      summarize: vi.fn(() => new Promise<Summary>((resolve) => releases.push(resolve))),
    });
    await hooks.idle(thread(), "Done.");
    await settle();
    hooks.active(thread());
    // The new turn removed the entry already; the late summary must not bring it back.
    releases[0]?.({ text: "Stale.", model: "m" });
    await settle();
    expect(store.get("t1")).toBeNull();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("withdraws a finish whose thread is running again by the time its summary lands", async () => {
    const { hooks, store, events } = setup();
    events.running = true;
    await hooks.idle(thread(), "Done.");
    await settle();
    expect(store.get("t1")).toBeNull();
  });

  it("says nothing about a question the user answered while its summary was written", async () => {
    const { hooks, store, events, publish } = setup();
    events.answered = true;
    await hooks.interactionPending(thread(), question());
    await settle();
    expect(store.get("t1")).toBeNull();
    // Recorded, then taken back.
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("asks bb whether the thread is running only about a finish", async () => {
    const { hooks, store, events } = setup();
    events.running = true;
    const asked = vi.spyOn(events, "isRunning");
    // A thread waiting on a question is mid-turn; that is the row worth keeping.
    await hooks.interactionPending(thread(), question());
    await settle();
    expect(asked).not.toHaveBeenCalled();
    expect(store.get("t1")?.summary.status).toBe("ready");
  });

  it("routes its own helpers' events to the outcomes and records nothing for them", async () => {
    const { hooks, store, outcomes } = setup();
    const helper = thread({ id: "h1", originPluginId: "herald", visibility: "hidden" });
    const waiting = outcomes.wait("h1", 1000);
    hooks.active(helper);
    await hooks.idle(helper, '{"speech":"Done."}');
    await expect(waiting).resolves.toEqual({ kind: "idle", text: '{"speech":"Done."}' });

    const failing = outcomes.wait("h2", 1000);
    await hooks.failed(thread({ id: "h2", originPluginId: "herald" }), "rate limited");
    await expect(failing).resolves.toEqual({ kind: "failed", error: "rate limited" });

    const asking = outcomes.wait("h3", 1000);
    await hooks.interactionPending(thread({ id: "h3", originPluginId: "herald" }), commandApproval("ls"));
    await expect(asking).resolves.toEqual({ kind: "interaction" });

    expect(store.list()).toEqual([]);
  });

  it("leaves another plugin's hidden threads alone", async () => {
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

  it("records without summarising when the event kind is switched off", async () => {
    const { hooks, store, summarize } = setup({}, { ...CONFIG, announce: { ...CONFIG.announce, finished: false } });
    await hooks.idle(thread(), "Done.");
    await settle();
    expect(store.get("t1")?.summary).toEqual({ status: "off", fallback: "Login fix finished. Done." });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("leaves a thread another thread started to the one that started it", async () => {
    const { hooks, store, summarize } = setup();
    await hooks.idle(thread({ parentThreadId: "parent" }), "Done.");
    await hooks.interactionPending(thread({ id: "t2", parentThreadId: "parent" }), question());
    await settle();
    expect(store.get("t1")?.summary.status).toBe("off");
    expect(store.get("t2")?.summary.status).toBe("off");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("announces subagents too when the user asks for them", async () => {
    const { hooks, store } = setup({}, { ...CONFIG, announceSubagents: true });
    await hooks.idle(thread({ parentThreadId: "parent" }), "Done.");
    await settle();
    expect(store.get("t1")?.summary.status).toBe("ready");
  });

  it("clears an entry when the thread moves on or goes away", async () => {
    const { hooks, store, publish } = setup();
    await hooks.interactionPending(thread(), question());
    await settle();
    publish.mockClear();
    hooks.active(thread());
    expect(store.get("t1")).toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
    // Nothing to remove, so nothing to tell the clients.
    hooks.active(thread());
    expect(publish).toHaveBeenCalledTimes(1);

    await hooks.idle(thread({ id: "t2" }), "Done.");
    hooks.gone(thread({ id: "t2" }));
    expect(store.get("t2")).toBeNull();
  });

  it("keeps the fallback when the summary fails, and never overwrites a newer event", async () => {
    const failing = setup({
      summarize: vi.fn(async () => {
        throw new Error("provider down");
      }),
    });
    await failing.hooks.interactionPending(thread(), question());
    await settle();
    expect(failing.store.get("t1")?.summary).toEqual({
      status: "failed",
      error: "provider down",
      fallback: "Login fix has a question: Which DB? Options: Postgres / SQLite.",
    });
    expect(failing.log.lines).toContain("error: The summary for thread t1 failed: provider down");

    const releases: Array<(summary: Summary) => void> = [];
    const slow = setup({ summarize: vi.fn(() => new Promise<Summary>((resolve) => releases.push(resolve))) });
    await slow.hooks.idle(thread(), "Done.");
    slow.hooks.active(thread());
    slow.advance(1000);
    await slow.hooks.failed(thread(), "boom");
    releases[0]?.({ text: "Stale.", model: "m" });
    await settle();
    expect(slow.store.get("t1")).toMatchObject({ reason: "error" });
    expect(slow.store.get("t1")?.summary.status).toBe("pending");
    releases[1]?.({ text: "Fresh.", model: "m" });
    await settle();
    expect(slow.store.get("t1")?.summary).toEqual({ status: "ready", text: "Fresh.", model: "m" });
  });

  it("runs at most two summaries at once by default, in the order threads finished", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const { hooks } = setup({
      summarize: vi.fn(async (request: SummaryRequest) => {
        order.push(request.thread.id);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return { text: "S.", model: "m" };
      }),
    });
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) await hooks.idle(thread({ id }), "Done.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peak).toBe(2);
    expect(order).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("skips a queued summary whose thread moved on while it waited", async () => {
    const releases: Array<(summary: Summary) => void> = [];
    const { hooks, summarize } = setup({
      maxConcurrent: 1,
      summarize: vi.fn(() => new Promise<Summary>((resolve) => releases.push(resolve))),
    });
    await hooks.idle(thread({ id: "t1" }), "Done.");
    await hooks.idle(thread({ id: "t2" }), "Done.");
    hooks.active(thread({ id: "t2" }));
    releases[0]?.({ text: "S.", model: "m" });
    await settle();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("drops the queue on drain, and waits for the running summary to put its helper away", async () => {
    const releases: Array<(summary: Summary) => void> = [];
    let stopped: () => void = () => {};
    const { hooks, summarize } = setup({
      maxConcurrent: 1,
      summarize: vi.fn(() => new Promise<Summary>((resolve) => releases.push(resolve))),
      finished: () => new Promise<void>((resolve) => (stopped = resolve)),
    });
    await hooks.idle(thread({ id: "t1" }), "Done.");
    await hooks.idle(thread({ id: "t2" }), "Done.");
    let drained = false;
    const draining = hooks.drain().then(() => (drained = true));
    releases[0]?.({ text: "S.", model: "m" });
    await settle();
    expect(drained).toBe(false);
    stopped();
    await draining;
    expect(summarize).toHaveBeenCalledTimes(1);
    // And nothing new is recorded after it.
    await hooks.idle(thread({ id: "t3" }), "Done.");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("keeps a slot until the helper has been put away, even once the sentence is out", async () => {
    const stops: Array<() => void> = [];
    let live = 0;
    let peak = 0;
    const { hooks, store } = setup({
      summarize: vi.fn(async () => {
        live += 1;
        peak = Math.max(peak, live);
        return { text: "S.", model: "m" };
      }),
      // Each helper takes its time to stop, as a timed-out one does.
      finished: () =>
        new Promise<void>((resolve) =>
          stops.push(() => {
            live -= 1;
            resolve();
          }),
        ),
    });
    for (const id of ["t1", "t2", "t3"]) await hooks.idle(thread({ id }), "Done.");
    await settle();
    // Two sentences are out, but the third helper must not start before one of them has stopped.
    expect(store.get("t1")?.summary.status).toBe("ready");
    expect(store.get("t3")?.summary.status).toBe("pending");
    expect(peak).toBe(2);
    stops.shift()?.();
    await settle();
    expect(store.get("t3")?.summary.status).toBe("ready");
    expect(peak).toBe(2);
  });

  it("does not let an older event's slow lookup land over a newer one in the same turn", async () => {
    const { hooks, store, events } = setup({}, { ...CONFIG, modelSummaries: false });
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

  it("announces the plain sentence without a helper when model summaries are off", async () => {
    const { hooks, store, summarize } = setup({}, { ...CONFIG, modelSummaries: false });
    await hooks.interactionPending(thread(), question());
    expect(store.get("t1")?.summary).toEqual({
      status: "ready",
      text: "Login fix has a question: Which DB? Options: Postgres / SQLite.",
      model: "plain",
    });
    expect(summarize).not.toHaveBeenCalled();
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
