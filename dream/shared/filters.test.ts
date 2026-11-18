import { describe, expect, it } from "vitest";

import { dreamEligible, matchesFilter } from "./filters";
import type { ProjectStatus } from "./types";

const status = (overrides: { enabled?: boolean; due?: boolean; files?: number; projectId?: string }): ProjectStatus =>
  ({
    projectId: overrides.projectId ?? "p_1",
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
  const none = new Set<string>();

  it("splits projects by memory files and by eligibility", () => {
    expect(matchesFilter(status({ files: 0 }), "without-memory", none)).toBe(true);
    expect(matchesFilter(status({ files: 0 }), "with-memory", none)).toBe(false);
    expect(matchesFilter(status({ files: 2 }), "with-memory", none)).toBe(true);
    expect(matchesFilter(status({ due: true }), "eligible", none)).toBe(true);
    expect(matchesFilter(status({}), "all", none)).toBe(true);
  });

  it("keeps the projects with a dry run waiting, from the waiting list", () => {
    const waiting = new Set(["p_waits"]);
    expect(matchesFilter(status({ projectId: "p_waits" }), "pending", waiting)).toBe(true);
    expect(matchesFilter(status({ projectId: "p_other" }), "pending", waiting)).toBe(false);
    expect(matchesFilter(status({ projectId: "p_waits" }), "pending", none)).toBe(false);
  });
});
