import { describe, expect, it } from "vitest";

import { decodeQuestion, QUESTION_MAX_BYTES } from "./cli";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("decodeQuestion", () => {
  it("decodes UTF-8 and drops one heredoc newline", () => {
    expect(decodeQuestion(b64("What does `x` do? “quotes” and 'single'\n"))).toBe("What does `x` do? “quotes” and 'single'");
    expect(decodeQuestion(b64("Two lines\nhere\n\n"))).toBe("Two lines\nhere\n");
  });

  it("refuses what is not base64, empty, too long, or not UTF-8", () => {
    expect(() => decodeQuestion("not base64!")).toThrow("not valid base64");
    expect(() => decodeQuestion("")).toThrow("not valid base64");
    expect(() => decodeQuestion(b64("x".repeat(QUESTION_MAX_BYTES + 1)))).toThrow("longer than");
    expect(() => decodeQuestion(Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"))).toThrow("UTF-8");
  });
});
