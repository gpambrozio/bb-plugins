import { describe, expect, it, vi } from "vitest";

import { selectAllMachines } from "./select-all";

describe("Select all machines", () => {
  it("turns on only the machines whose wrapper is ready, and reports every machine's result", async () => {
    const turnOn = vi.fn(async () => undefined);
    const report = vi.fn();
    const results: Record<string, { ok: boolean; message: string }> = {
      host_mini: { ok: true, message: "Ready" },
      host_win: { ok: false, message: "Code Mode's wrapper needs a POSIX shell, and this machine runs Windows." },
    };
    const outcome = await selectAllMachines(["host_mini", "host_win", "host_offline"], {
      check: async (hostId) => {
        if (hostId === "host_offline") throw new Error("host is offline");
        return results[hostId]!;
      },
      turnOn,
      report,
    });
    expect(outcome).toEqual({ on: ["host_mini"], left: ["host_win", "host_offline"] });
    expect(turnOn).toHaveBeenCalledWith(["host_mini"]);
    expect(report).toHaveBeenCalledWith("host_win", results.host_win);
    expect(report).toHaveBeenCalledWith("host_offline", { ok: false, message: "host is offline" });
  });

  it("writes nothing when no machine is ready", async () => {
    const turnOn = vi.fn(async () => undefined);
    await selectAllMachines(["host_win"], { check: async () => ({ ok: false, message: "no" }), turnOn, report: () => undefined });
    expect(turnOn).not.toHaveBeenCalled();
  });
});
