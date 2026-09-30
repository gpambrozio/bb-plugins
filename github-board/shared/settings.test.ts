import { describe, expect, it } from "vitest";

import { DEFAULT_PROMPTS, normalizePrompts, renderTemplate, templateFor } from "./settings";

describe("normalizePrompts", () => {
  it("turns a blank type template back into its default", () => {
    const normalized = normalizePrompts({
      byType: { ...DEFAULT_PROMPTS, issues: "   ", "open-prs": "Custom {url}" },
      byProject: {},
    });
    expect(normalized.byType.issues).toBe(DEFAULT_PROMPTS.issues);
    expect(normalized.byType["open-prs"]).toBe("Custom {url}");
  });

  it("drops blank overrides, and a project left with none", () => {
    const normalized = normalizePrompts({
      byType: DEFAULT_PROMPTS,
      byProject: {
        kept: { issues: "Fix {url}", discussions: "" },
        emptied: { issues: " " },
      },
    });
    expect(normalized.byProject).toEqual({ kept: { issues: "Fix {url}" } });
  });
});

describe("templateFor", () => {
  const prompts = {
    byType: DEFAULT_PROMPTS,
    byProject: { p1: { issues: "Project {url}", "open-prs": " " } },
  };

  it("prefers a project's override, and ignores a blank one", () => {
    expect(templateFor(prompts, "issues", "p1")).toBe("Project {url}");
    expect(templateFor(prompts, "open-prs", "p1")).toBe(DEFAULT_PROMPTS["open-prs"]);
    expect(templateFor(prompts, "issues", null)).toBe(DEFAULT_PROMPTS.issues);
    expect(templateFor(prompts, "issues", "unknown")).toBe(DEFAULT_PROMPTS.issues);
  });
});

describe("renderTemplate", () => {
  it("fills the four placeholders and leaves any other standing", () => {
    const item = { url: "https://github.com/o/r/issues/7", title: "Crash", number: 7, repository: "o/r" };
    expect(renderTemplate("{repository}#{number} {title} {url} {unknown}", item)).toBe(
      "o/r#7 Crash https://github.com/o/r/issues/7 {unknown}",
    );
  });
});
