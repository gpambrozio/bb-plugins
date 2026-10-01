import { describe, expect, it } from "vitest";

import { decodeEntities, htmlToMarkdown } from "./html";
import { parseMarkdown } from "./markdown-parse";

describe("decodeEntities", () => {
  it("decodes named and numeric references", () => {
    expect(decodeEntities("&amp; &#65; &#x42; &copy;")).toBe("& A B ©");
  });

  it.each([
    "&#1114112;",
    "&#x110000;",
    "&#xFFFFFFFFFF;",
    "&#99999999999999999999;",
    "&#0;",
    "&#xD800;",
    "&#57343;",
  ])("turns the invalid reference %s into U+FFFD instead of throwing", (entity) => {
    expect(decodeEntities(entity)).toBe("�");
  });

  it("keeps a body with a bad reference renderable", () => {
    expect(() => parseMarkdown("<p>&#1114112;</p>")).not.toThrow();
    expect(() => htmlToMarkdown("<p>&#x110000; and <b>more</b></p>")).not.toThrow();
  });
});
