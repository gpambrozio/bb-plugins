import type { Nodes } from "mdast";
import { describe, expect, test } from "vitest";

import {
  MAX_EMPHASIS_DELIMITERS,
  MAX_LINE_CONTAINERS,
  MAX_OPEN_BRACKETS,
  MAX_PARSED_LENGTH,
  parseBody,
  withoutImages,
} from "./markdown";

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

function isCodeBlock(markdown: string): boolean {
  const tree = parseBody(markdown);
  return "children" in tree && tree.children.length === 1 && tree.children[0]!.type === "code";
}

// Each of these parses, the way bb's renderer parses it, into at least one
// node that loads something. After `withoutImages`, re-parsing the output
// must find none.
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
  // Review pass 3: an empty image's replacement must not join its neighbours.
  "empty image between a ! and a link": "!![]()[pixel](https://example.com/p.gif)",
  "empty images in a row": "![]()![]()![x](https://example.com/p.gif)",
  "raw html block": '<img src="https://example.com/p.gif">',
  "inline raw html": 'text <img src="https://example.com/p.gif"> text',
  "html with nested tags": '<div><picture><source srcset="https://example.com/x.webp"></picture></div>',
  // Review pass 3: escaping only `<` exposed what an HTML node hid.
  "image inside an html comment": "<!-- ![pixel](https://example.com/p.gif) -->",
  "image inside a multi-line html comment": "<!--\n\n![pixel](https://example.com/p.gif)\n\n-->",
  "markdown inside an html block": '<div>\n![pixel](https://example.com/p.gif)\n<img src="https://example.com/q.gif">\n</div>',
  "html in a blockquote and a list": '> <img src="https://example.com/a.gif">\n> ![x](https://example.com/b.gif)\n\n- <img src=c.gif>',
  "html in a table cell": '| a |\n| - |\n| <img src="https://example.com/t.gif"> |',
  "processing instruction and cdata": "<?php ![x](https://example.com/p.gif) ?>\n\n<![CDATA[ ![y](https://example.com/q.gif) ]]>",
};

describe("withoutImages", () => {
  test.each(Object.entries(CASES))("leaves nothing that loads: %s", (_name, markdown) => {
    expect(loaders(markdown).length).toBeGreaterThan(0);
    const result = withoutImages(markdown);
    expect(loaders(result)).toEqual([]);
    expect(isCodeBlock(result)).toBe(false);
  });

  test("shows an image as its alt text and source, as bracketed literal text", () => {
    expect(withoutImages("See ![the diagram](https://example.com/a.png) here.")).toBe(
      "See \\[the diagram \\(https\\:\\/\\/example\\.com\\/a\\.png\\)\\] here.",
    );
  });

  test("never replaces an image with nothing", () => {
    expect(withoutImages("a ![]() b")).toBe("a \\[\\] b");
  });

  test("takes a reference image's source from its definition", () => {
    expect(
      withoutImages("![pixel][p]\n\n[p]: https://example.com/p.gif").startsWith(
        "\\[pixel \\(https\\:\\/\\/example\\.com\\/p\\.gif\\)\\]",
      ),
    ).toBe(true);
  });

  test("shows raw HTML, comments included, as literal text on one line", () => {
    expect(withoutImages("<!--\n![x](y)\n-->")).toBe("\\<\\!\\-\\- \\!\\[x\\]\\(y\\) \\-\\-\\>");
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

describe("budgets", () => {
  test("parses a body at every limit", () => {
    const atLimits = [
      "[x] ".repeat(MAX_OPEN_BRACKETS),
      "_".repeat(MAX_EMPHASIS_DELIMITERS),
      "> ".repeat(MAX_LINE_CONTAINERS) + "x",
      "- ".repeat(MAX_LINE_CONTAINERS) + "x",
      "a".repeat(MAX_PARSED_LENGTH),
    ];
    for (const markdown of atLimits) expect(isCodeBlock(withoutImages(markdown))).toBe(false);
  });

  test("shows a body past any limit as one code block, unparsed", () => {
    const pastLimits = [
      "[x] ".repeat(MAX_OPEN_BRACKETS + 1),
      "_".repeat(MAX_EMPHASIS_DELIMITERS + 1),
      "> ".repeat(MAX_LINE_CONTAINERS + 1) + "x",
      "1. ".repeat(MAX_LINE_CONTAINERS + 1) + "x",
      "a".repeat(MAX_PARSED_LENGTH + 1),
    ];
    for (const markdown of pastLimits) {
      const result = withoutImages(markdown);
      expect(isCodeBlock(result)).toBe(true);
      expect(result).toContain(markdown);
    }
  });

  test("fences the code block longer than any backtick run inside it", () => {
    const markdown = "````` ![x](https://example.com/a.png) " + "[".repeat(MAX_OPEN_BRACKETS + 1);
    const result = withoutImages(markdown);
    expect(result.startsWith("``````\n")).toBe(true);
    expect(isCodeBlock(result)).toBe(true);
    expect(loaders(result)).toEqual([]);
  });

  // Review pass 3, finding 6: a throw anywhere in the parse or the walk shows
  // the body as text instead of crashing the surface.
  test("shows the body as a code block when parsing throws", () => {
    const result = withoutImages("![x](https://example.com/a.png)", () => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    expect(result).toBe("```\n![x](https://example.com/a.png)\n```");
  });
});

// Each payload must come back — and parse again as bb's renderer will parse
// it — well within a second. The bound is generous; the point is "not seconds".
describe("speed on hostile bodies", () => {
  const PAYLOADS: Record<string, string> = {
    "nested images, depth 256 (review 2)": "![".repeat(256) + "x" + "](x)".repeat(256),
    "nested images, depth 4096": "![".repeat(4096) + "x" + "](x)".repeat(4096),
    "nested images behind code spans (review 3)": "![`]` ".repeat(4096) + "x" + "](x)".repeat(4096),
    "deep blockquotes (review 3)": "> ".repeat(8192) + "x",
    "deep one-line lists": "1. ".repeat(8192) + "x",
    "mixed emphasis delimiters": "*_".repeat(8000),
    "unmatched emphasis": "*a_".repeat(4000),
    "nested links": "[".repeat(4096) + "x" + "](x)".repeat(4096),
    "autolinks at the size limit": "<http://a ".repeat(MAX_PARSED_LENGTH / 10),
    "hard breaks at the size limit": "a\\\n".repeat(MAX_PARSED_LENGTH / 3),
    "a large body": "word ".repeat(200_000),
  };

  test.each(Object.entries(PAYLOADS))("%s", (_name, markdown) => {
    const started = performance.now();
    const result = withoutImages(markdown);
    parseBody(result);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(loaders(result)).toEqual([]);
  });
});
