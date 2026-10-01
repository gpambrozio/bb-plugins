import { describe, expect, it } from "vitest";

import { isDarkColor, pickAccent, PROVIDERS, providersOfSource, sourcesFor } from "./providers";

describe("provider accents", () => {
  /**
   * The regression test for the whole reason this is a palette. The Paseo
   * plugin's first cut took colours from theme tokens, and two of them came out
   * the same green — two providers that could not be told apart.
   */
  it("gives every provider a colour no other provider has", () => {
    const dark = PROVIDERS.map((provider) => provider.accent.dark);
    const light = PROVIDERS.map((provider) => provider.accent.light);

    expect(new Set(dark).size).toBe(PROVIDERS.length);
    expect(new Set(light).size).toBe(PROVIDERS.length);
  });

  it("states both variants as six-digit hex, which is what pickAccent can read", () => {
    for (const provider of PROVIDERS) {
      expect(provider.accent.dark).toMatch(/^#[0-9a-f]{6}$/);
      expect(provider.accent.light).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps the light variant darker than the dark one", () => {
    // Each pair is the same hue at two lightnesses: the `dark` value has to
    // read on a dark background and the `light` value on a light one, so
    // getting them the wrong way round is invisible until someone switches
    // theme.
    for (const provider of PROVIDERS) {
      expect(isDarkColor(provider.accent.light)).toBe(true);
      expect(isDarkColor(provider.accent.dark)).toBe(false);
    }
  });
});

describe("isDarkColor", () => {
  it("reads dark colours as dark and white as light", () => {
    expect(isDarkColor("#000000")).toBe(true);
    expect(isDarkColor("#1a1a1a")).toBe(true);
    expect(isDarkColor("#ffffff")).toBe(false);
    expect(isDarkColor("#f5f5f5")).toBe(false);
  });

  it("weights green the way the eye does", () => {
    // The same channel at full strength: green reads as light, blue as dark. A
    // plain average of the channels would call both the same.
    expect(isDarkColor("#00ff00")).toBe(false);
    expect(isDarkColor("#0000ff")).toBe(true);
  });

  it("falls back to dark for anything it cannot parse", () => {
    expect(isDarkColor("rgb(20, 20, 20)")).toBe(true);
    expect(isDarkColor("")).toBe(true);
    expect(isDarkColor("#fff")).toBe(true);
  });
});

describe("pickAccent", () => {
  const accent = { dark: "#f0916a", light: "#c2410c" };

  it("takes the variant built for bb's appearance", () => {
    expect(pickAccent(accent, "dark")).toBe("#f0916a");
    expect(pickAccent(accent, "light")).toBe("#c2410c");
  });
});

describe("sourcesFor", () => {
  it("asks for one upstream per provider set, not one per provider", () => {
    expect(sourcesFor(["anthropic", "openai", "fireworks", "ollama"])).toEqual(["models-dev"]);
    expect(sourcesFor(["openrouter"])).toEqual(["openrouter"]);
    expect(sourcesFor(["anthropic", "openrouter"])).toEqual(["models-dev", "openrouter"]);
  });

  it("ignores an id no build knows about, rather than inventing a source", () => {
    expect(sourcesFor(["mystery"])).toEqual([]);
    expect(sourcesFor([])).toEqual([]);
  });
});

describe("providersOfSource", () => {
  it("knows which providers a single models.dev fetch answers for", () => {
    expect(providersOfSource("models-dev").map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "fireworks",
      "ollama",
    ]);
    expect(providersOfSource("openrouter").map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  it("names the catalog keys that differ from the provider ids", () => {
    const keys = providersOfSource("models-dev").map((provider) => provider.catalogKey);
    expect(keys).toEqual(["anthropic", "openai", "fireworks-ai", "ollama-cloud"]);
  });
});
