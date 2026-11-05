import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BRIEF_CORE } from "../server/content";
import { EVERY_KIND, EVERY_KIND_ANSWER } from "../server/testing/forms";
import {
  AnswerFormSchema,
  FIELD_KINDS,
  FORM_LIMITS,
  choiceDisplay,
  fieldProblem,
  formFields,
  formProblems,
  hasAnyAnswer,
  initialValues,
  parseAnswerForm,
  readAnswerForm,
  sanitizeValues,
  summarizeAnswer,
  type AnswerForm,
  type FormField,
} from "./answer-form";

const problemsOf = (raw: unknown) => {
  const parsed = parseAnswerForm(raw);
  return "problems" in parsed ? parsed.problems.join("\n") : "";
};
const one = (field: Record<string, unknown>) => ({ items: [field] });
const field = <K extends FormField["kind"]>(form: AnswerForm, kind: K) => formFields(form).find((each) => each.kind === kind) as Extract<FormField, { kind: K }>;

describe("checking a form", () => {
  it("accepts a form with every kind of field, a section and a note", () => {
    expect(parseAnswerForm(EVERY_KIND)).toEqual({ form: EVERY_KIND });
    expect(new Set(formFields(EVERY_KIND).map((each) => each.kind))).toEqual(new Set(FIELD_KINDS));
  });

  it("refuses the wrong shape with the path of each problem", () => {
    expect(problemsOf(null)).not.toBe("");
    expect(problemsOf({ items: [] })).toContain("items");
    expect(problemsOf(one({ kind: "slider-ish", id: "a", label: "A" }))).toContain("items.0");
    expect(problemsOf(one({ kind: "text", id: "1st", label: "A" }))).toContain("a letter followed by");
    expect(problemsOf(one({ kind: "text", id: "a", label: "" }))).toContain("items.0.label");
    expect(problemsOf(one({ kind: "choice", id: "a", label: "A", options: [{ value: "x", label: "X" }] }))).toContain("items.0.options");
  });

  it("refuses what the shape cannot say: ids, ranges, defaults and sizes", () => {
    const text = { kind: "text", label: "A" };
    expect(problemsOf({ items: [{ ...text, id: "a" }, { ...text, id: "a" }] })).toContain('two fields have the id "a"');
    expect(problemsOf({ items: [{ kind: "note", text: "Only words" }] })).toContain("no field to answer");
    expect(problemsOf({ items: Array.from({ length: FORM_LIMITS.fields + 1 }, (_, index) => ({ ...text, id: `f${index}` })) })).toContain("at most 24");
    expect(problemsOf(one({ kind: "slider", id: "s", label: "S", min: 5, max: 5 }))).toContain("min must be below max");
    expect(problemsOf(one({ kind: "slider", id: "s", label: "S", min: 0, max: 1e6, step: 1 }))).toContain("larger step");
    expect(problemsOf(one({ kind: "number", id: "n", label: "N", min: 3, max: 1 }))).toContain("min is above max");
    expect(problemsOf(one({ kind: "number", id: "n", label: "N", max: 1, default: 2 }))).toContain("the default is above 1");
    const options = [
      { value: "x", label: "X" },
      { value: "x", label: "Y" },
    ];
    expect(problemsOf(one({ kind: "choice", id: "c", label: "C", options }))).toContain('two options have the value "x"');
    expect(problemsOf(one({ kind: "choice", id: "c", label: "C", options: [options[0], { value: "y", label: "Y" }], default: "z" }))).toContain("not an option value");
    expect(problemsOf(one({ kind: "multi-choice", id: "m", label: "M", options: [options[0], { value: "y", label: "Y" }], minSelected: 2, maxSelected: 1 }))).toContain("minSelected is above maxSelected");
    expect(problemsOf(one({ kind: "scale", id: "s", label: "S", min: 1, max: 20 }))).toContain("2 to 11 points");
    expect(problemsOf(one({ kind: "scale", id: "s", label: "S", pointLabels: ["a", "b"] }))).toContain("2 labels for 5 points");
    expect(problemsOf(one({ kind: "matching", id: "m", label: "M", oneToOne: true, left: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }], right: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] }))).toContain(
      "oneToOne",
    );
    const columns = Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, label: `C${index}`, control: "text" }));
    const rows = Array.from({ length: 11 }, (_, index) => ({ id: `r${index}`, label: `R${index}` }));
    expect(problemsOf(one({ kind: "table", id: "t", label: "T", columns, rows }))).toContain("66 cells; at most 60");
    expect(problemsOf(one({ kind: "table", id: "t", label: "T", columns: [{ id: "c", label: "C", control: "choice" }], rows: [{ id: "r", label: "R" }] }))).toContain("a choice with no options");
    expect(problemsOf({ items: Array.from({ length: 20 }, (_, index) => ({ kind: "note", text: "x".repeat(1_500) })).concat([{ ...text, id: "a" } as never]) })).toContain("characters as JSON");
  });

  it("keeps text as text: no HTML is interpreted anywhere in the schema", () => {
    const parsed = parseAnswerForm(one({ kind: "text", id: "a", label: "<img src=x onerror=alert(1)>" }));
    expect(parsed).toMatchObject({ form: { items: [{ label: "<img src=x onerror=alert(1)>" }] } });
  });

  it("reads a stored form back, or null when it no longer reads", () => {
    expect(readAnswerForm(EVERY_KIND)).toEqual(EVERY_KIND);
    expect(readAnswerForm({ items: "nope" })).toBeNull();
    expect(readAnswerForm(undefined)).toBeNull();
  });

  it("gives the tool a JSON Schema with no $ref (some providers refuse a tool list with one)", () => {
    const schema = JSON.stringify(z.toJSONSchema(AnswerFormSchema));
    expect(schema).not.toContain("$ref");
    expect(schema.length).toBeLessThan(20_000);
  });

  it("the brief's example form is a valid form", () => {
    const example = /For example, a prediction with its reason:\n\n```json\n([\s\S]*?)\n```/u.exec(BRIEF_CORE);
    expect(example).not.toBeNull();
    expect(parseAnswerForm(JSON.parse(example![1]!))).toHaveProperty("form");
  });

  it("a dropdown above six options unless the form says otherwise", () => {
    const options = (count: number) => Array.from({ length: count }, (_, index) => ({ value: `v${index}`, label: `V${index}` }));
    const choice = (count: number, display?: "radio" | "dropdown") => ({ kind: "choice" as const, id: "c", label: "C", options: options(count), ...(display ? { display } : {}) });
    expect(choiceDisplay(choice(6))).toBe("radio");
    expect(choiceDisplay(choice(7))).toBe("dropdown");
    expect(choiceDisplay(choice(7, "radio"))).toBe("radio");
    expect(choiceDisplay(choice(2, "dropdown"))).toBe("dropdown");
  });
});

describe("values", () => {
  it("starts from the defaults, with a ranking in the order given and an empty table", () => {
    const values = initialValues(EVERY_KIND);
    expect(values).toMatchObject({ name: "", count: null, callers: [], safe: null, order: ["parse", "sort", "pick"], pairs: { empty: null, one: null }, edges: [""] });
    expect(values.compare).toEqual({ sort: { cost: null, stable: false, grade: null }, heap: { cost: null, stable: false, grade: null } });
    expect(hasAnyAnswer(EVERY_KIND, values)).toBe(false);
  });

  it("says what each field still needs", () => {
    const problems = formProblems(EVERY_KIND, initialValues(EVERY_KIND));
    // Optional fields need nothing; a ranking always has an order.
    expect([...problems.keys()].sort()).toEqual(["callers", "clarity", "compare", "count", "edges", "module", "name", "outcome", "pairs", "risk", "safe"]);
    expect(formProblems(EVERY_KIND, EVERY_KIND_ANSWER).size).toBe(0);
    expect(fieldProblem(field(EVERY_KIND, "number"), 11)).toBe("is above 10");
    expect(fieldProblem(field(EVERY_KIND, "number"), 1.5)).toBe("is not a multiple of 1");
    expect(fieldProblem(field(EVERY_KIND, "multi-choice"), ["cli", "api", "tests"])).toBe("takes at most 2 ticked");
    expect(fieldProblem(field(EVERY_KIND, "list"), ["only one", ""])).toBe("needs at least 2 entries");
    expect(fieldProblem(field(EVERY_KIND, "matching"), { empty: "error", one: null })).toBe("needs every item matched");
    expect(fieldProblem(field(EVERY_KIND, "matching"), { empty: "error", one: "error" })).toBe("uses an item twice");
    expect(fieldProblem(field(EVERY_KIND, "table"), { sort: { cost: 1, stable: true, grade: "good" }, heap: { cost: null, stable: false, grade: "bad" } })).toBe("needs every cell filled");
    expect(fieldProblem({ kind: "text", id: "t", label: "T", minLength: 5 }, "abc")).toBe("needs at least 5 characters");
  });

  it("reads what a card sent against the form: wrong shapes are no answer, numbers clamped, texts cut, unknowns dropped", () => {
    const values = sanitizeValues(EVERY_KIND, {
      name: 42,
      count: 99,
      risk: "high",
      outcome: "explode",
      callers: ["api", "nope", "api", 3],
      safe: "yes",
      clarity: 4.6,
      order: ["pick", "pick", "bogus"],
      pairs: { empty: "three", one: "nope", extra: "error" },
      edges: ["a", 5, "", "x".repeat(900)],
      compare: { sort: { cost: "cheap", stable: "yes", grade: "good", extra: 1 }, heap: "nope" },
      __proto__: { name: "polluted" },
      injected: "dropped",
    });
    expect(values).toEqual({
      name: null,
      count: 10,
      why: null,
      fix: null,
      risk: null,
      outcome: null,
      module: null,
      callers: ["api"],
      safe: null,
      clarity: 5,
      order: ["pick", "parse", "sort"],
      pairs: { empty: "three", one: null },
      edges: ["a", "x".repeat(500)],
      compare: { sort: { cost: null, stable: false, grade: "good" }, heap: { cost: null, stable: false, grade: null } },
    });
    for (const junk of [null, "text", 3, [], { name: { deep: true } }]) expect(() => sanitizeValues(EVERY_KIND, junk)).not.toThrow();
  });

  it("summarises the answer field by field, under its sections", () => {
    const summary = summarizeAnswer(EVERY_KIND, sanitizeValues(EVERY_KIND, EVERY_KIND_ANSWER));
    expect(summary).toBe(
      [
        "- Function name: median",
        "- Calls: 2 calls",
        "- Why?: (no answer)",
        "- Your fix:",
        "    (no answer)",
        "- Risk: 30%",
        "",
        "## Choices",
        "- What happens?: It raises",
        "- Which module?: calc.py",
        "- Who calls it?: The CLI, The tests",
        "- Safe to call twice?: Yes",
        "- How clear is the code?: 4 on 1–5",
        "- Order the steps:",
        "    1. Parse",
        "    2. Sort",
        "    3. Pick the middle",
        "- Match each input to its result:",
        "    [] → ValueError",
        "    [3] → 3",
        "- Edge cases:",
        "    • empty list",
        "    • one item",
        "- Compare:",
        "    sorted(): Cost 3; Stable yes; Grade Good",
        "    heapq: Cost 2; Stable no; Grade Bad",
      ].join("\n"),
    );
    const code = summarizeAnswer({ items: [{ kind: "code", id: "c", label: "Fix", language: "py" }] }, { c: "x = 1\n" });
    expect(code).toBe("- Fix:\n    ```py\n    x = 1\n    ```");
  });
});
