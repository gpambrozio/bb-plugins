import { describe, expect, test } from "vitest";

import { withoutImages } from "./markdown";

describe("withoutImages", () => {
  test("turns an inline image into a link to the same source", () => {
    expect(withoutImages("See ![the diagram](https://example.com/a.png) here.")).toBe(
      "See [the diagram](https://example.com/a.png) here.",
    );
  });

  test("turns a reference image into a reference link", () => {
    expect(withoutImages("![pixel][p]\n\n[p]: https://example.com/p.gif")).toBe(
      "[pixel][p]\n\n[p]: https://example.com/p.gif",
    );
  });

  test("handles an image with no alt text and several on one line", () => {
    expect(withoutImages("![](a.png) and ![b](b.png)")).toBe("[](a.png) and [b](b.png)");
  });

  test("leaves links, and an exclamation mark that starts no image, alone", () => {
    const text = "Run it! [docs](https://example.com) and !important";
    expect(withoutImages(text)).toBe(text);
  });

  test("leaves fenced code as written, with either fence", () => {
    const text = [
      "```md",
      "![kept](a.png)",
      "```",
      "![changed](b.png)",
      "~~~",
      "![kept](c.png)",
      "```",
      "![still kept](d.png)",
      "~~~",
    ].join("\n");
    expect(withoutImages(text).split("\n")).toEqual([
      "```md",
      "![kept](a.png)",
      "```",
      "[changed](b.png)",
      "~~~",
      "![kept](c.png)",
      "```",
      "![still kept](d.png)",
      "~~~",
    ]);
  });
});
