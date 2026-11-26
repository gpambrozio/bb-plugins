import { describe, expect, it, vi } from "vitest";

import type { Config } from "../shared/config";
import type { InstallResult } from "../shared/host-contract";
import { RECHECK_MS, runMachineChecks } from "./machine-checks";

describe("the machine checks service", () => {
  it("checks every machine that is on, then only the ones still on and not ready, until it is stopped", async () => {
    let config: Config = { projectNames: {}, hosts: { mini: true, offline: true, gone: true, off: false } };
    const results: Record<string, InstallResult> = {
      mini: { ok: true, path: "/x" },
      offline: { ok: false, reason: "offline" },
      gone: { ok: false, reason: "offline" },
    };
    const checked: string[][] = [];
    let round: string[] = [];
    const controller = new AbortController();
    let sleeps = 0;
    await runMachineChecks(controller.signal, {
      config: async () => config,
      check: async (hostId) => {
        round.push(hostId);
        return results[hostId]!;
      },
      log: { warn: vi.fn() },
      sleep: async (ms) => {
        expect(ms).toBe(RECHECK_MS);
        checked.push(round.sort());
        round = [];
        sleeps += 1;
        if (sleeps === 1) {
          // "gone" is turned off meanwhile; "offline" comes back.
          config = { ...config, hosts: { mini: true, offline: true } };
          results.offline = { ok: true, path: "/x" };
        }
        if (sleeps === 3) controller.abort();
      },
    });
    expect(checked).toEqual([["gone", "mini", "offline"], ["offline"], []]);
  });

  it("stops at once when stopped while asleep", async () => {
    const controller = new AbortController();
    const done = runMachineChecks(controller.signal, { config: async () => ({ projectNames: {}, hosts: {} }), check: vi.fn(), log: { warn: vi.fn() } });
    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});
