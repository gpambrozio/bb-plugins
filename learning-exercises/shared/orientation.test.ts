import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ORIENT_LIMITS, OrientationSummarySchema, parseLineRange } from "./orientation";

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
  it("refuses a line break of any kind in every summary string", () => {
    const fields: ((value: string) => unknown)[] = [
      (v) => ({ ...summary(), purpose: v }),
      (v) => ({ ...summary(), languages: [v] }),
      (v) => ({ ...summary(), stages: [v] }),
      (v) => ({ ...summary(), keyFiles: summary().keyFiles.map((f, i) => (i === 0 ? { ...f, why: v } : f)) }),
      (v) => ({ ...summary(), concepts: summary().concepts.map((c, i) => (i === 0 ? { ...c, definition: v } : c)) }),
      (v) => ({ ...summary(), gotchas: ["one", v] }),
      (v) => ({ ...summary(), exercises: [{ ...exercise(1), question: v }, exercise(2)] }),
      (v) => ({ ...summary(), sources: [v] }),
    ];
    for (const field of fields) {
      expect(OrientationSummarySchema.safeParse(field("one line")).success).toBe(true);
      for (const lineBreak of ["\n", "\r", "\u2028", "\u2029"]) {
        const result = OrientationSummarySchema.safeParse(field(`first${lineBreak}\`\`\`bash`));
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain("one line");
      }
    }
  });

  it("caps prose at summaryText, the purpose at purposeChars and names and paths at summaryName", () => {
    expect(ORIENT_LIMITS).toMatchObject({ summaryText: 500, purposeChars: 300, summaryName: 200 });
    const ok = (value: unknown) => OrientationSummarySchema.safeParse(value).success;
    expect(ok({ ...summary(), purpose: "p".repeat(300) })).toBe(true);
    expect(ok({ ...summary(), purpose: "p".repeat(301) })).toBe(false);
    expect(ok({ ...summary(), gotchas: ["one", "g".repeat(500)] })).toBe(true);
    expect(ok({ ...summary(), gotchas: ["one", "g".repeat(501)] })).toBe(false);
    expect(ok({ ...summary(), stages: ["s".repeat(501)] })).toBe(false);
    expect(ok({ ...summary(), keyFiles: summary().keyFiles.map((f, i) => (i === 0 ? { ...f, path: "p".repeat(201) } : f)) })).toBe(false);
    expect(ok({ ...summary(), concepts: summary().concepts.map((c, i) => (i === 0 ? { ...c, name: "n".repeat(201) } : c)) })).toBe(false);
    expect(ok({ ...summary(), languages: ["l".repeat(201)] })).toBe(false);
    expect(ok({ ...summary(), sources: ["s".repeat(200)] })).toBe(true);
    expect(ok({ ...summary(), sources: ["s".repeat(201)] })).toBe(false);
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
