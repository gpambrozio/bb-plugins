import { describe, expect, it } from "vitest";

import { DEFAULT_SENTENCE_PROMPT, DEFAULT_STORED_CONFIG, SENTENCE_TOOLS, TOOL_COMMANDS, type StoredConfig } from "./herald";
import { customCommandSeed, sentenceSettingsOf, SETTINGS } from "./settings";

function stored(overrides: Partial<StoredConfig> = {}): StoredConfig {
  return { ...DEFAULT_STORED_CONFIG, ...overrides };
}

describe("sentenceSettingsOf", () => {
  it("is off by default, so the plain sentence is used and no command runs", () => {
    expect(sentenceSettingsOf(false, stored())).toBeNull();
    expect(sentenceSettingsOf(undefined, stored({ sentenceCommand: "my-llm" }))).toBeNull();
  });

  it("uses the selected tool's own command once switched on", () => {
    const sentence = sentenceSettingsOf(true, stored({ sentenceTool: "codex", sentenceCommand: "ignored --when-preset" }));
    expect(sentence?.command).toBe(TOOL_COMMANDS.codex);
    expect(sentence?.prompt).toBe(DEFAULT_SENTENCE_PROMPT);
  });

  it("uses the custom command when that is the tool, and nothing when it is blank", () => {
    expect(sentenceSettingsOf(true, stored({ sentenceTool: "custom", sentenceCommand: " my-llm --fast " }))?.command).toBe("my-llm --fast");
    expect(sentenceSettingsOf(true, stored({ sentenceTool: "custom", sentenceCommand: "  " }))).toBeNull();
  });

  it("falls back to the default prompt when the stored one is blank", () => {
    expect(sentenceSettingsOf(true, stored({ sentencePrompt: " \n" }))?.prompt).toBe(DEFAULT_SENTENCE_PROMPT);
    expect(sentenceSettingsOf(true, stored({ sentencePrompt: "Say: {{headline}}" }))?.prompt).toBe("Say: {{headline}}");
  });

  it("keeps only the switch in the host form; the rest is stored config the section shows", () => {
    expect(SETTINGS.writeWithModel.type).toBe("boolean");
    expect(Object.keys(SETTINGS).filter((key) => key.startsWith("sentence"))).toEqual([]);
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
    expect(customCommandSeed(stored({ sentenceTool: "codex" }), stored({ sentenceTool: "custom" }))).toBe(TOOL_COMMANDS.codex);
  });

  it("leaves a command the user cleared while already on custom alone", () => {
    expect(customCommandSeed(stored({ sentenceTool: "custom" }), stored({ sentenceTool: "custom" }))).toBeNull();
  });

  it("leaves a custom command the user wrote alone, and does nothing for a preset tool", () => {
    expect(customCommandSeed(stored({ sentenceTool: "claude" }), stored({ sentenceTool: "custom", sentenceCommand: "mine" }))).toBeNull();
    expect(customCommandSeed(stored({ sentenceTool: "custom" }), stored({ sentenceTool: "claude" }))).toBeNull();
  });
});
