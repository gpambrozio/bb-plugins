import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { OrientationBlock, OrientationSummary } from "../shared/orientation";
import { renderOrientationMarkdown, renderSummaryMarkdown } from "./orientation-markdown";
import { parseShowboat } from "./testing/showboat-grammar";

const summary: OrientationSummary = {
  purpose: "A retrying HTTP client.",
  languages: ["TypeScript", "Shell"],
  stages: ["Parse config", "Send request", "Retry on failure"],
  keyFiles: [
    { path: "src/client.ts", does: "sends requests", why: "every call goes through it" },
    { path: "src/retry.ts", does: "decides retries", why: "the policy lives here" },
  ],
  concepts: [{ name: "Backoff", definition: "Waiting longer after each failure.", where: "src/retry.ts" }],
  gotchas: ["Retries are off by default.", "Timeouts count per attempt."],
  exercises: [
    { file: "src/retry.ts", read: "the delay function", question: "what is the cap?" },
    { file: "src/client.ts", read: "send()", question: "where does the abort signal go?" },
  ],
  sources: ["README.md", "src/client.ts"],
};

const listingText = "export function delay(n: number) {\n  return Math.min(2 ** n * 100, 5000);\n}";
const chapter: OrientationBlock = { kind: "chapter", ordinal: 1, title: "How retries work" };
const note: OrientationBlock = { kind: "note", ordinal: 2, markdown: "Retries use [Listing 1](#listing-1)." };
function listingWith(text: string, path = "src/retry.ts"): OrientationBlock {
  return {
    kind: "listing",
    ordinal: 3,
    number: 1,
    caption: "The delay function",
    path,
    startLine: 40,
    endLine: 72,
    text,
    ref: null,
    check: null,
  };
}

const doc = {
  title: "Repo Orientation: demo",
  readyAt: Date.UTC(2026, 10, 7, 12, 30, 0),
  headSha: "0123456789abcdef0123456789abcdef01234567",
  summary,
  blocks: [chapter, note, listingWith(listingText)] as readonly OrientationBlock[],
};

describe("renderOrientationMarkdown", () => {
  it("matches the reviewed golden file", () => {
    const path = new URL("./testing/orientation.golden.md", import.meta.url);
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, renderOrientationMarkdown(doc));
    expect(renderOrientationMarkdown(doc)).toBe(readFileSync(path, "utf8"));
  });

  it("exports every listing as a code block followed by its output", () => {
    const blocks = parseShowboat(renderOrientationMarkdown(doc));
    const code = blocks.filter((b) => b.type === "code");
    expect(code.map((b) => (b as { code: string }).code)).toEqual(["sed -n '40,72p' 'src/retry.ts'"]);
    expect(blocks[blocks.indexOf(code[0]) + 1]).toEqual({ type: "output", content: listingText });
  });

  it("lengthens fences around text that contains fences", () => {
    const md = renderOrientationMarkdown({ ...doc, blocks: [chapter, listingWith("```js\nx\n```")] });
    expect(parseShowboat(md).find((b) => b.type === "output")).toEqual({ type: "output", content: "```js\nx\n```" });
  });

  it("leaves out Contents and Code Listings for a summary-only orientation", () => {
    const md = renderOrientationMarkdown({ ...doc, blocks: [] });
    expect(md).not.toContain("## Code Listings");
    expect(md).not.toContain("## Contents");
  });

  it("quotes a path with a single quote safely", () => {
    const md = renderOrientationMarkdown({ ...doc, blocks: [chapter, listingWith(listingText, "it's.ts")] });
    expect(md).toContain(`'it'\\''s.ts'`);
  });

  it("omits the build sha when unknown", () => {
    const md = renderOrientationMarkdown({ ...doc, headSha: null });
    expect(md).not.toContain("built at");
  });

  it("deduplicates chapter slugs in Contents", () => {
    const blocks: OrientationBlock[] = [
      { kind: "chapter", ordinal: 1, title: "Retries & Limits" },
      { kind: "chapter", ordinal: 2, title: "Retries & Limits" },
    ];
    const md = renderOrientationMarkdown({ ...doc, blocks });
    expect(md).toContain("- [Retries & Limits](#retries--limits)\n- [Retries & Limits](#retries--limits-1)");
  });
});

describe("renderSummaryMarkdown", () => {
  it("renders the sections in order", () => {
    const md = renderSummaryMarkdown(summary);
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## One-line purpose",
      "## Primary language(s)",
      "## Pipeline / workflow stages",
      "## Key files",
      "## Core concepts",
      "## Common gotchas",
      "## Suggested exercise sequence",
      "## Sources consulted",
    ]);
    expect(md).toContain("- `src/retry.ts` — decides retries | the policy lives here");
    expect(md).toContain("**Backoff**: Waiting longer after each failure. (src/retry.ts)");
    expect(md).toContain("1. Open `src/retry.ts`. Read: the delay function. Then: what is the cap?");
  });
});
