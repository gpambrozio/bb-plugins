import { describe, expect, it } from "vitest";

import type { ComposerMention } from "@get-bb/plugin-sdk/app";

import {
  canBePill,
  chatText,
  discoveredCommand,
  reportedCommand,
  type SkillCommand,
  withCommand,
  withSkillCommand,
  writesToThread,
} from "./insert";

const deploy: SkillCommand = { name: "deploy", source: "skill", origin: "user", argumentHint: null };

function pill(command: SkillCommand, from = 0): ComposerMention {
  return { kind: "command", trigger: "/", label: command.name, from, to: from + command.name.length + 1, ...command };
}

const fileMention = (from: number): ComposerMention => ({
  kind: "path",
  path: "src/auth.ts",
  source: "workspace",
  entryKind: "file",
  label: "auth.ts",
  from,
  to: from + 8,
});

describe("withSkillCommand", () => {
  it("fills an empty or blank draft with the pill and a space", () => {
    expect(withSkillCommand({ text: "", mentions: [] }, deploy)).toEqual({ text: "/deploy ", mentions: [pill(deploy)] });
    expect(withSkillCommand({ text: " \n", mentions: [] }, deploy)).toEqual({ text: "/deploy ", mentions: [pill(deploy)] });
  });

  it("puts the pill first, keeps what was typed after it and moves the other pills with their text", () => {
    const after = withSkillCommand({ text: "  look at @auth.ts", mentions: [fileMention(10)] }, deploy);
    expect(after.text).toBe("/deploy look at @auth.ts");
    expect(after.mentions).toEqual([pill(deploy), fileMention(16)]);
    expect(after.text.slice(16, 24)).toBe("@auth.ts");
  });

  it("replaces a command pill at the start rather than adding a second one", () => {
    const explain: SkillCommand = { name: "explain", source: "skill", origin: "builtin", argumentHint: "[file]" };
    const after = withSkillCommand(
      { text: "/explain  @auth.ts please", mentions: [pill(explain), fileMention(10)] },
      deploy,
    );
    expect(after.text).toBe("/deploy @auth.ts please");
    expect(after.mentions).toEqual([pill(deploy), fileMention(8)]);
  });

  it("replaces a leading pill that text follows directly, and a longer one with a shorter", () => {
    const outline: SkillCommand = { name: "outline", source: "skill", origin: "project", argumentHint: null };
    const go: SkillCommand = { ...deploy, name: "go" };
    const glued = withSkillCommand({ text: "/outline@auth.ts", mentions: [pill(outline), fileMention(8)] }, deploy);
    expect(glued.text).toBe("/deploy @auth.ts");
    expect(glued.mentions).toEqual([pill(deploy), fileMention(8)]);
    const shorter = withSkillCommand({ text: "/outline then @auth.ts", mentions: [pill(outline), fileMention(14)] }, go);
    expect(shorter.text).toBe("/go then @auth.ts");
    expect(shorter.mentions).toEqual([pill(go), fileMention(9)]);
    expect(shorter.text.slice(9, 17)).toBe("@auth.ts");
  });

  it("keeps a command pill that is not at the start", () => {
    const explain: SkillCommand = { name: "explain", source: "command", origin: "builtin", argumentHint: null };
    const after = withSkillCommand({ text: "then /explain", mentions: [pill(explain, 5)] }, deploy);
    expect(after.text).toBe("/deploy then /explain");
    expect(after.mentions).toEqual([pill(deploy), pill(explain, 13)]);
  });

  it("carries the command's source, origin and argument hint into the pill", () => {
    const clear: SkillCommand = { name: "clear", source: "command", origin: "builtin", argumentHint: "[scope]" };
    expect(withSkillCommand({ text: "", mentions: [] }, clear).mentions).toEqual([pill(clear)]);
  });

  it("falls back to text for a name that cannot be a pill", () => {
    const spaced: SkillCommand = { ...deploy, name: "two words" };
    expect(withSkillCommand({ text: "look at @auth.ts", mentions: [fileMention(8)] }, spaced)).toEqual({
      text: "/two words look at @auth.ts",
      mentions: [fileMention(19)],
    });
  });
});

describe("canBePill", () => {
  it("takes a single token, plugin namespaces included", () => {
    expect(canBePill("deploy")).toBe(true);
    expect(canBePill("toolkit:outline")).toBe(true);
  });

  it("refuses an empty name and whitespace", () => {
    expect(canBePill("")).toBe(false);
    expect(canBePill("two words")).toBe(false);
    expect(canBePill("tab\there")).toBe(false);
  });
});

describe("discoveredCommand", () => {
  it("is a skill, from the project when the workspace holds it and from the user otherwise", () => {
    expect(discoveredCommand("a", "project").origin).toBe("project");
    expect(discoveredCommand("a", "repo").origin).toBe("project");
    for (const kind of ["personal", "admin", "plugin", "bb"] as const) expect(discoveredCommand("a", kind).origin).toBe("user");
    expect(discoveredCommand("a", undefined)).toEqual({ name: "a", source: "skill", origin: "user", argumentHint: null });
  });
});

describe("reportedCommand", () => {
  it("keeps the provider's origin and reads an empty argument hint as none", () => {
    expect(reportedCommand({ name: "explain", argumentHint: "[file]", origin: "builtin" }, "skill")).toEqual({
      name: "explain",
      source: "skill",
      origin: "builtin",
      argumentHint: "[file]",
    });
    expect(reportedCommand({ name: "clear", argumentHint: "", origin: "project" }, "command").argumentHint).toBeNull();
  });
});

describe("chatText", () => {
  it("is the command and a trailing space", () => {
    expect(chatText("diff-check")).toBe("/diff-check ");
    expect(chatText("toolkit:outline")).toBe("/toolkit:outline ");
  });
});

describe("withCommand", () => {
  const draft = (text: string, mentions: { from: number; to: number; label: string }[] = []) => ({ text, mentions });

  it("fills an empty or blank draft with the command", () => {
    expect(withCommand(draft(""), "/diff-check ")).toEqual(draft("/diff-check "));
    expect(withCommand(draft("  \n"), "/diff-check ")).toEqual(draft("/diff-check "));
  });

  it("puts the command first and keeps what was typed after it", () => {
    expect(withCommand(draft("  look at auth.ts\nplease"), "/diff-check ")).toEqual(
      draft("/diff-check look at auth.ts\nplease"),
    );
  });

  it("moves each mention with the text it sits in", () => {
    const before = draft("  see @auth.ts and @api.ts", [
      { from: 6, to: 14, label: "auth.ts" },
      { from: 19, to: 26, label: "api.ts" },
    ]);
    const after = withCommand(before, "/diff-check ");
    expect(after.text).toBe("/diff-check see @auth.ts and @api.ts");
    expect(after.mentions).toEqual([
      { from: 16, to: 24, label: "auth.ts" },
      { from: 29, to: 36, label: "api.ts" },
    ]);
    for (const mention of after.mentions) {
      expect(after.text.slice(mention.from, mention.to)).toBe(`@${mention.label}`);
    }
  });
});

describe("writesToThread", () => {
  it("accepts the thread's own draft and its queued messages", () => {
    expect(writesToThread({ kind: "thread", threadId: "thr_a" }, "thr_a")).toBe(true);
    expect(writesToThread({ kind: "queued-message", threadId: "thr_a" }, "thr_a")).toBe(true);
  });

  it("refuses another thread, a side chat and the new-thread composer", () => {
    expect(writesToThread({ kind: "thread", threadId: "thr_b" }, "thr_a")).toBe(false);
    expect(writesToThread({ kind: "side-chat" }, "thr_a")).toBe(false);
    expect(writesToThread({ kind: "new-thread" }, "thr_a")).toBe(false);
  });
});
