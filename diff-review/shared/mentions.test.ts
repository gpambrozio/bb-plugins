import { describe, expect, it } from "vitest";

import { mentionedAgent } from "./mentions";

describe("mentionedAgent", () => {
  it("finds the earliest handle, in any case", () => {
    expect(mentionedAgent("@Claude can you check this?")).toBe("claude");
    expect(mentionedAgent("Ask @codex, or @claude")).toBe("codex");
    expect(mentionedAgent("(@opencode)")).toBe("opencode");
    expect(mentionedAgent("thanks @claude.")).toBe("claude");
  });

  it("ignores code, emails, paths and longer words", () => {
    expect(mentionedAgent("`@claude` is the handle")).toBeNull();
    expect(mentionedAgent("```\n@claude\n```")).toBeNull();
    expect(mentionedAgent("mail me at me@claude.ai")).toBeNull();
    expect(mentionedAgent("see ./@claude/x")).toBeNull();
    expect(mentionedAgent("@claudette")).toBeNull();
    expect(mentionedAgent("@claude.ts")).toBeNull();
    expect(mentionedAgent("no mention")).toBeNull();
  });

  it("finds a handle after a closed fence", () => {
    expect(mentionedAgent("```\ncode\n```\n@codex please")).toBe("codex");
  });
});
