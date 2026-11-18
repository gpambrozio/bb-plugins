import { describe, expect, it } from "vitest";

import { dreamEligible, matchesFilter } from "./filters";
import type { ProjectStatus } from "./types";

const status = (overrides: { enabled?: boolean; due?: boolean; files?: number }): ProjectStatus =>
  ({
    enabled: overrides.enabled ?? true,
    gate: { due: overrides.due ?? false },
    memory: { files: overrides.files ?? 3 },
  }) as unknown as ProjectStatus;

describe("dreamEligible", () => {
  it("is a project whose switch is on and whose gate says due", () => {
    expect(dreamEligible(status({ due: true }))).toBe(true);
    expect(dreamEligible(status({ due: true, enabled: false }))).toBe(false);
    expect(dreamEligible(status({ due: false }))).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("splits projects by memory files and by eligibility", () => {
    expect(matchesFilter(status({ files: 0 }), "without-memory")).toBe(true);
    expect(matchesFilter(status({ files: 0 }), "with-memory")).toBe(false);
    expect(matchesFilter(status({ files: 2 }), "with-memory")).toBe(true);
    expect(matchesFilter(status({ due: true }), "eligible")).toBe(true);
    expect(matchesFilter(status({}), "all")).toBe(true);
  });
});
