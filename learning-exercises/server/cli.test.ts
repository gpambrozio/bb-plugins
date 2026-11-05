import { describe, expect, it } from "vitest";

import { decodeForm, decodeQuestion, FORM_MAX_BYTES, QUESTION_MAX_BYTES } from "./cli";

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

describe("decodeForm", () => {
  it("decodes base64 JSON, leaving its checks to the session", () => {
    expect(decodeForm(b64('{"items": [{"kind": "yes-no", "id": "a", "label": "A?"}]}\n'))).toEqual({ items: [{ kind: "yes-no", id: "a", label: "A?" }] });
    expect(decodeForm(b64('{"items": "not a form"}'))).toEqual({ items: "not a form" });
  });

  it("refuses what is not base64, too long, or not JSON", () => {
    expect(() => decodeForm("{not base64}")).toThrow("--form-base64 is not valid base64");
    expect(() => decodeForm(b64("x".repeat(FORM_MAX_BYTES + 1)))).toThrow("answer form is longer than");
    expect(() => decodeForm(b64("{items: []}"))).toThrow("--form-base64 is not JSON");
  });
});
