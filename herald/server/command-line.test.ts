import { describe, expect, it } from "vitest";

import { fillTemplate, splitCommandLine } from "./command-line";

describe("splitCommandLine", () => {
  it("splits on whitespace and keeps quoted words whole, including an empty one", () => {
    expect(splitCommandLine('claude -p --tools "" --model haiku')).toEqual(["claude", "-p", "--tools", "", "--model", "haiku"]);
    expect(splitCommandLine("gemini -p 'Reply with the sentence only.'")).toEqual(["gemini", "-p", "Reply with the sentence only."]);
  });

  it("joins quoted and bare pieces of one word, and honours a backslash", () => {
    expect(splitCommandLine('--name="a b"c')).toEqual(["--name=a bc"]);
    expect(splitCommandLine("say\\ it \\\"x\\\"")).toEqual(["say it", '"x"']);
  });

  it("treats newlines as spaces, so a multi-line field is one command", () => {
    expect(splitCommandLine("codex exec\n  --ephemeral\n  -\n")).toEqual(["codex", "exec", "--ephemeral", "-"]);
  });

  it("refuses an unterminated quote and an empty line", () => {
    expect(() => splitCommandLine('claude -p "oops')).toThrow(/quote/);
    expect(() => splitCommandLine("   ")).toThrow(/empty/);
  });
});

describe("fillTemplate", () => {
  it("replaces every placeholder, in any case, and says none for what is missing", () => {
    expect(fillTemplate("{{thread}} / {{Thread}} / {{detail}} / {{unknown}}", { thread: "Login fix", detail: null })).toBe(
      "Login fix / Login fix / none / {{unknown}}",
    );
  });

  it("does not expand placeholders found inside a value", () => {
    expect(fillTemplate("{{output}} {{thread}}", { output: "{{thread}}", thread: "x" })).toBe("{{thread}} x");
  });
});
