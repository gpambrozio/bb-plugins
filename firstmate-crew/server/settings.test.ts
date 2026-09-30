import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { homeConfig, homePath, type FirstmateSettings } from "./settings";

const settings = (overrides: Partial<FirstmateSettings> = {}): FirstmateSettings => ({
  homeDirectory: "~/FirstMate",
  crewProvider: "",
  crewModel: "",
  crewReasoning: "default",
  refreshSeconds: 10,
  ...overrides,
});

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
