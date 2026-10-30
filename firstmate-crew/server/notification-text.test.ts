import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BODY_LIMIT, isNoOpReply, mateNotificationText, TITLE_LIMIT } from "./notification-text";

const noTitles = async () => null;

describe("isNoOpReply", () => {
  it("matches the charter's no-op reply, with any case, spacing, comma and closing punctuation", () => {
    for (const text of [
      "Captain, shipshape.",
      "  Captain, shipshape.\n",
      "captain, SHIPSHAPE",
      "Captain,   shipshape!",
      "Captain shipshape.",
      "Captain, shipshape...",
      "Captain,\nshipshape.",
    ]) {
      expect(isNoOpReply(text), text).toBe(true);
    }
  });

  it("does not match a reply that says anything more", () => {
    for (const text of [
      "Captain, shipshape. PR ready for review, captain: https://github.com/you/web/pull/42",
      "Captain, shipshape — one crewmate is still running.",
      "Shipshape.",
      "Captain, all shipshape.",
      "**Captain, shipshape.**",
      "Aye, captain, shipshape.",
      "",
    ]) {
      expect(isNoOpReply(text), text).toBe(false);
    }
  });

  it("matches the words the charter tells the first mate to use", async () => {
    const charter = await readFile(join(import.meta.dirname, "../templates/data/charter.md"), "utf8");
    const quoted = /Reply exactly `([^`]+)` for a true no-op/u.exec(charter)?.[1];
    expect(quoted).toBeDefined();
    expect(isNoOpReply(quoted as string)).toBe(true);
  });
});

describe("mateNotificationText", () => {
  it("is null for the no-op and for a reply with no words", async () => {
    expect(await mateNotificationText("Captain, shipshape.", noTitles)).toBeNull();
    expect(await mateNotificationText("\n\n---\n", noTitles)).toBeNull();
    expect(await mateNotificationText("```\ncode only\n```", noTitles)).toBeNull();
  });

  it("takes the first line with words as the title and joins the rest as the body", async () => {
    const text = "\n## Aye, captain\n\nPR ready for review, captain: https://github.com/you/web/pull/42\n- risk: low\n- CI green\n";
    expect(await mateNotificationText(text, noTitles)).toEqual({
      title: "Aye, captain",
      body: "PR ready for review, captain: https://github.com/you/web/pull/42 risk: low CI green",
    });
  });

  it("strips markdown and leaves code blocks, rules and tables out", async () => {
    const text = [
      "**Bearings**, captain — see [the PR](https://github.com/you/web/pull/7).",
      "```sh",
      "npm test",
      "```",
      "| a | b |",
      "***",
      "> Ran `npm test` and it is *green*.",
      "1. ~~Old~~ plan dropped",
    ].join("\n");
    expect(await mateNotificationText(text, noTitles)).toEqual({
      title: "Bearings, captain — see the PR.",
      body: "Ran npm test and it is green. Old plan dropped",
    });
  });

  it("names a mentioned thread by its title, and leaves a thread it cannot name as written", async () => {
    const titles: Record<string, string> = { thr_known1234: "fix the flaky login test" };
    const text = "Done: @thread:thr_known1234#msg=42 merged.\nStill waiting on @thread:thr_gone5678.";
    expect(await mateNotificationText(text, async (id) => titles[id] ?? null)).toEqual({
      title: "Done: “fix the flaky login test” merged.",
      body: "Still waiting on @thread:thr_gone5678.",
    });
  });

  it("names nothing when looking a thread up fails", async () => {
    const result = await mateNotificationText("See @thread:thr_abc.", () => Promise.reject(new Error("bb is down")));
    expect(result).toEqual({ title: "See @thread:thr_abc.", body: "" });
  });

  it("cuts the title and the body to bb's limits with an ellipsis", async () => {
    const result = await mateNotificationText(`${"t".repeat(100)}\n${"b".repeat(300)}`, noTitles);
    expect(result?.title).toHaveLength(TITLE_LIMIT);
    expect(result?.title.endsWith("…")).toBe(true);
    expect(result?.body).toHaveLength(BODY_LIMIT);
    expect(result?.body.endsWith("…")).toBe(true);
  });
});
