import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookRun, SpeechHookKind } from "../shared/speech-hooks";
import { DISPOSE_BUDGET_MS, HookSessions } from "./sessions";

const OK: HookRun = { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stderr: "" };
const COMMANDS = { before: "pause-music", after: "play-music", leaseMs: 30_000 };

function setup() {
  const order: string[] = [];
  /** Each command waits here until the test lets it finish, when `hold` is set. */
  const held: Array<{ kind: SpeechHookKind; finish(killed: boolean): void }> = [];
  const options = { hold: false };
  const timeouts: Array<number | undefined> = [];
  const expired: Array<{ runId: string; after: HookRun | null }> = [];
  const sessions = new HookSessions({
    run: async (kind: SpeechHookKind, command: string, timeoutMs?: number) => {
      order.push(`${kind}:${command}`);
      timeouts.push(timeoutMs);
      let killed = false;
      if (options.hold) {
        await new Promise<void>((resolve) =>
          held.push({
            kind,
            finish: (wasKilled) => {
              killed = wasKilled;
              resolve();
            },
          }),
        );
      }
      order.push(killed ? `${kind}:killed` : `${kind}:done`);
      return killed ? { ...OK, exitCode: null, signal: "SIGKILL" } : OK;
    },
    kill: (kind?: SpeechHookKind) => {
      for (const hook of held.splice(0)) {
        if (kind === undefined || hook.kind === kind) hook.finish(true);
        else held.push(hook);
      }
    },
    expired: (runId, after) => expired.push({ runId, after }),
  });
  const leases: Array<{ disposed: boolean; dispose(): Promise<void> }> = [];
  const lease = () => {
    const made = {
      disposed: false,
      dispose: async () => {
        made.disposed = true;
      },
    };
    leases.push(made);
    return made;
  };
  const release = async () => {
    held.shift()?.finish(false);
    await settle();
  };
  return { sessions, order, options, release, lease, leases, expired, timeouts };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HookSessions", () => {
  it("runs before when a run opens and after when it ends, in that order", async () => {
    const { sessions, order, lease, leases } = setup();
    await expect(sessions.begin({ runId: "r1", ...COMMANDS }, lease())).resolves.toEqual({ open: true, before: OK });
    expect(leases[0]?.disposed).toBe(false);
    await expect(sessions.end("r1")).resolves.toEqual(OK);
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music", "after:done"]);
    expect(leases[0]?.disposed).toBe(true);
  });

  it("keeps one session for runs that overlap — two windows — and runs after only when the last ends", async () => {
    const { sessions, order, lease } = setup();
    await sessions.begin({ runId: "window-a", ...COMMANDS }, lease());
    await expect(sessions.begin({ runId: "window-b", ...COMMANDS }, lease())).resolves.toEqual({ open: true, before: null });
    await expect(sessions.end("window-a")).resolves.toBeNull();
    expect(order).toEqual(["before:pause-music", "before:done"]);
    await sessions.end("window-b");
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music", "after:done"]);
  });

  it("makes a run that joins wait for the before hook still running", async () => {
    const { sessions, order, options, release, lease } = setup();
    options.hold = true;
    const first = sessions.begin({ runId: "a", ...COMMANDS }, lease());
    await settle();
    let joined = false;
    void sessions.begin({ runId: "b", ...COMMANDS }, lease()).then(() => {
      joined = true;
    });
    await settle();
    expect(joined).toBe(false);
    await release();
    await first;
    expect(joined).toBe(true);
    expect(order).toEqual(["before:pause-music", "before:done"]);
  });

  it("runs after only once the before hook it follows has finished, when the end comes early", async () => {
    const { sessions, order, options, release, lease } = setup();
    options.hold = true;
    void sessions.begin({ runId: "a", ...COMMANDS }, lease());
    await settle();
    const ended = sessions.end("a");
    await settle();
    expect(order).toEqual(["before:pause-music"]);
    await release();
    await release();
    await ended;
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music", "after:done"]);
  });

  it("opens nothing for a run whose end arrived first, and ignores a second end", async () => {
    const { sessions, order, lease, leases } = setup();
    await expect(sessions.end("late")).resolves.toBeNull();
    await expect(sessions.begin({ runId: "late", ...COMMANDS }, lease())).resolves.toEqual({ open: false, before: null });
    expect(leases[0]?.disposed).toBe(true);
    await sessions.begin({ runId: "r", ...COMMANDS }, lease());
    await sessions.end("r");
    await expect(sessions.end("r")).resolves.toBeNull();
    expect(order.filter((step) => step.startsWith("after:play"))).toHaveLength(1);
    expect(order.filter((step) => step.startsWith("before:pause"))).toHaveLength(1);
  });

  it("starts a new session's before only after the last session's after has finished", async () => {
    const { sessions, order, options, release, lease } = setup();
    await sessions.begin({ runId: "a", ...COMMANDS }, lease());
    options.hold = true;
    const ended = sessions.end("a");
    await settle();
    const next = sessions.begin({ runId: "b", ...COMMANDS }, lease());
    await settle();
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music"]);
    await release();
    await ended;
    await settle();
    await release();
    await next;
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music", "after:done", "before:pause-music", "before:done"]);
  });

  it("ends a run its window stopped renewing, runs after there, and says so", async () => {
    vi.useFakeTimers();
    const { sessions, order, lease, leases, expired } = setup();
    await sessions.begin({ runId: "gone", ...COMMANDS, leaseMs: 30_000 }, lease());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessions.renew("gone", 30_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(order).toEqual(["before:pause-music", "before:done"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music", "after:done"]);
    expect(expired).toEqual([{ runId: "gone", after: OK }]);
    expect(leases[0]?.disposed).toBe(true);
    expect(sessions.renew("gone", 30_000)).toBe(false);
    // The window comes back and ends it: nothing more runs.
    await expect(sessions.end("gone")).resolves.toBeNull();
  });

  it("runs the owed after hook when the worker is disposed, within the disposal budget, and reports it", async () => {
    const { sessions, order, lease, leases, timeouts } = setup();
    await sessions.begin({ runId: "a", ...COMMANDS }, lease());
    await sessions.begin({ runId: "b", ...COMMANDS }, lease());
    await expect(sessions.dispose()).resolves.toEqual({ runIds: ["a", "b"], after: OK });
    expect(order).toEqual(["before:pause-music", "before:done", "after:play-music", "after:done"]);
    expect(timeouts).toEqual([undefined, DISPOSE_BUDGET_MS]);
    expect(leases.every((made) => made.disposed)).toBe(true);
    await expect(sessions.begin({ runId: "c", ...COMMANDS }, lease())).resolves.toEqual({ open: false, before: null });
  });

  it("keeps a session for an after hook alone, and runs nothing for empty commands", async () => {
    const { sessions, order, lease } = setup();
    await expect(sessions.begin({ runId: "a", before: "", after: "play-music", leaseMs: 30_000 }, lease())).resolves.toEqual({
      open: true,
      before: null,
    });
    await sessions.end("a");
    expect(order).toEqual(["after:play-music", "after:done"]);
  });

  it("cuts a before hook short when the worker is disposed, then runs the after hook", async () => {
    const { sessions, order, options, lease } = setup();
    options.hold = true;
    void sessions.begin({ runId: "a", ...COMMANDS }, lease());
    await settle();
    options.hold = false;
    const report = await sessions.dispose();
    expect(order).toEqual(["before:pause-music", "before:killed", "after:play-music", "after:done"]);
    expect(report).toEqual({ runIds: ["a"], after: OK });
  });

  it("kills an after hook still running when the disposal budget is up", async () => {
    vi.useFakeTimers();
    const { sessions, order, options, lease } = setup();
    await sessions.begin({ runId: "a", ...COMMANDS }, lease());
    options.hold = true;
    const disposed = sessions.dispose();
    await vi.advanceTimersByTimeAsync(DISPOSE_BUDGET_MS - 1);
    expect(order.at(-1)).toBe("after:play-music");
    await vi.advanceTimersByTimeAsync(1);
    await expect(disposed).resolves.toEqual({ runIds: ["a"], after: { ...OK, exitCode: null, signal: "SIGKILL" } });
    expect(order.at(-1)).toBe("after:killed");
  });

  it("bounds and reports, without running it again, an after hook a window's end started when the worker is disposed", async () => {
    vi.useFakeTimers();
    const { sessions, order, options, lease } = setup();
    await sessions.begin({ runId: "a", ...COMMANDS }, lease());
    await sessions.begin({ runId: "b", ...COMMANDS }, lease());
    await sessions.end("b");
    options.hold = true;
    void sessions.end("a");
    await vi.advanceTimersByTimeAsync(0);
    const disposed = sessions.dispose();
    await vi.advanceTimersByTimeAsync(DISPOSE_BUDGET_MS);
    await expect(disposed).resolves.toEqual({ runIds: ["a", "b"], after: { ...OK, exitCode: null, signal: "SIGKILL" } });
    expect(order.filter((step) => step === "after:play-music")).toHaveLength(1);
    expect(order.at(-1)).toBe("after:killed");
  });

  it("reports nothing on dispose for an after hook that already finished", async () => {
    const { sessions, order, lease } = setup();
    await sessions.begin({ runId: "a", ...COMMANDS }, lease());
    await sessions.end("a");
    await expect(sessions.dispose()).resolves.toBeNull();
    expect(order.filter((step) => step === "after:play-music")).toHaveLength(1);
  });
});
