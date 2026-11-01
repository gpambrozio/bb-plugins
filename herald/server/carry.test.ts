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
    expect(told.updates.map((held) => held.output)).toEqual(["u3", "u4", "u5", "u6"]);
    expect(told.dropped).toBe(3);
    const later = carry.arrive("t1", update("later"));
    carry.covered("t1", mine, told);
    expect(carry.earlier("t1", later + 1)).toEqual({ updates: [update("later")], dropped: 0, seqs: [later] });
  });

  it("applies the caps for an event with no update of its own", () => {
    const carry = new CarriedUpdates();
    for (let index = 0; index < CARRY_MAX_UPDATES + 1; index += 1) carry.arrive("t1", update(`u${index}`));
    const asked = carry.arrive("t1", null);
    const told = carry.earlier("t1", asked);
    expect(told.updates).toHaveLength(CARRY_MAX_UPDATES);
    expect(told.dropped).toBe(1);

    const long = new CarriedUpdates();
    for (const letter of ["a", "b", "c"]) long.arrive("t1", update(letter.repeat(3_000)));
    const failed = long.arrive("t1", null);
    const given = long.earlier("t1", failed);
    expect(given.updates.map((held) => held.output[0])).toEqual(["b", "c"]);
    expect(given.dropped).toBe(1);
  });

  it("keeps the count of what went unread when only a run's own update is withdrawn", () => {
    const carry = new CarriedUpdates();
    const seqs: number[] = [];
    for (let index = 0; index < CARRY_MAX_UPDATES + 2; index += 1) seqs.push(carry.arrive("t1", update(`u${index}`)));
    const all = Number.MAX_SAFE_INTEGER;
    expect(carry.earlier("t1", all).dropped).toBe(2);
    // The oldest held (u2) carries the count; withdrawn, the next one does.
    carry.withdraw("t1", seqs[2] as number);
    expect(carry.earlier("t1", all)).toEqual({ updates: ["u3", "u4", "u5"].map(update), dropped: 2, seqs: seqs.slice(3) });
  });

  it("gives only updates known to be ones a tool writes for, once decided", async () => {
    const carry = new CarriedUpdates();
    let decide: (yes: boolean) => void = () => {};
    carry.arrive("t1", update("off"), Promise.resolve(false));
    carry.arrive("t1", update("pending"), new Promise<boolean>((resolve) => (decide = resolve)));
    const mine = carry.arrive("t1", update("mine"));
    await carry.decided("t1", mine, 1);
    expect(carry.earlier("t1", mine).updates).toEqual([]);
    const waiting = carry.decided("t1", mine, 10_000);
    decide(true);
    await waiting;
    expect(carry.earlier("t1", mine).updates).toEqual([update("pending")]);
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
