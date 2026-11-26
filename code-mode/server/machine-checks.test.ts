import { describe, expect, it, vi } from "vitest";

import type { Config } from "../shared/config";
import type { InstallResult } from "../shared/host-contract";
import { RECHECK_MS, runMachineChecks } from "./machine-checks";

/** A service run against a fake: `script` runs at each sleep, then the round's checks are recorded. */
async function run(initial: Config, results: Record<string, InstallResult>, script: (round: number, state: { config: Config; ready: Set<string> }) => void, rounds: number) {
  const state = { config: initial, ready: new Set<string>() };
  const checked: string[][] = [];
  let current: string[] = [];
  const controller = new AbortController();
  let sleeps = 0;
  await runMachineChecks(controller.signal, {
    config: async () => state.config,
    check: async (hostId) => {
      current.push(hostId);
      const result = results[hostId] ?? { ok: false, reason: "unknown" };
      if (result.ok) state.ready.add(hostId);
      else state.ready.delete(hostId);
      return result;
    },
    isReady: (hostId) => state.ready.has(hostId),
    log: { warn: vi.fn() },
    sleep: async (ms) => {
      expect(ms).toBe(RECHECK_MS);
      checked.push(current.sort());
      current = [];
      sleeps += 1;
      script(sleeps, state);
      if (sleeps === rounds) controller.abort();
    },
  });
  return checked;
}

describe("the machine checks service", () => {
  it("checks every machine that is on, then only the ones still on and not ready, until it is stopped", async () => {
    const results: Record<string, InstallResult> = { mini: { ok: true, path: "/x" }, offline: { ok: false, reason: "offline" }, gone: { ok: false, reason: "offline" } };
    const checked = await run(
      { projectNames: {}, hosts: { mini: true, offline: true, gone: true, off: false } },
      results,
      (round, state) => {
        if (round === 1) {
          // "gone" is turned off meanwhile; "offline" comes back.
          state.config = { ...state.config, hosts: { mini: true, offline: true } };
          results.offline = { ok: true, path: "/x" };
        }
      },
      3,
    );
    expect(checked).toEqual([["gone", "mini", "offline"], ["offline"], []]);
  });

  it("retries a machine turned on after it started, whose first check (from the settings page) failed", async () => {
    const results: Record<string, InstallResult> = { late: { ok: false, reason: "offline" } };
    const checked = await run(
      { projectNames: {}, hosts: {} },
      results,
      (round, state) => {
        if (round === 1) {
          // Turned on from the settings page, whose own check failed: the machine is offline.
          state.config = { projectNames: {}, hosts: { late: true } };
          state.ready.delete("late");
        }
        if (round === 2) results.late = { ok: true, path: "/x" };
      },
      4,
    );
    expect(checked).toEqual([[], ["late"], ["late"], []]);
  });

  it("stops at once when stopped while asleep", async () => {
    const controller = new AbortController();
    const done = runMachineChecks(controller.signal, { config: async () => ({ projectNames: {}, hosts: {} }), check: vi.fn(), isReady: () => false, log: { warn: vi.fn() } });
    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});
