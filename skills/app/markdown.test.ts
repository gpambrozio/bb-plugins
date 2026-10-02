import type { Nodes } from "mdast";
import { describe, expect, test } from "vitest";

import { parseBody, withoutImages } from "./markdown";

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
  "raw html block": '<img src="https://example.com/p.gif">',
  "inline raw html": 'text <img src="https://example.com/p.gif"> text',
  "html with nested tags": '<div><picture><source srcset="https://example.com/x.webp"></picture></div>',
};

describe("withoutImages", () => {
  test.each(Object.entries(CASES))("leaves nothing that loads: %s", (_name, markdown) => {
    expect(loaders(markdown).length).toBeGreaterThan(0);
    expect(loaders(withoutImages(markdown))).toEqual([]);
  });

  test("turns an image into a link to the same source", () => {
    expect(withoutImages("See ![the diagram](https://example.com/a.png) here.")).toBe(
      "See [the diagram](https://example.com/a.png) here.",
    );
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
