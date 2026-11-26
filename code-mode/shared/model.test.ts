import { describe, expect, it } from "vitest";

import { codeModeSupport } from "./model";

describe("codeModeSupport", () => {
  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-opus-6", "claude-sonnet-5-6", "claude-opus-5-5[1m]", "Claude-Opus-5-5"])("%s runs Code Mode", (model) => {
    expect(codeModeSupport(model)).toBe("supported");
  });

  it.each(["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-fable-5-1", "claude-fable-5", "claude-haiku-5-5", "claude-haiku-4-5-20251001"])(
    "%s does not",
    (model) => {
      expect(codeModeSupport(model)).toBe("unsupported");
    },
  );

  it.each([null, undefined, "", "opus", "default", "gpt-5", "claude-instant"])("%s is unknown", (model) => {
    expect(codeModeSupport(model)).toBe("unknown");
  });
});
