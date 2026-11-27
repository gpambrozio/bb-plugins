import { describe, expect, it } from "vitest";

import type { HookEvent, HookFileStatus, HookRun } from "../shared/hooks";
import { DebugLog } from "./debug-log";
import { HOOK_CALL_TIMEOUT_MS, HOOK_STATUS_TIMEOUT_MS, HookRunner, SPEAKING_SETTLE_MS, hookTarget, machineHookStatuses, type HookTarget } from "./hooks";
import { VoiceSessions } from "./session";
import { FakeBb, FakeClock, FakeRealtime, quietLog, settle } from "./testing/fakes";

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

const OK: HookRun = { exitCode: 0, signal: null, timedOut: false, failedToStart: false, durationMs: 40, bbServerUrl: null, relayNote: null };
const STUDIO: HookTarget = { hostId: "host_studio", name: "Studio" };

const RUNNABLE: HookFileStatus = { present: true, executable: true };

/** A machine with a hook file (or none) that runs it when the test says, or at once. */
function fakeHost(options: { manual?: boolean; file?: HookFileStatus | "silent" } = {}) {
  const runs: { hostId: string; event: HookEvent; reason: string | null }[] = [];
  const pending: { event: HookEvent; finish(run?: HookRun): void }[] = [];
  const file = { current: options.file ?? RUNNABLE };
  return {
    runs,
    pending,
    file,
    port: {
      status: (_hostId: string): Promise<HookFileStatus> =>
        file.current === "silent" ? new Promise<HookFileStatus>(() => undefined) : Promise.resolve(file.current),
      run: (hostId: string, input: { event: HookEvent; reason: string | null }) => {
        runs.push({ hostId, ...input });
        if (file.current !== "silent" && !file.current.present) return Promise.resolve(null);
        if (options.manual !== true) return Promise.resolve(OK);
        return new Promise<HookRun>((resolve) => pending.push({ event: input.event, finish: (run = OK) => resolve(run) }));
      },
    },
  };
}

async function setup(options: { file?: HookFileStatus | "silent"; manual?: boolean; target?: HookTarget } = {}) {
  const clock = new FakeClock();
  const log = quietLog();
  const host = fakeHost({ manual: options.manual, file: options.file });
  const runner = new HookRunner({ host: host.port, clock, log });
  const debug = new DebugLog("vp_1", clock.now(), () => clock.now());
  const hooks = runner.session(options.target ?? STUDIO, debug);
  hooks.start();
  await settle();
  const events = () => host.runs.map((run) => run.event);
  const hookEntries = () => debug.page(0).entries.filter((entry) => entry.kind === "hook").map((entry) => entry.title);
  return { clock, log, host, runner, debug, hooks, events, hookEntries };
}

function voiceSessions(host: ReturnType<typeof fakeHost>) {
  const realtime = new FakeRealtime();
  const clock = new FakeClock();
  const log = quietLog();
  const runner = new HookRunner({ host: host.port, clock, log });
  const sessions = new VoiceSessions({ realtime, bb: new FakeBb(), clock, log, publish: () => undefined, hooks: runner }, async () => ({
    model: "gpt-realtime-2.1",
    effort: "low",
    voice: "marin",
    eagerness: "auto" as const,
    instructions: "",
    announce: "talked-to" as const,
  }));
  return { realtime, clock, sessions };
}

describe("each machine's hook file, for the settings page", () => {
  it("is asked of every machine, and a machine that does not answer in time is not known", async () => {
    const clock = new FakeClock();
    const statuses = machineHookStatuses(
      [
        { id: "host_a", name: "Studio" },
        { id: "host_b", name: "Laptop" },
        { id: "host_c", name: "Offline" },
      ],
      {
        status: (hostId) =>
          hostId === "host_a"
            ? Promise.resolve(RUNNABLE)
            : hostId === "host_b"
              ? Promise.resolve({ present: false, executable: false })
              : new Promise(() => undefined),
      },
      clock,
    );
    await settle();
    await clock.advance(HOOK_STATUS_TIMEOUT_MS);
    expect(await statuses).toEqual([
      { hostId: "host_a", name: "Studio", status: RUNNABLE },
      { hostId: "host_b", name: "Laptop", status: { present: false, executable: false } },
      { hostId: "host_c", name: "Offline", status: null },
    ]);
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
  it("run listening-started on the window's machine, naming no command, and say where in the debug log", async () => {
    const { host, hookEntries } = await setup();
    expect(host.runs).toEqual([{ hostId: "host_studio", event: "listening-started", reason: null }]);
    expect(hookEntries()).toEqual([
      "The hook runs on Studio, this window's machine: ~/.config/voice-pilot/hook",
      "Hook listening-started on Studio: exit 0 after 40 ms",
    ]);
  });

  it("run when the user starts and stops talking", async () => {
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
    // A slow speaking hook does not hold your back.
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
    await hooks.end("ended by the user");
    const entry = debug.page(0).entries.at(-1);
    expect(entry).toMatchObject({ kind: "hook", title: "Hook listening-stopped on Studio: exit 0 after 40 ms", text: "VOICE_PILOT_REASON: ended by the user" });
  });

  it("put the hook's BB_SERVER_URL, or why it had none, beside each run in the debug log, and never more than the URL", async () => {
    const { hooks, debug, host } = await setup({ manual: true });
    host.pending.shift()!.finish({ ...OK, bbServerUrl: "http://127.0.0.1:57314" });
    await settle();
    expect(debug.page(0).entries.at(-1)).toMatchObject({
      title: "Hook listening-started on Studio: exit 0 after 40 ms",
      text: "BB_SERVER_URL: http://127.0.0.1:57314 (bb's relay on this machine; bb internals)",
    });
    const ending = hooks.end("ended by the user");
    await settle();
    host.pending.shift()!.finish({ ...OK, relayNote: "lsof did not answer within 1 s" });
    await ending;
    expect(debug.page(0).entries.at(-1)).toMatchObject({
      title: "Hook listening-stopped on Studio: exit 0 after 40 ms",
      text: "VOICE_PILOT_REASON: ended by the user\nNo BB_SERVER_URL: lsof did not answer within 1 s",
    });
  });

  it("run nothing for a session whose machine has no hook file, one that is not executable, or one that does not answer", async () => {
    for (const [file, entry] of [
      [{ present: false, executable: false }, "No hook this session: Studio, this window's machine, has no hook file in ~/.config/voice-pilot/"],
      [{ present: true, executable: false }, "No hook this session: ~/.config/voice-pilot/hook on Studio is not executable (chmod +x)"],
      ["silent", "No hook this session: Studio did not say whether it has a hook file"],
    ] as const) {
      const { hooks, host, clock, hookEntries } = await setup({ file });
      await clock.advance(HOOK_STATUS_TIMEOUT_MS);
      hooks.event({ type: "input_audio_buffer.speech_started" }, false);
      await hooks.end("ended by the user");
      expect(host.runs).toEqual([]);
      expect(hookEntries()).toEqual([entry]);
    }
  });

  it("say nothing for each moment once the file has gone during the session", async () => {
    const { hooks, host, hookEntries } = await setup();
    host.file.current = { present: false, executable: false };
    hooks.event({ type: "input_audio_buffer.speech_started" }, false);
    await settle();
    expect(host.runs.map((run) => run.event)).toEqual(["listening-started", "talking-started"]);
    expect(hookEntries()).toHaveLength(2);
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
    const host = fakeHost();
    const { realtime, clock, sessions } = voiceSessions(host);
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
    const host = fakeHost({ manual: true });
    const { realtime, sessions } = voiceSessions(host);
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
    const host = fakeHost();
    const { realtime, clock, sessions } = voiceSessions(host);
    realtime.refuseNext = new Error("HTTP 400: invalid offer");
    await expect(sessions.start("v=0 not a real offer", STUDIO)).rejects.toThrow("invalid offer");
    await sessions.dispose();
    expect(host.runs).toEqual([]);
  });

  it("run nowhere for a session started with no machine", async () => {
    const host = fakeHost();
    const { realtime, sessions } = voiceSessions(host);
    await sessions.start("v=0 offer");
    realtime.last.open();
    realtime.last.emit({ type: "input_audio_buffer.speech_started" });
    await sessions.dispose();
    expect(host.runs).toEqual([]);
  });
});
