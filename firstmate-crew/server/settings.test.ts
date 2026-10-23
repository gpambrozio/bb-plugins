import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { autoCompactRules, defaultSettings, homeConfig, homePath, SETTINGS, type FirstmateSettings } from "./settings";

const settings = (overrides: Partial<FirstmateSettings> = {}): FirstmateSettings => ({ ...defaultSettings(), ...overrides });

describe("homePath", () => {
  it("expands a leading ~ to the user's home directory", () => {
    expect(homePath("~/FirstMate")).toBe(join(homedir(), "FirstMate"));
    expect(homePath("~")).toBe(homedir());
  });

  it("keeps an absolute path", () => {
    expect(homePath("/abs")).toBe("/abs");
  });

  it("refuses a relative path, naming it", () => {
    expect(() => homePath("rel")).toThrow("Home directory must be an absolute path or start with ~: rel");
  });

  it("refuses ~user, which it cannot expand", () => {
    expect(() => homePath("~someone/x")).toThrow("Home directory must be an absolute path or start with ~: ~someone/x");
  });
});

describe("homeConfig", () => {
  it("joins provider and model when both are set", () => {
    expect(homeConfig(settings({ crewProvider: "codex", crewModel: "gpt-5.5" })).crewProvider).toBe("codex/gpt-5.5");
  });

  it("leaves the crew provider to the first mate when either half is missing", () => {
    expect(homeConfig(settings({ crewProvider: "codex" })).crewProvider).toBe("");
    expect(homeConfig(settings({ crewModel: "gpt-5.5" })).crewProvider).toBe("");
    expect(homeConfig(settings()).crewProvider).toBe("");
  });

  it("maps the default reasoning to empty and keeps any other level", () => {
    expect(homeConfig(settings()).crewReasoning).toBe("");
    expect(homeConfig(settings({ crewReasoning: "high" })).crewReasoning).toBe("high");
  });
});

describe("autocompact settings", () => {
  it("start off, at 200,000 tokens and 60 idle minutes, for the first mate and the crew alike", () => {
    expect(autoCompactRules(defaultSettings())).toEqual({
      mate: { enabled: false, minTokens: 200_000, idleMinutes: 60 },
      crew: { enabled: false, minTokens: 200_000, idleMinutes: 60 },
    });
  });

  it("give the first mate and the crew a rule each", () => {
    const rules = autoCompactRules(
      settings({
        mateAutoCompact: true,
        mateAutoCompactTokens: 150_000,
        mateAutoCompactIdleMinutes: 30,
        crewAutoCompact: false,
        crewAutoCompactTokens: 400_000,
        crewAutoCompactIdleMinutes: 90,
      }),
    );
    expect(rules).toEqual({
      mate: { enabled: true, minTokens: 150_000, idleMinutes: 30 },
      crew: { enabled: false, minTokens: 400_000, idleMinutes: 90 },
    });
  });

  it.each(["mateAutoCompactTokens", "mateAutoCompactIdleMinutes", "crewAutoCompactTokens", "crewAutoCompactIdleMinutes"] as const)(
    "%s takes only a whole number above zero",
    (key) => {
      const schema = SETTINGS[key].experimental_schema;
      expect(schema.safeParse(1).success).toBe(true);
      expect(schema.safeParse(200_000).success).toBe(true);
      expect(schema.safeParse(0).success).toBe(false);
      expect(schema.safeParse(-5).success).toBe(false);
      expect(schema.safeParse(1.5).success).toBe(false);
    },
  );
});
