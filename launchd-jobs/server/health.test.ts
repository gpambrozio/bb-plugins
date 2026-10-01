import { describe, expect, it, vi } from "vitest";

import type { Health } from "../shared/channels";
import type { FailingJob } from "../shared/jobs";
import { createHealthMonitor, type HealthDeps } from "./health";

function setup(options: {
  primary?: string | null;
  /** Host id to name; a name ending in " (asleep)" is enrolled but not connected. */
  connected?: Record<string, string>;
  watched?: string[];
  answers?: Record<string, { jobCount: number; failing: FailingJob[] } | Error>;
}) {
  const answers = { ...options.answers };
  const published: Health[] = [];
  const saved: string[][] = [];
  const asked: string[] = [];
  const deps: HealthDeps = {
    primaryHostId: async () => (options.primary === undefined ? "mini" : options.primary),
    knownHosts: async () =>
      new Map(
        Object.entries(options.connected ?? { mini: "Mini" }).map(([id, name]) => [
          id,
          { name: name.replace(" (asleep)", ""), connected: !name.endsWith(" (asleep)") },
        ]),
      ),
    hostHealth: async (hostId) => {
      asked.push(hostId);
      const answer = answers[hostId];
      if (answer instanceof Error) throw answer;
      return { supported: true, ...(answer ?? { jobCount: 0, failing: [] }) };
    },
    loadWatched: async () => options.watched ?? [],
    saveWatched: async (hostIds) => {
      saved.push(hostIds);
    },
    publish: (health) => published.push(health),
    now: () => 1000,
    warn: vi.fn(),
  };
  return { monitor: createHealthMonitor(deps), answers, published, saved, asked, deps };
}

describe("the failing count", () => {
  it("asks the server's own Mac, and names each failing job with its Mac", async () => {
    const { monitor, published } = setup({ answers: { mini: { jobCount: 2, failing: [{ id: "backup", name: "Backup" }] } } });

    const health = await monitor.refresh();

    expect(health).toEqual({ failing: [{ hostId: "mini", hostName: "Mini", id: "backup", name: "Backup" }], checkedAt: 1000 });
    expect(published).toEqual([health]);
  });

  it("publishes only when the failing jobs change", async () => {
    const { monitor, published, answers } = setup({ answers: { mini: { jobCount: 1, failing: [] } } });

    await monitor.refresh();
    await monitor.refresh();
    expect(published).toEqual([]);

    answers.mini = { jobCount: 1, failing: [{ id: "x", name: "X" }] };
    await monitor.refresh();
    expect(published).toHaveLength(1);
  });

  it("asks another Mac only once a listing there found jobs, and stops when they are gone", async () => {
    const { monitor, asked, saved } = setup({ connected: { mini: "Mini", laptop: "Laptop" } });

    await monitor.refresh();
    expect(asked).toEqual(["mini"]);

    await monitor.noteJobCount("laptop", 3);
    expect(saved).toEqual([["laptop"]]);
    asked.length = 0;
    await monitor.refresh();
    expect(asked).toEqual(["laptop", "mini"]);

    await monitor.noteJobCount("laptop", 0);
    asked.length = 0;
    await monitor.refresh();
    expect(asked).toEqual(["mini"]);
  });

  it("keeps what a Mac last reported while it is asleep or failing to answer", async () => {
    const failing = [{ id: "sync", name: "Sync" }];
    const { monitor, answers, deps } = setup({
      connected: { mini: "Mini", laptop: "Laptop" },
      watched: ["laptop"],
      answers: { laptop: { jobCount: 1, failing } },
    });
    await monitor.refresh();

    answers.laptop = new Error("host offline");
    expect((await monitor.refresh()).failing).toEqual([{ hostId: "laptop", hostName: "Laptop", id: "sync", name: "Sync" }]);
    await monitor.refresh();
    expect(deps.warn).toHaveBeenCalledTimes(1);

    deps.knownHosts = async () =>
      new Map([
        ["mini", { name: "Mini", connected: true }],
        ["laptop", { name: "Laptop", connected: false }],
      ]);
    expect((await monitor.refresh()).failing).toHaveLength(1);
  });

  it("forgets a Mac removed from bb, with its failures", async () => {
    const { monitor, deps, saved } = setup({
      connected: { mini: "Mini", laptop: "Laptop" },
      watched: ["laptop"],
      answers: { laptop: { jobCount: 1, failing: [{ id: "sync", name: "Sync" }] } },
    });
    expect((await monitor.refresh()).failing).toHaveLength(1);

    deps.knownHosts = async () => new Map([["mini", { name: "Mini", connected: true }]]);

    expect((await monitor.refresh()).failing).toEqual([]);
    expect(saved.at(-1)).toEqual([]);
  });

  it("checks again after a check that was under way when a change asked for a recount", async () => {
    const { monitor, asked, answers, deps } = setup({ answers: { mini: { jobCount: 1, failing: [{ id: "a", name: "A" }] } } });
    const gates: (() => void)[] = [];
    const answer = deps.hostHealth;
    deps.hostHealth = async (hostId) => {
      const result = await answer(hostId);
      await new Promise<void>((resolve) => gates.push(resolve));
      return result;
    };
    const until = async (count: number) => {
      while (gates.length < count) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const first = monitor.refresh();
    await until(1);
    // The poll has read the failure; now the user acknowledges it.
    answers.mini = { jobCount: 1, failing: [] };
    const second = monitor.refresh();
    const third = monitor.refresh();
    gates[0]?.();
    expect((await first).failing).toHaveLength(1);
    await until(2);
    gates[1]?.();
    expect((await second).failing).toEqual([]);
    expect(await third).toBe(await second);
    expect(asked).toEqual(["mini", "mini"]);
  });
});
