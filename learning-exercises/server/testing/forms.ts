/** Answer forms for tests: one field of every kind, laid out with a section, a note and widths. */
import type { AnswerForm } from "../../shared/answer-form";

export const EVERY_KIND: AnswerForm = {
  items: [
    { kind: "note", text: "Open `calc.py:12` first." },
    { kind: "text", id: "name", label: "Function name", placeholder: "e.g. median", width: "half" },
    { kind: "number", id: "count", label: "Calls", min: 0, max: 10, step: 1, unit: "calls", width: "half" },
    { kind: "long-text", id: "why", label: "Why?", help: "See `calc.py:12-20`.", required: false },
    { kind: "code", id: "fix", label: "Your fix", language: "py", required: false },
    { kind: "slider", id: "risk", label: "Risk", min: 0, max: 100, step: 10, minLabel: "None", maxLabel: "Certain", unit: "%" },
    { kind: "section", title: "Choices", help: "Pick what fits." },
    {
      kind: "choice",
      id: "outcome",
      label: "What happens?",
      options: [
        { value: "raise", label: "It raises" },
        { value: "none", label: "It returns None" },
      ],
    },
    {
      kind: "choice",
      id: "module",
      label: "Which module?",
      display: "dropdown",
      options: [
        { value: "calc", label: "calc.py" },
        { value: "stats", label: "stats.py" },
      ],
    },
    {
      kind: "multi-choice",
      id: "callers",
      label: "Who calls it?",
      minSelected: 1,
      maxSelected: 2,
      options: [
        { value: "cli", label: "The CLI" },
        { value: "api", label: "The API" },
        { value: "tests", label: "The tests" },
      ],
    },
    { kind: "yes-no", id: "safe", label: "Safe to call twice?" },
    { kind: "scale", id: "clarity", label: "How clear is the code?", minLabel: "Opaque", maxLabel: "Obvious" },
    {
      kind: "ranking",
      id: "order",
      label: "Order the steps",
      items: [
        { value: "parse", label: "Parse" },
        { value: "sort", label: "Sort" },
        { value: "pick", label: "Pick the middle" },
      ],
    },
    {
      kind: "matching",
      id: "pairs",
      label: "Match each input to its result",
      oneToOne: true,
      left: [
        { value: "empty", label: "[]" },
        { value: "one", label: "[3]" },
      ],
      right: [
        { value: "error", label: "ValueError" },
        { value: "three", label: "3" },
      ],
    },
    { kind: "list", id: "edges", label: "Edge cases", minEntries: 2, maxEntries: 4 },
    {
      kind: "table",
      id: "compare",
      label: "Compare",
      columns: [
        { id: "cost", label: "Cost", control: "number" },
        { id: "stable", label: "Stable", control: "checkbox" },
        {
          id: "grade",
          label: "Grade",
          control: "choice",
          options: [
            { value: "good", label: "Good" },
            { value: "bad", label: "Bad" },
          ],
        },
      ],
      rows: [
        { id: "sort", label: "sorted()" },
        { id: "heap", label: "heapq" },
      ],
    },
  ],
};

/** An answer to `EVERY_KIND` that the form accepts. */
export const EVERY_KIND_ANSWER = {
  name: "median",
  count: 2,
  why: "",
  fix: "",
  risk: 30,
  outcome: "raise",
  module: "calc",
  callers: ["cli", "tests"],
  safe: true,
  clarity: 4,
  order: ["parse", "sort", "pick"],
  pairs: { empty: "error", one: "three" },
  edges: ["empty list", "one item"],
  compare: { sort: { cost: 3, stable: true, grade: "good" }, heap: { cost: 2, stable: false, grade: "bad" } },
};
