import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpeechPlatform } from "../shared/settings";
import { createLocalHostLookup, createSpeechRunStarter, findLocalHostId, type SpeechRunDeps } from "./speech-hooks";

const SERVER = "http://127.0.0.1:38886";

function status(hostId: string, serverUrl = SERVER, connected = true) {
  return { hostId, connected, protocolVersion: 264, serverUrl, supportsNativeFolderPicker: true, platform: "darwin" };
}

describe("findLocalHostId", () => {
  it("is the host daemon on this machine connected to the server this window shows", async () => {
    const statuses: Record<number, unknown> = { 1: status("host_other", "http://127.0.0.1:48886"), 2: status("host_mine") };
    await expect(findLocalHostId([1, 2], SERVER, async (port) => statuses[port])).resolves.toBe("host_mine");
  });

  it("takes the first connected daemon when none names this window's server, as bb does", async () => {
    const statuses: Record<number, unknown> = { 1: status("host_a", "https://far.example"), 2: status("host_b", "https://far.example") };
    await expect(findLocalHostId([1, 2], "https://bb.example", async (port) => statuses[port])).resolves.toBe("host_a");
  });

  it("is null with no daemon, a daemon that does not answer, or one that is not connected", async () => {
    await expect(findLocalHostId([], SERVER)).resolves.toBeNull();
    await expect(findLocalHostId([1], SERVER, async () => Promise.reject(new Error("refused")))).resolves.toBeNull();
    await expect(findLocalHostId([1], SERVER, async () => status("host_a", SERVER, false))).resolves.toBeNull();
    await expect(findLocalHostId([1], SERVER, async () => ({ nonsense: true }))).resolves.toBeNull();
  });

  it("is looked up once when found, and again after a lookup that found nothing", async () => {
    let answer: unknown = null;
    const fetchStatus = vi.fn(async () => answer);
    const lookup = createLocalHostLookup(async () => [1], () => SERVER, fetchStatus);
    await expect(lookup()).resolves.toBeNull();
    answer = status("host_mine");
    await expect(lookup()).resolves.toBe("host_mine");
    await expect(lookup()).resolves.toBe("host_mine");
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function starter(overrides: Partial<SpeechRunDeps> = {}) {
  const calls: string[] = [];
  let next = 0;
  const deps = {
    platform: () => "desktop" as SpeechPlatform,
    localHostId: vi.fn(async () => "host_mine" as string | null),
    begin: vi.fn(async (hostId: string, runId: string) => {
      calls.push(`begin:${hostId}:${runId}`);
      return { open: true as boolean | null, error: null as string | null };
    }),
    renew: vi.fn(async (hostId: string, runId: string) => {
      calls.push(`renew:${hostId}:${runId}`);
      return { open: true };
    }),
    end: vi.fn(async (hostId: string, runId: string) => {
      calls.push(`end:${hostId}:${runId}`);
      return { error: null as string | null };
    }),
    report: vi.fn(),
    newRunId: () => `run${(next += 1)}`,
    ...overrides,
  };
  return { start: createSpeechRunStarter(deps), deps, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSpeechRunStarter", () => {
  it("opens a run on this machine, waits for it, and ends that same run there", async () => {
    const { start, calls } = starter();
    const run = start();
    await run.ready;
    await run.end();
    expect(calls).toEqual(["begin:host_mine:run1", "end:host_mine:run1"]);
  });

  it("ends a run once, however many times it is asked to", async () => {
    const { start, deps } = starter();
    const run = start();
    await run.ready;
    await Promise.all([run.end(), run.end()]);
    await run.end();
    expect(deps.end).toHaveBeenCalledTimes(1);
  });

  it("opens nothing, and reads nothing, outside bb's desktop app", async () => {
    for (const platform of ["browser", "mobile"] as const) {
      const { start, deps } = starter({ platform: () => platform });
      const run = start();
      await run.ready;
      await run.end();
      expect(deps.localHostId).not.toHaveBeenCalled();
      expect(deps.begin).not.toHaveBeenCalled();
      expect(deps.end).not.toHaveBeenCalled();
    }
  });

  it("opens nothing on a machine that is not one of bb's, and owes nothing for one with no hooks", async () => {
    const none = starter({ localHostId: async () => null });
    const run = none.start();
    await run.ready;
    await run.end();
    expect(none.deps.begin).not.toHaveBeenCalled();
    const empty = starter({ begin: async () => ({ open: false, error: null }) });
    const quiet = empty.start();
    await quiet.ready;
    await quiet.end();
    expect(empty.deps.end).not.toHaveBeenCalled();
  });

  it("never sends a run whose machine lookup answered after the deadline", async () => {
    vi.useFakeTimers();
    const lookup = deferred<string | null>();
    const { start, deps, calls } = starter({ localHostId: () => lookup.promise, timeoutMs: 7_000 });
    const run = start();
    await vi.advanceTimersByTimeAsync(7_000);
    await run.ready;
    expect(deps.report).toHaveBeenCalledWith("warn", "The before-speaking hook took longer than 7 seconds; speaking without waiting for it.");
    // The speech went on and ended; then the lookup answers.
    await run.end();
    lookup.resolve("host_mine");
    await settle();
    expect(calls).toEqual([]);
  });

  it("still ends a run whose machine answered after the deadline, on that machine", async () => {
    vi.useFakeTimers();
    const opened = deferred<{ open: boolean | null; error: string | null }>();
    const { start, calls, deps } = starter({ timeoutMs: 7_000 });
    vi.mocked(deps.begin).mockImplementationOnce(async (hostId: string, runId: string) => {
      calls.push(`begin:${hostId}:${runId}`);
      return opened.promise;
    });
    const run = start();
    await vi.advanceTimersByTimeAsync(7_000);
    await run.ready;
    // The end goes out while the begin is still in flight; the machine puts them in order.
    await run.end();
    expect(calls).toEqual(["begin:host_mine:run1", "end:host_mine:run1"]);
    opened.resolve({ open: true, error: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.renew).not.toHaveBeenCalled();
  });

  it("ends a run that was never answered, in case the machine opened it", async () => {
    const { start, calls } = starter({ begin: async () => ({ open: null, error: "timed out" }) });
    const run = start();
    await run.ready;
    await run.end();
    expect(calls).toEqual(["end:host_mine:run1"]);
  });

  it("keeps an open run alive while it lasts, and stops once it ends", async () => {
    vi.useFakeTimers();
    const { start, deps } = starter({ renewMs: 10_000 });
    const run = start();
    await run.ready;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(deps.renew).toHaveBeenCalledTimes(2);
    await run.end();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.renew).toHaveBeenCalledTimes(2);
  });

  it("never rejects: a call that fails is reported", async () => {
    const { start, deps } = starter({
      begin: async () => Promise.reject(new Error("server away")),
      end: async () => Promise.reject(new Error("still away")),
    });
    const run = start();
    await expect(run.ready).resolves.toBeUndefined();
    await expect(run.end()).resolves.toBeUndefined();
    expect(deps.report).toHaveBeenCalledWith("warn", "Could not start the before-speaking hook: server away", expect.any(Error));
    expect(deps.report).toHaveBeenCalledWith(
      "warn",
      "Could not end the run of speech; the machine ends it by itself shortly: still away",
      expect.any(Error),
    );
  });
});
