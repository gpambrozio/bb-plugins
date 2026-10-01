import { describe, expect, it } from "vitest";

import { PROVIDERS } from "./providers";
import { DEFAULT_DISPLAY, displayFrom, INPUT_WEIGHTS, inputShare, SETTINGS } from "./settings";

describe("SETTINGS", () => {
  it("has one switch per provider, keyed by its id and on by default", () => {
    for (const provider of PROVIDERS) {
      const descriptor = (SETTINGS as Record<string, { type: string; label: string; default?: unknown }>)[provider.id];
      expect(descriptor?.type).toBe("boolean");
      expect(descriptor?.label).toBe(provider.label);
      expect(descriptor?.default).toBe(true);
    }
  });

  it("offers every blend and defaults to the agent one", () => {
    expect(SETTINGS.inputWeight.options).toEqual([...INPUT_WEIGHTS]);
    expect(SETTINGS.inputWeight.default).toBe("80/20");
  });
});

describe("displayFrom", () => {
  it("is the defaults while the settings load", () => {
    expect(displayFrom(undefined)).toEqual(DEFAULT_DISPLAY);
  });

  it("drops exactly the providers switched off, in catalog order", () => {
    const display = displayFrom({ anthropic: true, openai: false, openrouter: false, fireworks: true });
    // `ollama` is absent, so it takes its default: on.
    expect(display.providers).toEqual(["anthropic", "fireworks", "ollama"]);
  });

  it("reads the blend and the tool-call filter", () => {
    const display = displayFrom({ inputWeight: "25/75", toolCallOnly: false });
    expect(display.inputWeight).toBe("25/75");
    expect(display.toolCallOnly).toBe(false);
  });

  it("falls back to the default for a blend no longer on the list", () => {
    expect(displayFrom({ inputWeight: "80" }).inputWeight).toBe("80/20");
    expect(displayFrom({ inputWeight: 80 }).inputWeight).toBe("80/20");
  });

  it("keeps the tool-call filter on unless it is explicitly off", () => {
    expect(displayFrom({ toolCallOnly: "no" }).toolCallOnly).toBe(true);
  });
});

describe("inputShare", () => {
  it("is the input half of the split, as a fraction", () => {
    expect(inputShare("100/0")).toBe(1);
    expect(inputShare("80/20")).toBe(0.8);
    expect(inputShare("50/50")).toBe(0.5);
    expect(inputShare("0/100")).toBe(0);
  });
});
