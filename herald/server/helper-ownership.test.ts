import { describe, expect, it } from "vitest";

import { HelperOwnership } from "./helper-ownership";
import type { HelperPort } from "./ports";
import { handOverHelper, onHelperHandedOver } from "./reload-signal";

function recordingPort(calls: string[], spawn: () => Promise<string> = async () => "h1"): HelperPort {
  return {
    spawn,
    stop: async (id) => {
      calls.push(`stop:${id}`);
    },
    archive: async (id) => {
      calls.push(`archive:${id}`);
    },
    delete: async (id) => {
      calls.push(`delete:${id}`);
    },
    listLeftovers: async () => [],
  };
}

describe("HelperOwnership", () => {
  it("hands a helper whose spawn answers after unload to the live instance, which puts it away", async () => {
    const pluginId = `test-${Math.random()}`;
    const oldCalls: string[] = [];
    const liveCalls: string[] = [];
    let answer: (id: string) => void = () => {};
    const old = new HelperOwnership(
      () => recordingPort(oldCalls, () => new Promise<string>((resolve) => (answer = resolve))),
      (helperId) => handOverHelper(pluginId, "old", helperId),
    );
    // The replacement takes what is handed over, with its own (live) port.
    const live = recordingPort(liveCalls);
    const stop = onHelperHandedOver(pluginId, "new", (helperId) => {
      void live.stop(helperId).then(() => live.delete(helperId));
    });

    const spawning = old.spawn({ title: "t", prompt: "p", providerId: "x", model: "m", reasoningLevel: "low", metadata: {} });
    // Unload's deadline passes while the spawn is still out.
    old.release();
    answer("late-helper");
    await spawning;
    // And the summary's own clean-up, running late, reaches bb no more.
    await old.stop("late-helper");
    await old.delete("late-helper");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldCalls).toEqual([]);
    expect(liveCalls).toEqual(["stop:late-helper", "delete:late-helper"]);
    stop();
  });

  it("hands over at release every helper it still owns, once each", async () => {
    const handed: string[] = [];
    const calls: string[] = [];
    let n = 0;
    const ownership = new HelperOwnership(
      () => recordingPort(calls, async () => `h${(n += 1)}`),
      (helperId) => handed.push(helperId),
    );
    const args = { title: "t", prompt: "p", providerId: "x", model: "m", reasoningLevel: "low", metadata: {} };
    await ownership.spawn(args);
    await ownership.spawn(args);
    await ownership.delete("h1");
    expect(ownership.owns("h1")).toBe(false);
    expect(ownership.owns("h2")).toBe(true);
    ownership.release();
    await ownership.stop("h2");
    expect(handed).toEqual(["h2"]);
    expect(calls).toEqual(["delete:h1"]);
  });

  it("ignores its own handovers on the channel", () => {
    const pluginId = `test-${Math.random()}`;
    const received: string[] = [];
    const stop = onHelperHandedOver(pluginId, "same", (helperId) => received.push(helperId));
    handOverHelper(pluginId, "same", "h1");
    handOverHelper(pluginId, "other", "h2");
    expect(received).toEqual(["h2"]);
    stop();
  });
});
