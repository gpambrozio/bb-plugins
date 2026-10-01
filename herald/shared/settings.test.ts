import { describe, expect, it } from "vitest";

import { customCommandSeed, SENTENCE_TOOLS, sentenceSettingsOf, SETTINGS, TOOL_COMMANDS } from "./settings";

function values(overrides: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
  const defaults: Record<string, string | number | boolean> = {};
  for (const [key, descriptor] of Object.entries(SETTINGS)) {
    if ("default" in descriptor && descriptor.default !== undefined) defaults[key] = descriptor.default;
  }
  return { ...defaults, ...overrides };
}

describe("sentenceSettingsOf", () => {
  it("is off by default, so the plain sentence is used and no command runs", () => {
    expect(sentenceSettingsOf(values(), "")).toBeNull();
    expect(sentenceSettingsOf(undefined, "my-llm")).toBeNull();
  });

  it("uses the selected tool's own command once switched on", () => {
    const sentence = sentenceSettingsOf(values({ writeWithModel: true, sentenceTool: "codex" }), "ignored --when-preset");
    expect(sentence?.command).toBe(TOOL_COMMANDS.codex);
    expect(sentence?.prompt).toBe(SETTINGS.sentencePrompt.default);
  });

  it("uses the custom command when that is the tool, and nothing when it is blank", () => {
    expect(sentenceSettingsOf(values({ writeWithModel: true, sentenceTool: "custom" }), " my-llm --fast ")?.command).toBe("my-llm --fast");
    expect(sentenceSettingsOf(values({ writeWithModel: true, sentenceTool: "custom" }), "  ")).toBeNull();
  });

  it("keeps the custom command out of the host form, which cannot hide a field", () => {
    expect("sentenceCommand" in SETTINGS).toBe(false);
  });

  it("has a command for every tool but custom", () => {
    for (const tool of SENTENCE_TOOLS) {
      if (tool === "custom") continue;
      expect(TOOL_COMMANDS[tool]).toMatch(new RegExp(`^${tool} `));
    }
  });
});

describe("customCommandSeed", () => {
  it("fills a blank custom command with the command of the tool selected before", () => {
    expect(customCommandSeed(values({ sentenceTool: "codex" }), values({ sentenceTool: "custom" }), "")).toBe(TOOL_COMMANDS.codex);
  });

  it("leaves a command the user cleared while already on custom alone", () => {
    expect(customCommandSeed(values({ sentenceTool: "custom" }), values({ sentenceTool: "custom" }), "")).toBeNull();
  });

  it("leaves a custom command the user wrote alone, and does nothing for a preset tool", () => {
    expect(customCommandSeed(values({ sentenceTool: "claude" }), values({ sentenceTool: "custom" }), "mine")).toBeNull();
    expect(customCommandSeed(values({ sentenceTool: "custom" }), values({ sentenceTool: "claude" }), "")).toBeNull();
  });
});
