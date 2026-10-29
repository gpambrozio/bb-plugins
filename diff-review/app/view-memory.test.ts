// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { forgetView, keepView, startingView } from "./view-memory";

afterEach(() => window.localStorage.clear());

describe("the view kept per thread", () => {
  it("starts on the kept view when the tab is opened as it was then, else as asked", () => {
    expect(startingView(null, "thr_1")).toEqual({ target: { kind: "uncommitted" }, auto: true, restored: false });
    keepView("thr_1", null, { kind: "commit", sha: "abcdef1" });
    expect(startingView(null, "thr_1")).toEqual({ target: { kind: "commit", sha: "abcdef1" }, auto: false, restored: true });
    expect(startingView({ target: { kind: "staged" } }, "thr_1")).toEqual({ target: { kind: "staged" }, auto: false, restored: false });
    expect(startingView(null, "thr_2").restored).toBe(false);
    // Not kept for this tab at all: the Reviews page.
    expect(startingView(null, null).restored).toBe(false);
    keepView("thr_1", { target: { kind: "staged" } }, { kind: "unstaged" });
    expect(startingView({ target: { kind: "staged" } }, "thr_1").target).toEqual({ kind: "unstaged" });
    forgetView("thr_1");
    expect(startingView({ target: { kind: "staged" } }, "thr_1").target).toEqual({ kind: "staged" });
  });

  it("ignores what it cannot read", () => {
    for (const raw of ["not json", JSON.stringify({ opened: null, target: { kind: "nope" } }), JSON.stringify({ opened: { kind: "nope" }, target: { kind: "staged" } })]) {
      window.localStorage.setItem("diff-review:view:thr_1", raw);
      expect(startingView(null, "thr_1")).toEqual({ target: { kind: "uncommitted" }, auto: true, restored: false });
    }
  });
});
