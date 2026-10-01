import { afterEach, describe, expect, it, vi } from "vitest";

import { EARLY_OUTCOME_TTL_MS, HelperOutcomes } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("HelperOutcomes", () => {
  it("hands a waiting summary the helper's reply", async () => {
    const outcomes = new HelperOutcomes();
    const waiting = outcomes.wait("h1", 1000);
    outcomes.active("h1");
    outcomes.idle("h1", '{"speech":"Done."}');
    await expect(waiting).resolves.toEqual({ kind: "idle", text: '{"speech":"Done."}' });
  });

  it("holds an outcome that arrives before anyone waits for it", async () => {
    const outcomes = new HelperOutcomes();
    outcomes.failed("h1", "rate limited");
    await expect(outcomes.wait("h1", 1000)).resolves.toEqual({ kind: "failed", error: "rate limited" });
  });

  it("ignores a silent idle before the helper ever ran, but not one after", async () => {
    const outcomes = new HelperOutcomes();
    const waiting = outcomes.wait("h1", 1000);
    outcomes.idle("h1", null);
    outcomes.active("h1");
    outcomes.idle("h1", null);
    await expect(waiting).resolves.toEqual({ kind: "idle", text: null });
  });

  it("reports a helper that asked the user something", async () => {
    const outcomes = new HelperOutcomes();
    const waiting = outcomes.wait("h1", 1000);
    outcomes.interaction("h1");
    await expect(waiting).resolves.toEqual({ kind: "interaction" });
  });

  it("gives up at the timeout", async () => {
    vi.useFakeTimers();
    const outcomes = new HelperOutcomes();
    const waiting = outcomes.wait("h1", 30_000);
    const assertion = expect(waiting).rejects.toThrow("did not finish within 30 seconds");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("fails every wait at once when cancelled", async () => {
    const outcomes = new HelperOutcomes();
    const first = outcomes.wait("h1", 60_000);
    const second = outcomes.wait("h2", 60_000);
    outcomes.cancelAll("reloaded");
    await expect(first).rejects.toThrow("reloaded");
    await expect(second).rejects.toThrow("reloaded");
  });

  it("forgets an early outcome nobody collected", async () => {
    let now = 0;
    const outcomes = new HelperOutcomes(() => now);
    outcomes.failed("old", "x");
    now = EARLY_OUTCOME_TTL_MS + 1;
    outcomes.failed("new", "y");
    vi.useFakeTimers();
    const stale = outcomes.wait("old", 10);
    const assertion = expect(stale).rejects.toThrow("did not finish");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});
