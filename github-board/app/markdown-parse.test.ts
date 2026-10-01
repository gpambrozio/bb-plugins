import { describe, expect, it } from "vitest";

import { inlineTokens, parseMarkdown } from "./markdown-parse";

describe("parseMarkdown", () => {
  it("turns an image on its own line, in either spelling, into an image block", () => {
    expect(parseMarkdown("![shot](https://github.com/user-attachments/assets/x)")).toEqual([
      { kind: "image", alt: "shot", url: "https://github.com/user-attachments/assets/x" },
    ]);
    expect(parseMarkdown('<img width="300" alt="a" src="https://tracker.example/p.gif">')).toEqual([
      { kind: "image", alt: "a", url: "https://tracker.example/p.gif" },
    ]);
  });

  it("drops HTML comments, as GitHub does for issue templates", () => {
    expect(parseMarkdown("<!-- fill this in -->\nHello")).toEqual([{ kind: "paragraph", text: "Hello" }]);
  });

  it("reads details, task lists, code and tables", () => {
    const blocks = parseMarkdown(
      [
        "<details open><summary>More</summary>",
        "",
        "- [x] done",
        "- [ ] todo",
        "</details>",
        "```",
        "<b>not html</b>",
        "```",
        "| a | b |",
        "|---|---|",
        "| 1 | ![x](https://github.com/x.png) |",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["details", "code", "table"]);
    const details = blocks[0];
    expect(details?.kind === "details" && details.open && details.summary).toBe("More");
    expect(details?.kind === "details" && details.blocks[0]).toEqual({
      kind: "list",
      items: [
        { marker: "☑", depth: 0, text: "done" },
        { marker: "☐", depth: 0, text: "todo" },
      ],
    });
    expect(blocks[1]).toEqual({ kind: "code", text: "<b>not html</b>" });
  });
});

describe("inlineTokens", () => {
  it("splits bold, code, links and inline images out of text", () => {
    expect(inlineTokens("See **this**, `code`, [docs](https://x.dev) and ![pic](https://y.dev/a.png).")).toEqual([
      { kind: "text", text: "See " },
      { kind: "bold", text: "this" },
      { kind: "text", text: ", " },
      { kind: "code", text: "code" },
      { kind: "text", text: ", " },
      { kind: "link", url: "https://x.dev", label: "docs", image: false },
      { kind: "text", text: " and " },
      { kind: "link", url: "https://y.dev/a.png", label: "pic", image: true },
      { kind: "text", text: "." },
    ]);
  });
});
