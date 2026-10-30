import { describe, expect, it } from "vitest";

import { BB_LEVEL_DEFAULTS, levelAllows, pushBody, pushTitle, resolveLevel, type OwnLevel } from "./push";

function ownOf(levels: Record<string, OwnLevel>): (id: string) => OwnLevel {
  return (id) => levels[id] ?? "inherit";
}

describe("bb's notification level rule", () => {
  it("uses the thread's own level, else the child default, else the default", () => {
    expect(resolveLevel("t", [], ownOf({ t: "input-only" }), BB_LEVEL_DEFAULTS)).toBe("input-only");
    expect(resolveLevel("t", ["p"], ownOf({}), BB_LEVEL_DEFAULTS)).toBe("input-only");
    expect(resolveLevel("t", [], ownOf({}), BB_LEVEL_DEFAULTS)).toBe("all");
    expect(resolveLevel("t", ["p"], ownOf({}), { defaultLevel: "all", childLevel: "inherit" })).toBe("all");
  });

  it("lets every ancestor's own level cap it, even over the thread's own", () => {
    expect(resolveLevel("t", ["p", "root"], ownOf({ t: "all", root: "muted" }), BB_LEVEL_DEFAULTS)).toBe("muted");
    expect(resolveLevel("t", ["p"], ownOf({ t: "all", p: "input-only" }), BB_LEVEL_DEFAULTS)).toBe("input-only");
    expect(resolveLevel("t", ["p"], ownOf({ t: "input-only", p: "all" }), BB_LEVEL_DEFAULTS)).toBe("input-only");
  });

  it("notifies finished turns only at All, and questions and errors at Needs input only", () => {
    expect(levelAllows("all", "finished")).toBe(true);
    expect(levelAllows("input-only", "finished")).toBe(false);
    for (const reason of ["question", "plan", "permission", "error"] as const) expect(levelAllows("input-only", reason)).toBe(true);
    expect(levelAllows("muted", "question")).toBe(false);
  });
});

describe("the notification's text", () => {
  it("titles it with the thread, then its project when both fit", () => {
    expect(pushTitle("Login fix", "Shop")).toBe("Login fix · Shop");
    expect(pushTitle("Shop", "Shop")).toBe("Shop");
    expect(pushTitle(null, "Shop")).toBe("Shop");
    expect(pushTitle(null, null)).toBe("Herald");
    const long = "A thread title that is long enough to leave no room at all for the project name";
    expect(pushTitle(long, "Shop")).toBe(long);
    expect(pushTitle(`${long} at all, and then some more`, "Shop").length).toBeLessThanOrEqual(80);
  });

  it("keeps the sentence whole when it fits, on one line", () => {
    expect(pushBody("Login fix finished.\n\nTests pass.")).toBe("Login fix finished. Tests pass.");
  });
});
