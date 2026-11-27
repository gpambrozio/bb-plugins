import { describe, expect, it } from "vitest";

import { applyChanges, changeCounts, unifiedPatch } from "./prompt-edit";

const BASE = ["You are Voice Pilot.", "", "Style: speak briefly.", "", "Greeting: say hi.", "", "Doing: send messages."].join("\n");

describe("an instructions edit's changes", () => {
  it("replaces quoted text, in order", () => {
    const next = applyChanges(BASE, [
      { find: "speak briefly.", replace: "speak briefly, and call the user Sam." },
      { find: "Greeting: say hi.", replace: "Greeting: say hi, Sam." },
    ]);
    expect(next).toContain("Style: speak briefly, and call the user Sam.");
    expect(next).toContain("Greeting: say hi, Sam.");
    expect(next.startsWith("You are Voice Pilot.")).toBe(true);
  });

  it("appends with an empty find, after a blank line", () => {
    expect(applyChanges(BASE, [{ find: "", replace: "Never use emoji." }])).toBe(`${BASE}\n\nNever use emoji.`);
    expect(applyChanges("", [{ find: "", replace: "Only this." }])).toBe("Only this.");
  });

  it("refuses a find that is missing or ambiguous, naming the change", () => {
    expect(() => applyChanges(BASE, [{ find: "Rules that always hold", replace: "x" }])).toThrow(/The change looks for text that is not in the instructions/u);
    expect(() => applyChanges(BASE, [{ find: "Voice Pilot", replace: "x" }, { find: "\n\n", replace: "\n" }])).toThrow(/^Change 2 looks for text that occurs more than once/u);
  });
});

describe("the diff bb draws", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedPatch(BASE, BASE, "i.md")).toBe("");
  });

  it("is a unified patch with headers, context and correct hunk ranges", () => {
    const next = BASE.replace("Greeting: say hi.", "Greeting: say hi, Sam.");
    expect(unifiedPatch(BASE, next, "i.md")).toBe(
      [
        "--- a/i.md",
        "+++ b/i.md",
        "@@ -2,6 +2,6 @@",
        " ",
        " Style: speak briefly.",
        " ",
        "-Greeting: say hi.",
        "+Greeting: say hi, Sam.",
        " ",
        " Doing: send messages.",
        "",
      ].join("\n"),
    );
    expect(changeCounts(BASE, next)).toEqual({ added: 1, removed: 1 });
  });

  it("splits changes far apart into separate hunks, and counts an appended line", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const next = long.replace("line 2\n", "line two\n").concat("\nline 31");
    const patch = unifiedPatch(long, next, "i.md");
    expect(patch.match(/^@@/gmu)).toHaveLength(2);
    expect(patch).toContain("@@ -1,5 +1,5 @@");
    expect(patch).toContain("@@ -28,3 +28,4 @@\n line 28\n line 29\n line 30\n+line 31\n");
    expect(changeCounts(long, next)).toEqual({ added: 2, removed: 1 });
  });

  it("covers a whole rewrite from an empty side", () => {
    expect(unifiedPatch("", "a\nb", "i.md")).toBe("--- a/i.md\n+++ b/i.md\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  });
});
