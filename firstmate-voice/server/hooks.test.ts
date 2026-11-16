import { describe, expect, it } from "vitest";

import type { HookEvent, HookRun } from "../shared/hooks";
import { DebugLog } from "./debug-log";
import { HOOK_CALL_TIMEOUT_MS, HOOKS_KEY, HookRunner, HookStore, SPEAKING_SETTLE_MS, hookTarget, type HookTarget } from "./hooks";
import { VoiceSessions } from "./session";
import { FakeClock, FakeCrew, FakeRealtime, quietLog, settle } from "./testing/fakes";

/** The pairs run in lanes of their own, so only the order within each, and listening around them all, is fixed. */
function expectPairs(events: string[], counts: { talking: number; speaking: number }): void {
  expect(events[0]).toBe("listening-started");
  expect(events.at(-1)).toBe("listening-stopped");
  for (const pair of ["talking", "speaking"] as const) {
    const expected = Array.from({ length: counts[pair] }, () => [`${pair}-started`, `${pair}-stopped`]).flat();
    expect(events.filter((event) => event.startsWith(pair))).toEqual(expected);
  }
  expect(events).toHaveLength(2 + 2 * (counts.talking + counts.speaking));
}

const OK: HookRun = { exitCode: 0, signal: null, timedOut: false, failedToStart: false, durationMs: 40 };
const STUDIO: HookTarget = { hostId: "host_studio", name: "Studio" };

function fakeKv(initial: Record<string, unknown> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async <T>(key: string) => (rows.get(key) as T | undefined) ?? null,
    set: async (key: string, value: unknown) => void rows.set(key, value),
  };
}

/** A machine that runs each command when the test says, or at once. */
function fakeHost(options: { manual?: boolean } = {}) {
  const runs: { hostId: string; event: HookEvent; reason: string | null; command: string }[] = [];
  const pending: { event: HookEvent; finish(run?: HookRun): void }[] = [];
  return {
    runs,
    pending,
    port: {
      run: (hostId: string, input: { command: string; event: HookEvent; reason: string | null }) => {
        runs.push({ hostId, ...input });
        if (options.manual !== true) return Promise.resolve(OK);
        return new Promise<HookRun>((resolve) => pending.push({ event: input.event, finish: (run = OK) => resolve(run) }));
      },
    },
  };
}

async function setup(options: { command?: string | null; manual?: boolean; target?: HookTarget } = {}) {
  const clock = new FakeClock();
  const log = quietLog();
  const kv = fakeKv(options.command === null ? {} : { [HOOKS_KEY]: { host_studio: options.command ?? "~/bin/voice-hook" } });
  const store = new HookStore(kv, log);
  const host = fakeHost({ manual: options.manual });
  const runner = new HookRunner({ store, host: host.port, clock, log });
  const debug = new DebugLog("fmv_1", clock.now(), () => clock.now());
  const hooks = runner.session(options.target ?? STUDIO, debug);
  hooks.start();
  await settle();
  const events = () => host.runs.map((run) => run.event);
  const hookEntries = () => debug.page(0).entries.filter((entry) => entry.kind === "hook").map((entry) => entry.title);
  return { clock, log, kv, store, host, runner, debug, hooks, events, hookEntries };
}

describe("the hook store", () => {
  it("keeps one command per machine, forgets a machine set to empty, and lands two saves made at once", async () => {
    const kv = fakeKv();
    const store = new HookStore(kv, quietLog());
    await Promise.all([store.set("host_a", "say a"), store.set("host_b", "say b")]);
    expect(await store.all()).toEqual({ host_a: "say a", host_b: "say b" });
    expect(await store.set("host_a", "  \n")).toEqual({ host_b: "say b" });
    expect(await store.command("host_a")).toBeNull();
    expect(await store.command("host_b")).toBe("say b");
  });

  it("reads a row it cannot parse as no hooks at all, and says so", async () => {
    const log = quietLog();
    const store = new HookStore(fakeKv({ [HOOKS_KEY]: { host_a: 42 } }), log);
    expect(await store.all()).toEqual({});
    expect(log.lines[0]).toMatch(/^error The voice hooks could not be read/u);
  });
});

describe("where a session's hooks run", () => {
  const hosts = [{ id: "host_studio", name: "Studio" }];

  it("is the desktop app's own machine, when it is one of bb's", () => {
    expect(hookTarget("desktop", "host_studio", hosts)).toEqual(STUDIO);
    expect(hookTarget("desktop", "host_other", hosts)).toMatchObject({ hostId: null });
    expect(hookTarget("desktop", null, hosts)).toMatchObject({ hostId: null });
  });

  it("is nowhere for the mobile app or a browser tab, whatever machine they name", () => {
    expect(hookTarget("mobile", "host_studio", hosts)).toEqual({ hostId: null, why: "bb's mobile app runs no hooks" });
    expect(hookTarget("browser", "host_studio", hosts)).toMatchObject({ hostId: null });
    expect(hookTarget(undefined, "host_studio", hosts)).toMatchObject({ hostId: null });
  });
});

describe("a session's hooks", () => {
  it("run listening-started on the window's machine with its command, and say where in the debug log", async () => {
    const { host, hookEntries } = await setup();
    expect(host.runs).toEqual([{ hostId: "host_studio", event: "listening-started", reason: null, command: "~/bin/voice-hook" }]);
    expect(hookEntries()).toEqual(["Hooks run on Studio, this window's machine", "Hook listening-started on Studio: exit 0 after 40 ms"]);
  });

  it("run when the captain starts and stops talking", async () => {
    const { hooks, events } = await setup();
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    hooks.event({ type: "input_audio_buffer.speech_stopped" }, false);
    await settle();
    expect(events()).toEqual(["listening-started", "talking-started", "talking-stopped"]);
  });

  it("start speaking at the first sign of a spoken reply, before its audio, and stop once it is quiet with nothing under way", async () => {
    const { hooks, clock, events } = await setup();
    hooks.event({ type: "response.created" }, true);
    // A tool call alone is not speech.
    hooks.event({ type: "response.output_item.added", item: { type: "function_call" } }, true);
    await settle();
    expect(events()).toEqual(["listening-started"]);
    hooks.event({ type: "response.output_item.added", item: { type: "message" } }, true);
    await settle();
    expect(events()).toEqual(["listening-started", "speaking-started"]);
    hooks.event({ type: "output_audio_buffer.started" }, true);
    hooks.event({ type: "response.done" }, false);
    await clock.advance(SPEAKING_SETTLE_MS * 3);
    // Still playing: the reply is heard to its end first.
    expect(events()).toEqual(["listening-started", "speaking-started"]);
    hooks.event({ type: "output_audio_buffer.stopped" }, false);
    await clock.advance(SPEAKING_SETTLE_MS - 1);
    expect(events()).toEqual(["listening-started", "speaking-started"]);
    await clock.advance(1);
    expect(events()).toEqual(["listening-started", "speaking-started", "speaking-stopped"]);
  });

  it("share one pair for replies back to back, a tool call between them included", async () => {
    const { hooks, clock, events } = await setup();
    hooks.event({ type: "output_audio_buffer.started" }, true);
    hooks.event({ type: "response.done" }, false);
    hooks.event({ type: "output_audio_buffer.stopped" }, false);
    await clock.advance(SPEAKING_SETTLE_MS / 2);
    // The tool's answer is read in a new response.
    hooks.event({ type: "response.created" }, true);
    await clock.advance(SPEAKING_SETTLE_MS * 5);
    hooks.event({ type: "response.output_item.added", item: { type: "message" } }, true);
    hooks.event({ type: "output_audio_buffer.started" }, true);
    hooks.event({ type: "response.done" }, false);
    hooks.event({ type: "output_audio_buffer.cleared" }, false);
    await clock.advance(SPEAKING_SETTLE_MS);
    expect(events()).toEqual(["listening-started", "speaking-started", "speaking-stopped"]);
  });

  it("close the open pairs when the session ends, then run listening-stopped with the reason", async () => {
    const { hooks, host, events } = await setup();
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    hooks.event({ type: "output_audio_buffer.started" }, true);
    await hooks.end("quiet for ten minutes");
    expectPairs(events(), { talking: 1, speaking: 1 });
    expect(host.runs.at(-1)).toMatchObject({ event: "listening-stopped", reason: "quiet for ten minutes" });
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    await hooks.end("again");
    await settle();
    expect(host.runs).toHaveLength(6);
  });

  it("wait for listening-started before any other, and never run a stopped before its started has finished", async () => {
    const { hooks, host, events } = await setup({ manual: true });
    hooks.event({ type: "output_audio_buffer.started" }, true);
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    await settle();
    expect(events()).toEqual(["listening-started"]);
    host.pending.shift()!.finish();
    await settle();
    expect(events()).toEqual(["listening-started", "speaking-started", "talking-started"]);
    hooks.event({ type: "input_audio_buffer.speech_stopped" }, false);
    await settle();
    expect(events()).toEqual(["listening-started", "speaking-started", "talking-started"]);
    // A slow speaking hook does not hold the captain's back.
    host.pending.find((run) => run.event === "talking-started")!.finish();
    await settle();
    expect(events()).toEqual(["listening-started", "speaking-started", "talking-started", "talking-stopped"]);
  });

  it("go on without a machine that never answers, and say so in the debug log and the plugin's log", async () => {
    const { hooks, host, clock, log, events, hookEntries } = await setup({ manual: true });
    host.pending.shift()!.finish();
    await settle();
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    hooks.event({ type: "input_audio_buffer.speech_stopped" }, false);
    await settle();
    expect(events()).toEqual(["listening-started", "talking-started"]);
    await clock.advance(HOOK_CALL_TIMEOUT_MS);
    expect(events()).toEqual(["listening-started", "talking-started", "talking-stopped"]);
    expect(hookEntries()).toContain("Hook talking-started on Studio did not run: the machine did not answer within 10 s");
    expect(log.lines.some((line) => line.startsWith("warn The voice hook for talking-started on Studio did not run"))).toBe(true);
  });

  it("record a hook that failed or was stopped, with its status and never its output", async () => {
    const { hooks, host, hookEntries, log } = await setup({ manual: true });
    host.pending.shift()!.finish({ ...OK, exitCode: 3, durationMs: 12 });
    await settle();
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    await settle();
    host.pending.shift()!.finish({ ...OK, exitCode: null, signal: "SIGKILL", timedOut: true, durationMs: 5_004 });
    await settle();
    expect(hookEntries().slice(1)).toEqual(["Hook listening-started on Studio: exit 3 after 12 ms", "Hook talking-started on Studio: stopped after 5 s, too slow"]);
    expect(log.lines.filter((line) => line.startsWith("warn"))).toHaveLength(2);
  });

  it("put the reason beside listening-stopped in the debug log", async () => {
    const { hooks, debug } = await setup();
    await hooks.end("ended by the captain");
    const entry = debug.page(0).entries.at(-1);
    expect(entry).toMatchObject({ kind: "hook", title: "Hook listening-stopped on Studio: exit 0 after 40 ms", text: "FIRSTMATE_VOICE_REASON: ended by the captain" });
  });

  it("run nothing for a machine with no command, and read the command when each run's turn comes", async () => {
    const { hooks, store, host, hookEntries } = await setup({ command: null });
    expect(host.runs).toEqual([]);
    expect(hookEntries()).toEqual(["No hook is set for Studio, this window's machine"]);
    await store.set("host_studio", "say hi");
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    await settle();
    expect(host.runs).toEqual([{ hostId: "host_studio", event: "talking-started", reason: null, command: "say hi" }]);
  });

  it("run nothing anywhere for a window with no machine, and say why", async () => {
    const { hooks, host, hookEntries } = await setup({ target: { hostId: null, why: "bb's mobile app runs no hooks" } });
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    hooks.event({ type: "output_audio_buffer.started" }, true);
    await hooks.end("bb left the screen");
    expect(host.runs).toEqual([]);
    expect(hookEntries()).toEqual(["No hooks this session: bb's mobile app runs no hooks"]);
  });
});

describe("the hooks in a voice session", () => {
  it("run from the call's own events, and end with the session's reason, whatever ended it", async () => {
    const realtime = new FakeRealtime();
    const clock = new FakeClock();
    const log = quietLog();
    const host = fakeHost();
    const runner = new HookRunner({ store: new HookStore(fakeKv({ [HOOKS_KEY]: { host_studio: "hook" } }), log), host: host.port, clock, log });
    const sessions = new VoiceSessions({ realtime, crew: new FakeCrew(), clock, log, publish: () => undefined, hooks: runner }, async () => ({
      model: "gpt-realtime-2.1",
      effort: "low",
      voice: "marin",
      eagerness: "auto" as const,
    }));
    const { sessionId } = await sessions.start("v=0 offer", STUDIO);
    realtime.last.open();
    await settle();
    realtime.last.emit({ type: "input_audio_buffer.speech_started" });
    realtime.last.emit({ type: "input_audio_buffer.speech_stopped" });
    realtime.last.emit({ type: "response.created", response: { id: "resp_1" } });
    realtime.last.emit({ type: "response.output_item.added", item: { type: "message" } });
    realtime.last.emit({ type: "output_audio_buffer.started", response_id: "resp_1" });
    await settle();
    // The app stops answering: the session ends on its own, and the hooks are closed all the same.
    await clock.advance(60_000);
    expect(sessions.alive(sessionId)).toBe(false);
    await sessions.dispose();
    expectPairs(host.runs.map((run) => run.event), { talking: 1, speaking: 1 });
    expect(host.runs.at(-1)?.reason).toMatch(/./u);
  });

  it("run the old session's closing hooks before a new session's first, when a Talk takes over on the same machine", async () => {
    const realtime = new FakeRealtime();
    const clock = new FakeClock();
    const log = quietLog();
    const host = fakeHost({ manual: true });
    const runner = new HookRunner({ store: new HookStore(fakeKv({ [HOOKS_KEY]: { host_studio: "hook" } }), log), host: host.port, clock, log });
    const sessions = new VoiceSessions({ realtime, crew: new FakeCrew(), clock, log, publish: () => undefined, hooks: runner }, async () => ({
      model: "gpt-realtime-2.1",
      effort: "low",
      voice: "marin",
      eagerness: "auto" as const,
    }));
    await sessions.start("v=0 offer", STUDIO);
    realtime.last.open();
    await settle();
    host.pending.shift()!.finish(); // the first session's listening-started
    await settle();
    realtime.last.emit({ type: "output_audio_buffer.started", response_id: "resp_1" });
    await settle();
    // Its speaking-started is still running on the machine when another Talk takes over.
    expect(host.pending.map((run) => run.event)).toEqual(["speaking-started"]);
    await sessions.start("v=0 offer 2", STUDIO);
    realtime.last.open();
    for (let i = 0; i < 6 && host.pending.length > 0; i += 1) {
      await settle();
      host.pending.shift()!.finish();
      await settle();
    }
    expect(host.runs.map((run) => run.event)).toEqual(["listening-started", "speaking-started", "speaking-stopped", "listening-stopped", "listening-started"]);
    expect(host.runs[3]).toMatchObject({ reason: "a new session took over" });
  });

  it("run no hook for a Talk whose call OpenAI did not make", async () => {
    const realtime = new FakeRealtime();
    const clock = new FakeClock();
    const log = quietLog();
    const host = fakeHost();
    const runner = new HookRunner({ store: new HookStore(fakeKv({ [HOOKS_KEY]: { host_studio: "hook" } }), log), host: host.port, clock, log });
    const sessions = new VoiceSessions({ realtime, crew: new FakeCrew(), clock, log, publish: () => undefined, hooks: runner }, async () => ({
      model: "gpt-realtime-2.1",
      effort: "low",
      voice: "marin",
      eagerness: "auto" as const,
    }));
    realtime.refuseNext = new Error("HTTP 400: invalid offer");
    await expect(sessions.start("v=0 not a real offer", STUDIO)).rejects.toThrow("invalid offer");
    await sessions.dispose();
    expect(host.runs).toEqual([]);
  });

  it("run nowhere for a session started with no machine", async () => {
    const realtime = new FakeRealtime();
    const clock = new FakeClock();
    const host = fakeHost();
    const log = quietLog();
    const runner = new HookRunner({ store: new HookStore(fakeKv({ [HOOKS_KEY]: { host_studio: "hook" } }), log), host: host.port, clock, log });
    const sessions = new VoiceSessions({ realtime, crew: new FakeCrew(), clock, log, publish: () => undefined, hooks: runner }, async () => ({
      model: "gpt-realtime-2.1",
      effort: "low",
      voice: "marin",
      eagerness: "auto" as const,
    }));
    await sessions.start("v=0 offer");
    realtime.last.open();
    realtime.last.emit({ type: "input_audio_buffer.speech_started" });
    await sessions.dispose();
    expect(host.runs).toEqual([]);
  });
});
