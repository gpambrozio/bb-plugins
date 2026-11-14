import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpeechPlatform } from "../shared/settings";
import { createHookRunner, createLocalHostLookup, findLocalHostId, type HookRunnerDeps } from "./speech-hooks";

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

function runner(overrides: Partial<HookRunnerDeps> & { platform?: () => SpeechPlatform } = {}) {
  const deps = {
    platform: () => "desktop" as SpeechPlatform,
    localHostId: vi.fn(async () => "host_mine" as string | null),
    run: vi.fn(async () => ({ ran: true, error: null as string | null })),
    report: vi.fn(),
    ...overrides,
  };
  return { run: createHookRunner(deps), deps };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createHookRunner", () => {
  it("asks the server to run this machine's hook, and waits for it", async () => {
    const { run, deps } = runner();
    await run("before");
    expect(deps.run).toHaveBeenCalledWith("host_mine", "before");
    expect(deps.report).not.toHaveBeenCalled();
  });

  it("runs nothing, and reads nothing, outside bb's desktop app", async () => {
    for (const platform of ["browser", "mobile"] as const) {
      const { run, deps } = runner({ platform: () => platform });
      await run("before");
      expect(deps.localHostId).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
    }
  });

  it("runs nothing on a machine that is not one of bb's", async () => {
    const { run, deps } = runner({ localHostId: async () => null });
    await run("after");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("never rejects: a call that fails is reported", async () => {
    const { run, deps } = runner({ run: async () => Promise.reject(new Error("server away")) });
    await expect(run("before")).resolves.toBeUndefined();
    expect(deps.report).toHaveBeenCalledWith("warn", "Could not run the before-speaking hook: server away", expect.any(Error));
  });

  it("stops waiting for a hook that takes too long, and says so", async () => {
    vi.useFakeTimers();
    const { run, deps } = runner({ run: () => new Promise(() => {}), timeoutMs: 7_000 });
    const done = run("before");
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(done).resolves.toBeUndefined();
    expect(deps.report).toHaveBeenCalledWith(
      "warn",
      "The before-speaking hook took longer than 7 seconds; speaking without waiting for it.",
    );
  });
});
