import { describe, expect, it } from "vitest";

import { batches, cardFromMetadata, cardReference, METADATA_BATCH, threadsToRead } from "./thread-card";

const sent = {
  id: "I_42",
  repository: "octo/widgets",
  number: 42,
  title: "Crash on empty input",
  url: "https://github.com/octo/widgets/issues/42",
  author: null,
  labels: [],
};

describe("cardFromMetadata", () => {
  it("reads the card send stored, keeping only what the surfaces draw", () => {
    expect(cardFromMetadata({ card: sent })).toEqual({
      repository: "octo/widgets",
      number: 42,
      title: "Crash on empty input",
      url: "https://github.com/octo/widgets/issues/42",
    });
  });

  it("reads a card whose other fields changed shape", () => {
    expect(cardFromMetadata({ card: { ...sent, labels: "gone", author: 7, extra: true } })?.number).toBe(42);
  });

  it("answers null for a thread without a card, or with a broken one", () => {
    expect(cardFromMetadata({})).toBeNull();
    expect(cardFromMetadata(null)).toBeNull();
    expect(cardFromMetadata("card")).toBeNull();
    expect(cardFromMetadata({ card: { ...sent, number: "42" } })).toBeNull();
  });
});

describe("cardReference", () => {
  it("writes the card as GitHub writes a reference", () => {
    expect(cardReference({ repository: "octo/widgets", number: 42, title: "", url: "" })).toBe("octo/widgets#42");
  });
});

describe("batches", () => {
  it("splits at most 200 ids per call, in order", () => {
    const ids = Array.from({ length: 401 }, (_, index) => `thr_${index}`);
    const runs = batches(ids);
    expect(runs.map((run) => run.length)).toEqual([METADATA_BATCH, METADATA_BATCH, 1]);
    expect(runs.flat()).toEqual(ids);
    expect(batches([])).toEqual([]);
  });
});

describe("threadsToRead", () => {
  it("asks only for threads this plugin started that are not read yet", () => {
    const threads = [
      { id: "thr_a", originPluginId: "github-board" },
      { id: "thr_b", originPluginId: null },
      { id: "thr_c", originPluginId: "herald" },
      { id: "thr_d", originPluginId: "github-board" },
    ];
    expect(threadsToRead(threads, "github-board", new Set())).toEqual(["thr_a", "thr_d"]);
    expect(threadsToRead(threads, "github-board", new Set(["thr_a"]))).toEqual(["thr_d"]);
  });
});
