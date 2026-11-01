import { describe, expect, it } from "vitest";

import { CARRY_MAX_UPDATES, CarriedUpdates, combinedOutput } from "./carry";

const FINISHED = "finished its turn";

describe("CarriedUpdates", () => {
  it("passes the latest output through when nothing is carried", () => {
    expect(combinedOutput(new CarriedUpdates().earlier("t1"), { event: FINISHED, output: "Done." })).toBe("Done.");
    expect(combinedOutput(new CarriedUpdates().earlier("t1"), { event: FINISHED, output: null })).toBeNull();
  });

  it("lists every update oldest first under its own header", () => {
    const carry = new CarriedUpdates();
    carry.hold("t1", { event: FINISHED, output: "First." });
    expect(combinedOutput(carry.earlier("t1"), { event: FINISHED, output: "Second." })).toBe(
      [
        "2 updates from this thread, oldest first. The earlier one was not read aloud: a newer update came before its sentence was ready.",
        "",
        `[Update 1 of 2: ${FINISHED}]`,
        "First.",
        "",
        `[Update 2 of 2, the latest: ${FINISHED}]`,
        "Second.",
      ].join("\n"),
    );
  });

  it("forgets only what a landed run covered, and the count of what it left out", () => {
    const carry = new CarriedUpdates();
    for (let index = 0; index <= CARRY_MAX_UPDATES; index += 1) carry.hold("t1", { event: FINISHED, output: `u${index}` });
    const covered = carry.earlier("t1");
    expect(covered.dropped).toBe(1);
    const own = carry.hold("t1", { event: FINISHED, output: "mine" });
    const later = carry.hold("t1", { event: FINISHED, output: "later" });
    carry.landed("t1", own, covered);
    // `later` was held after the run started; what it and `mine` pushed out was in the run's prompt.
    expect(carry.earlier("t1").updates.map((update) => update.output)).toEqual(["later"]);
    expect(carry.earlier("t1").dropped).toBe(0);
    carry.landed("t1", later, { updates: [], dropped: 0 });
    for (let index = 0; index < CARRY_MAX_UPDATES + 2; index += 1) carry.hold("t1", { event: FINISHED, output: `v${index}` });
    const run = carry.earlier("t1");
    const ownV = carry.hold("t1", { event: FINISHED, output: "own" });
    for (let index = 0; index < CARRY_MAX_UPDATES + 1; index += 1) carry.hold("t1", { event: FINISHED, output: `w${index}` });
    carry.landed("t1", ownV, run);
    // Of the five held after the run, one was pushed out by the others: never in any prompt.
    expect(carry.earlier("t1").updates).toHaveLength(CARRY_MAX_UPDATES);
    expect(carry.earlier("t1").dropped).toBe(1);
    const latest = carry.earlier("t1").updates.at(-1)?.key ?? 0;
    carry.landed("t1", latest, carry.earlier("t1"));
    expect(carry.earlier("t1")).toEqual({ updates: [], dropped: 0 });
  });

  it("keeps one update however long it is", () => {
    const carry = new CarriedUpdates();
    carry.hold("t1", { event: FINISHED, output: "x".repeat(50_000) });
    expect(carry.earlier("t1").updates).toHaveLength(1);
  });
});
