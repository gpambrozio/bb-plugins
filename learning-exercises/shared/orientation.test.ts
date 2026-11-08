import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OrientationSummarySchema, parseLineRange } from "./orientation";

const keyFile = (n: number) => ({ path: `src/f${n}.ts`, does: "does a thing", why: "matters" });
const concept = (n: number) => ({ name: `c${n}`, definition: "what it is", where: "src/f1.ts" });
const exercise = (n: number) => ({ file: `src/f${n}.ts`, read: "lines 1-10", question: "what happens?" });

function summary() {
  return {
    purpose: "A thing that does stuff.",
    languages: ["TypeScript"],
    stages: ["input", "process", "output"],
    keyFiles: [1, 2, 3, 4, 5, 6].map(keyFile),
    concepts: [1, 2, 3].map(concept),
    gotchas: ["one", "two"],
    exercises: [exercise(1), exercise(2)],
    sources: ["README.md"],
  };
}

describe("orientation schemas", () => {
  it("accepts a summary at the limits and refuses one exercise or three", () => {
    expect(OrientationSummarySchema.safeParse(summary()).success).toBe(true);
    expect(OrientationSummarySchema.safeParse({ ...summary(), exercises: [summary().exercises[0]] }).success).toBe(false);
    expect(OrientationSummarySchema.safeParse({ ...summary(), exercises: [...summary().exercises, summary().exercises[0]] }).success).toBe(false);
    expect(OrientationSummarySchema.safeParse({ ...summary(), keyFiles: summary().keyFiles.slice(0, 5) }).success).toBe(false);
    expect(OrientationSummarySchema.safeParse({ ...summary(), concepts: [] }).success).toBe(false);
  });
  it("parses line ranges", () => {
    expect(parseLineRange("40")).toEqual({ start: 40, end: 40 });
    expect(parseLineRange("40-72")).toEqual({ start: 40, end: 72 });
    for (const bad of ["0", "72-40", "a-b", "", "40-", "4.5"]) expect(parseLineRange(bad)).toBeNull();
  });
  it("has no $ref in the summary's JSON Schema", () => {
    expect(JSON.stringify(z.toJSONSchema(OrientationSummarySchema))).not.toContain("$ref");
  });
});
