import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import {
  autoCompactRules,
  defaultSettings,
  homeConfig,
  homePath,
  refreshMs,
  REASONING_OPTIONS,
  SETTINGS,
  type FirstmateSettings,
} from "./settings";

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

describe("crew reasoning", () => {
  it("labels every option, the default as the first mate's call", () => {
    const labels = SETTINGS.crewReasoning.experimental_optionLabels;
    expect(Object.keys(labels)).toEqual(REASONING_OPTIONS);
    expect(labels.default).toBe("Leave it to the first mate");
    expect(labels.xhigh).toBe("Extra high");
  });

  it("is a settings form bb accepts", () => {
    const { bb } = createFakePluginHost({ pluginId: "firstmate-crew" });
    expect(() => bb.settings.define(SETTINGS)).not.toThrow();
  });
});

describe("refreshMs", () => {
  it("is the setting in milliseconds", () => {
    expect(refreshMs(settings({ refreshSeconds: 30 }))).toBe(30_000);
  });

  it("falls back to ten seconds for a value below one second or not a number", () => {
    expect(refreshMs(settings({ refreshSeconds: 0 }))).toBe(10_000);
    expect(refreshMs(settings({ refreshSeconds: 0.5 }))).toBe(10_000);
    expect(refreshMs(settings({ refreshSeconds: Number.NaN }))).toBe(10_000);
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
  it("start off, at 200 thousand tokens and 60 idle minutes, for the first mate and the crew alike", () => {
    const defaults = defaultSettings();
    expect(defaults.mateAutoCompactKTokens).toBe(200);
    expect(defaults.crewAutoCompactKTokens).toBe(200);
    expect(autoCompactRules(defaultSettings())).toEqual({
      mate: { enabled: false, minTokens: 200_000, idleMinutes: 60 },
      crew: { enabled: false, minTokens: 200_000, idleMinutes: 60 },
    });
  });

  it("give the first mate and the crew a rule each, the thousands of tokens multiplied out", () => {
    const rules = autoCompactRules(
      settings({
        mateAutoCompact: true,
        mateAutoCompactKTokens: 150,
        mateAutoCompactIdleMinutes: 30,
        crewAutoCompact: false,
        crewAutoCompactKTokens: 400,
        crewAutoCompactIdleMinutes: 90,
      }),
    );
    expect(rules).toEqual({
      mate: { enabled: true, minTokens: 150_000, idleMinutes: 30 },
      crew: { enabled: false, minTokens: 400_000, idleMinutes: 90 },
    });
  });

  it("keep no setting that holds a raw token count", () => {
    expect(Object.keys(SETTINGS)).not.toContain("mateAutoCompactTokens");
    expect(Object.keys(SETTINGS)).not.toContain("crewAutoCompactTokens");
  });

  it.each(["mateAutoCompactKTokens", "mateAutoCompactIdleMinutes", "crewAutoCompactKTokens", "crewAutoCompactIdleMinutes"] as const)(
    "%s takes only a whole number above zero",
    (key) => {
      const schema = SETTINGS[key].experimental_schema;
      expect(schema.safeParse(1).success).toBe(true);
      expect(schema.safeParse(200).success).toBe(true);
      expect(schema.safeParse(0).success).toBe(false);
      expect(schema.safeParse(-5).success).toBe(false);
      expect(schema.safeParse(1.5).success).toBe(false);
    },
  );
});
