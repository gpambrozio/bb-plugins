import { describe, expect, it } from "vitest";

import { brief, cleanTitle, clip, plain, sentences } from "./text";

describe("plain", () => {
  it("drops code blocks, links, URLs and bb ids, and keeps the words", () => {
    const text = [
      "## Done",
      "Opened **the PR** at https://github.com/o/r/pull/42 for @thread:thr_abc123.",
      "```ts",
      "const x = 1;",
      "```",
      "- See [the report](https://example.com/r) and `bb briefing`.",
    ].join("\n");
    expect(plain(text)).toBe("Done Opened the PR at for. See the report and bb briefing.");
  });

  it("removes ids written on their own and message links", () => {
    expect(plain("Worker thr_q69fijvepr in proj_c5y4rpwir9 replied in thr_abc#msg=42")).toBe("Worker in replied in");
  });

  it("keeps the word thread when no id follows it", () => {
    expect(plain("The thread thread: is fine")).toBe("The thread thread: is fine");
  });
});

describe("sentences", () => {
  it("takes whole sentences up to the count", () => {
    expect(sentences("One. Two! Three? Four.", 2, 100)).toBe("One. Two!");
  });

  it("stops before a sentence that would pass the limit", () => {
    expect(sentences("Short one. A much longer second sentence that does not fit.", 3, 30)).toBe("Short one.");
  });

  it("clips a first sentence longer than the limit at a word", () => {
    expect(sentences("This first sentence runs on and on without an end in sight", 2, 30)).toBe("This first sentence runs on…");
  });
});

describe("clip", () => {
  it("leaves short text alone and marks a cut", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("one two three four five", 12)).toBe("one two…");
  });
});

describe("brief and cleanTitle", () => {
  it("is null for text with nothing left once cleaned", () => {
    expect(brief("```\ncode only\n```", 2, 100)).toBeNull();
    expect(brief(null, 2, 100)).toBeNull();
  });

  it("gives an untitled thread a name", () => {
    expect(cleanTitle("https://x.y/z")).toBe("Untitled");
    expect(cleanTitle("Fix `herald` (#12)")).toBe("Fix herald (#12)");
  });
});
