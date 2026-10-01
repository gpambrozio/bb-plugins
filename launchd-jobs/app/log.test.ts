import { describe, expect, it } from "vitest";

import { applyChunk, MAX_LOG_CHARS } from "./log";

const chunk = (text: string, extra: Partial<{ pending: string; reset: boolean; truncated: boolean; next: number }> = {}) => ({
  text,
  pending: "",
  reset: false,
  truncated: false,
  next: text.length,
  path: "/data/logs/a.log",
  ...extra,
});

describe("applyChunk", () => {
  it("replaces the log on a plain read, and extends it while following", () => {
    const first = applyChunk(null, chunk("one\n", { pending: "tw" }), false);
    expect(first).toMatchObject({ text: "one\n", pending: "tw" });

    const followed = applyChunk(first, chunk("two\n", { next: 8 }), true);
    expect(followed).toMatchObject({ text: "one\ntwo\n", pending: "", next: 8 });
  });

  it("starts over when the read says the file was rotated", () => {
    const state = applyChunk(null, chunk("old\n"), false);
    expect(applyChunk(state, chunk("new\n", { reset: true }), true).text).toBe("new\n");
  });

  it("keeps a followed log bounded, dropping whole lines from the top", () => {
    const line = "x".repeat(99) + "\n";
    let state = applyChunk(null, chunk(""), false);
    for (let index = 0; index < (MAX_LOG_CHARS / line.length) + 10; index += 1) state = applyChunk(state, chunk(line), true);
    expect(state.text.length).toBeLessThanOrEqual(MAX_LOG_CHARS);
    expect(state.text.startsWith("x")).toBe(true);
    expect(state.truncated).toBe(true);
  });
});
