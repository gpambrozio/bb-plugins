import { describe, expect, it } from "vitest";

import type { PriceRow } from "../shared/pricing";
import { emptyMessage, nextSort, providerKeyOf, stampOf, subtitle, visibleRows, type Filters } from "./visible";

function row(overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextTokens: 1_000_000,
    outputTokens: 128_000,
    inputCost: 2,
    outputCost: 10,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    temperature: null,
    releaseDate: null,
    ...overrides,
  };
}

const ALL = ["anthropic", "openai", "fireworks", "ollama", "openrouter"];

function filters(overrides: Partial<Filters> = {}): Filters {
  return {
    enabled: ALL,
    hidden: new Set(),
    toolCallOnly: true,
    search: "",
    inputWeight: "80/20",
    sort: { key: "relative", descending: false },
    ...overrides,
  };
}

describe("visibleRows", () => {
  it("is empty before anything has loaded", () => {
    expect(visibleRows(null, filters())).toEqual([]);
  });

  it("drops rows of a provider switched off, even when an older answer still carries them", () => {
    const rows = [row(), row({ providerId: "openai", modelId: "gpt-6", name: "GPT-6" })];
    const shown = visibleRows(rows, filters({ enabled: ["openai"] }));
    expect(shown.map((entry) => entry.row.modelId)).toEqual(["gpt-6"]);
  });

  it("drops rows hidden by their legend dot", () => {
    const rows = [row(), row({ providerId: "openai", modelId: "gpt-6", name: "GPT-6" })];
    const shown = visibleRows(rows, filters({ hidden: new Set(["anthropic"]) }));
    expect(shown.map((entry) => entry.row.providerId)).toEqual(["openai"]);
  });

  it("hides a model that cannot call tools but keeps one whose provider does not say", () => {
    const rows = [row({ modelId: "no", toolCall: false }), row({ modelId: "unknown", toolCall: null })];
    expect(visibleRows(rows, filters()).map((entry) => entry.row.modelId)).toEqual(["unknown"]);
    expect(visibleRows(rows, filters({ toolCallOnly: false }))).toHaveLength(2);
  });

  it("matches every search word against the name, the id and the provider", () => {
    const rows = [
      row({ modelId: "claude-opus-5", name: "Claude Opus 5" }),
      row({ providerId: "openrouter", modelId: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" }),
      row({ providerId: "openai", modelId: "gpt-6", name: "GPT-6" }),
    ];
    expect(visibleRows(rows, filters({ search: "opus openrouter" })).map((entry) => entry.row.providerId)).toEqual([
      "openrouter",
    ]);
    expect(visibleRows(rows, filters({ search: "  OPUS  " }))).toHaveLength(2);
  });

  it("ranks against the cheapest visible row, so hiding it moves the baseline", () => {
    const rows = [
      row({ modelId: "cheap", inputCost: 1, outputCost: 1 }),
      row({ providerId: "openai", modelId: "dear", inputCost: 4, outputCost: 4 }),
    ];
    expect(visibleRows(rows, filters()).map((entry) => entry.relative)).toEqual([1, 4]);
    expect(visibleRows(rows, filters({ hidden: new Set(["anthropic"]) }))[0]?.relative).toBe(1);
  });

  it("weights the relative column by the blend setting", () => {
    // Input-heavy and output-heavy models swap places between the two blends.
    const rows = [
      row({ modelId: "input-cheap", inputCost: 1, outputCost: 20 }),
      row({ modelId: "output-cheap", inputCost: 5, outputCost: 2 }),
    ];
    const ids = (weight: Filters["inputWeight"]) =>
      visibleRows(rows, filters({ inputWeight: weight })).map((entry) => entry.row.modelId);
    expect(ids("100/0")).toEqual(["input-cheap", "output-cheap"]);
    expect(ids("0/100")).toEqual(["output-cheap", "input-cheap"]);
  });
});

describe("nextSort", () => {
  it("flips the direction when the same column is pressed again", () => {
    expect(nextSort({ key: "price", descending: true }, "price")).toEqual({ key: "price", descending: false });
  });

  it("starts names and providers A to Z and numbers largest first", () => {
    expect(nextSort({ key: "price", descending: true }, "name")).toEqual({ key: "name", descending: false });
    expect(nextSort({ key: "price", descending: true }, "provider")).toEqual({ key: "provider", descending: false });
    expect(nextSort({ key: "name", descending: false }, "context")).toEqual({ key: "context", descending: true });
  });
});

describe("stampOf", () => {
  it("reports the oldest source, not the time of the reply", () => {
    const sources = [
      { id: "models-dev", fetchedAt: 2_000, cached: true, error: null },
      { id: "openrouter", fetchedAt: 1_000, cached: true, error: null },
    ];
    expect(stampOf(sources, 9_000)).toBe(1_000);
  });

  it("ignores a source that never loaded, and falls back to now when none did", () => {
    expect(stampOf([{ id: "openrouter", fetchedAt: 0, cached: false, error: "down" }], 9_000)).toBe(9_000);
  });
});

describe("subtitle", () => {
  it("says what the table measures and how old it is", () => {
    const now = 10 * 60 * 60 * 1000;
    expect(subtitle("80/20", true, now - 60 * 60 * 1000, true, now)).toBe(
      "Agent-capable models · 80:20 input:output blend · cheapest = 1.0× · USD per 1M tokens · updated 1 hour ago",
    );
    expect(subtitle("25/75", false, 0, false, now)).toBe(
      "All models · 25:75 input:output blend · cheapest = 1.0× · USD per 1M tokens",
    );
  });
});

describe("emptyMessage", () => {
  it("names the reason the table is empty", () => {
    expect(emptyMessage({ enabled: 0, hidden: 0, busy: false, loaded: true })).toMatch(/No providers/);
    expect(emptyMessage({ enabled: 2, hidden: 0, busy: true, loaded: false })).toBe("Loading prices…");
    expect(emptyMessage({ enabled: 2, hidden: 2, busy: false, loaded: true })).toMatch(/Every provider is hidden/);
    expect(emptyMessage({ enabled: 2, hidden: 1, busy: false, loaded: true })).toBe("Nothing matches.");
  });
});

describe("providerKeyOf", () => {
  it("is the same for the same providers in any order", () => {
    expect(providerKeyOf(["openai", "anthropic"])).toBe(providerKeyOf(["anthropic", "openai"]));
    expect(providerKeyOf([])).toBe("");
  });
});
