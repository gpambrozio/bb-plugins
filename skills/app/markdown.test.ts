import type { Nodes } from "mdast";
import { describe, expect, test } from "vitest";

import { MAX_BRACKET_DEPTH, MAX_PARSED_LENGTH, parseBody, withoutImages } from "./markdown";

/** Every node bb's renderer would draw as something that loads: images, image references, raw HTML. */
function loaders(markdown: string): string[] {
  const found: string[] = [];
  function walk(node: Nodes): void {
    if (node.type === "image" || node.type === "imageReference" || node.type === "html") found.push(node.type);
    if ("children" in node) for (const child of node.children) walk(child);
  }
  walk(parseBody(markdown));
  return found;
}

// Each of these parses, the way bb's renderer parses it, into at least one
// node that loads something. After `withoutImages`, none may be left.
const CASES: Record<string, string> = {
  inline: "See ![the diagram](https://example.com/a.png) here.",
  "inline with a title": '![pixel](https://example.com/p.gif "t")',
  "full reference": "![pixel][p]\n\n[p]: https://example.com/p.gif",
  "collapsed reference": "![pixel][]\n\n[pixel]: https://example.com/p.gif",
  "shortcut reference": "![pixel]\n\n[pixel]: https://example.com/p.gif",
  "nested alt text": "![outer ![inner](https://example.com/in.png)](https://example.com/out.png)",
  "multiline alt text": "![a pixel\nthat spans lines](https://example.com/p.gif)",
  "angle-bracket destination": "![x](<https://example.com/a b.png>)",
  "inside a link": "[![badge](https://example.com/b.svg)](https://example.com)",
  "in a table": "| a | b |\n| - | - |\n| ![x](https://example.com/t.png) | y |",
  "in a list and a quote": "- ![x](https://example.com/l.png)\n\n> ![y](https://example.com/q.png)",
  "after a longer fence closed by a longer fence": "````\n```\n````\n![x](https://example.com/f.png)",
  "after a tilde fence": "~~~\n![kept](a.png)\n~~~\n![x](https://example.com/f.png)",
  "preceded by a literal !": "!![x](https://example.com/a.png)",
  "preceded by an escaped !": "\\!![x](https://example.com/a.png)",
  "side by side": "![a](https://example.com/a.png)![b](https://example.com/b.png)",
  "deeply nested": "![".repeat(64) + "x" + "](https://example.com/n.png)".repeat(64),
  "raw html block": '<img src="https://example.com/p.gif">',
  "inline raw html": 'text <img src="https://example.com/p.gif"> text',
  "html with nested tags": '<div><picture><source srcset="https://example.com/x.webp"></picture></div>',
};

describe("withoutImages", () => {
  test.each(Object.entries(CASES))("leaves nothing that loads: %s", (_name, markdown) => {
    expect(loaders(markdown).length).toBeGreaterThan(0);
    expect(loaders(withoutImages(markdown))).toEqual([]);
  });

  test("turns an image into its alt text and its source, as text", () => {
    expect(withoutImages("See ![the diagram](https://example.com/a.png) here.")).toBe(
      "See the diagram (https://example.com/a.png) here.",
    );
  });

  test("takes a reference image's source from its definition", () => {
    expect(withoutImages("![pixel][p]\n\n[p]: https://example.com/p.gif")).toBe(
      "pixel (https://example.com/p.gif)\n\n[p]: https://example.com/p.gif",
    );
  });

  test("escapes alt text that would otherwise be read as syntax", () => {
    expect(withoutImages("![a *b* [c]](https://example.com/a.png)")).toBe(
      "a b \\[c\\] (https://example.com/a.png)",
    );
    expect(withoutImages("![x](<https://example.com/a(1).png>)")).toBe("x (https://example.com/a\\(1\\).png)");
  });

  // Review pass 2: re-parsing until nothing was left made each nesting level
  // cost a whole parse — 1.5 KB of nested images took seconds, synchronously,
  // as the detail opened. One parse and one walk must stay fast at any depth.
  test("still parses images nested as deep as the limit", () => {
    const markdown = "![".repeat(MAX_BRACKET_DEPTH) + "x" + "](x)".repeat(MAX_BRACKET_DEPTH);
    const result = withoutImages(markdown);
    expect(result.startsWith("```")).toBe(false);
    expect(loaders(result)).toEqual([]);
  });

  test("shows a body nested deeper than the limit, or larger than it, as a code block", () => {
    const deep = "![".repeat(MAX_BRACKET_DEPTH + 1) + "x" + "](x)".repeat(MAX_BRACKET_DEPTH + 1);
    expect(withoutImages(deep)).toBe("```\n" + deep + "\n```");
    const large = "![x](https://example.com/a.png) ``` ".repeat(MAX_PARSED_LENGTH / 32);
    const shown = withoutImages(large);
    expect(shown.startsWith("````\n")).toBe(true);
    expect(loaders(shown)).toEqual([]);
  });

  test.each([256, 1024, 4096])("stays fast on %i nested images", (depth) => {
    const markdown = "![".repeat(depth) + "x" + "](x)".repeat(depth);
    const started = performance.now();
    const result = withoutImages(markdown);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(loaders(result)).toEqual([]);
  });

  test("shows raw HTML as text", () => {
    expect(withoutImages('<img src="https://example.com/p.gif">')).toBe('&lt;img src="https://example.com/p.gif">');
  });

  test("leaves code, links and a plain exclamation mark as written", () => {
    const text = [
      "Run it! [docs](https://example.com) and !important",
      "",
      "```md",
      "![kept](a.png) <img src=b.png>",
      "```",
      "",
      "Inline `![kept](c.png)` code.",
    ].join("\n");
    expect(withoutImages(text)).toBe(text);
  });
});
