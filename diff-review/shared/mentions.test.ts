import { describe, expect, it } from "vitest";

import { mentionsReviewer } from "./mentions";

describe("mentionsReviewer", () => {
  it("finds @reviewer and @agent as whole words, in any case", () => {
    expect(mentionsReviewer("@Reviewer can you check this?")).toBe(true);
    expect(mentionsReviewer("Ask the @agent")).toBe(true);
    expect(mentionsReviewer("(@agent)")).toBe(true);
    expect(mentionsReviewer("thanks @reviewer.")).toBe(true);
  });

  it("ignores code, email addresses, paths, longer words and provider names", () => {
    expect(mentionsReviewer("`@reviewer` is the handle")).toBe(false);
    expect(mentionsReviewer("```\n@agent\n```")).toBe(false);
    expect(mentionsReviewer("mail me at me@agent.ai")).toBe(false);
    expect(mentionsReviewer("see ./@agent/x")).toBe(false);
    expect(mentionsReviewer("@agents")).toBe(false);
    expect(mentionsReviewer("@reviewer.ts")).toBe(false);
    expect(mentionsReviewer("@claude, @codex or @opencode")).toBe(false);
    expect(mentionsReviewer("no mention")).toBe(false);
  });

  it("finds a mention after a closed fence", () => {
    expect(mentionsReviewer("```\ncode\n```\n@agent please")).toBe(true);
  });
});
