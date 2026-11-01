import { describe, expect, it } from "vitest";

import { CARRY_MAX_UPDATES, CarriedUpdates, combinedOutput } from "./carry";

const FINISHED = "finished its turn";

function update(output: string) {
  return { event: FINISHED, output };
}

describe("CarriedUpdates", () => {
  it("passes the latest output through when nothing is carried", () => {
    const carry = new CarriedUpdates();
    const seq = carry.arrive("t1", update("Done."));
    expect(combinedOutput(carry.earlier("t1", seq), { event: FINISHED, output: "Done." })).toBe("Done.");
    expect(combinedOutput(carry.earlier("t1", seq), { event: FINISHED, output: null })).toBeNull();
  });

  it("lists every update oldest first under its own header", () => {
    const carry = new CarriedUpdates();
    carry.arrive("t1", update("First."));
    const seq = carry.arrive("t1", update("Second."));
    expect(combinedOutput(carry.earlier("t1", seq), { event: FINISHED, output: "Second." })).toBe(
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

  it("gives a run only what arrived before it, and keeps what arrived after it lands", () => {
    const carry = new CarriedUpdates();
    carry.arrive("t1", update("a"));
    const mine = carry.arrive("t1", update("mine"));
    carry.arrive("t1", update("later"));
    expect(carry.earlier("t1", mine).updates.map((held) => held.output)).toEqual(["a"]);
    carry.coveredThrough("t1", mine);
    expect(carry.earlier("t1", Number.MAX_SAFE_INTEGER).updates.map((held) => held.output)).toEqual(["later"]);
  });

  it("orders by arrival, whatever answers first", () => {
    const carry = new CarriedUpdates();
    const a = carry.arrive("t1", update("a"));
    const b = carry.arrive("t1", update("b"));
    const c = carry.arrive("t1", update("c"));
    carry.withdraw("t1", b);
    carry.withdraw("t1", a + 1000);
    expect(carry.earlier("t1", c + 1).updates.map((held) => held.output)).toEqual(["a", "c"]);
  });

  it("counts what the caps let go, until a run that was told lands", () => {
    const carry = new CarriedUpdates();
    for (let index = 0; index < CARRY_MAX_UPDATES + 3; index += 1) carry.arrive("t1", update(`u${index}`));
    const mine = carry.arrive("t1", update("mine"));
    const told = carry.earlier("t1", mine);
    expect(told.updates).toHaveLength(CARRY_MAX_UPDATES);
    expect(told.dropped).toBe(3);
    // Arrivals during the run push out what it was given: those were in its prompt.
    const later = carry.arrive("t1", update("later"));
    carry.coveredThrough("t1", mine);
    expect(carry.earlier("t1", later + 1)).toEqual({ updates: [update("later")], dropped: 0 });
  });

  it("keeps the count of what went unread when only a run's own update is withdrawn", () => {
    const carry = new CarriedUpdates();
    const seqs: number[] = [];
    for (let index = 0; index < CARRY_MAX_UPDATES + 2; index += 1) seqs.push(carry.arrive("t1", update(`u${index}`)));
    const all = Number.MAX_SAFE_INTEGER;
    expect(carry.earlier("t1", all).dropped).toBe(1);
    // The oldest held (u1) carries the count; withdrawn, the next one does.
    carry.withdraw("t1", seqs[1] as number);
    expect(carry.earlier("t1", all)).toEqual({ updates: ["u2", "u3", "u4", "u5"].map(update), dropped: 1 });
  });

  it("keeps one update however long it is, and never mixes threads", () => {
    const carry = new CarriedUpdates();
    carry.arrive("t1", update("x".repeat(50_000)));
    const other = carry.arrive("t2", update("other"));
    expect(carry.earlier("t1", other + 1).updates).toHaveLength(1);
    expect(carry.earlier("t2", other).updates).toHaveLength(0);
    carry.forget("t1");
    expect(carry.earlier("t1", other + 1).updates).toHaveLength(0);
  });
});
