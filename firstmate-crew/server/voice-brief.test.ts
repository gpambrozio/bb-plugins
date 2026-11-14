import { describe, expect, it } from "vitest";

import { VoiceBriefSchema, VoiceCardSchema } from "../shared/voice";
import { voiceFleet } from "./testing/voice-fixtures";
import {
  VoiceRefs,
  buildVoiceBrief,
  headAndTail,
  readBack,
  resolveButton,
  speakable,
  spokenPr,
  tapOnlyReason,
  voiceCard,
  type MateVoiceState,
} from "./voice-brief";

const MATE: MateVoiceState = {
  status: "idle",
  waiting: false,
  reply: "PR ready for review, captain: https://github.com/you/web/pull/42 (fix the flaky login test - risk: low - CI green)",
  repliedAt: Date.UTC(2026, 10, 13, 14, 1),
};

describe("speakable", () => {
  it("says a pull request as its repository and number", () => {
    expect(spokenPr("https://github.com/you/web/pull/42")).toBe("web #42");
    expect(spokenPr("https://github.com/you/web/pull/42/files")).toBe("web #42");
    expect(spokenPr("https://example.com/x")).toBeNull();
    expect(speakable("see https://github.com/you/web/pull/42.")).toBe("see web #42.");
  });

  it("names other links by their site and never reads a URL out", () => {
    expect(speakable("logs at https://www.example.com/a/b?c=d and [the doc](https://docs.example.org/x)")).toBe(
      "logs at a link on example.com and the doc",
    );
  });

  it("turns thread mentions into titles and drops bare thread ids", () => {
    const titles = new Map([["thr_dark", "Add dark mode"]]);
    expect(speakable("done in @thread:thr_dark#msg=12 and @thread:thr_other", titles)).toBe(
      `done in "Add dark mode" and a worker's thread`,
    );
    expect(speakable("thread thr_abc123 finished")).toBe("thread a thread finished");
  });

  it("drops Markdown marks, code blocks and line breaks", () => {
    expect(speakable("## Done\n\n**Merged** `web`\n```\nnpm test\n```\n> quoted")).toBe("Done Merged web (code left out) quoted");
  });
});

describe("headAndTail", () => {
  it("keeps short text whole and marks it untrusted", () => {
    expect(headAndTail("all good", 10, 10)).toEqual({ untrusted: true, head: "all good", tail: "", chars: 8 });
  });

  it("keeps the start and the end of long text, so a closing status line survives", () => {
    const text = `${"word ".repeat(200)}done: PR web #42 checks green`;
    const cut = headAndTail(text, 60, 40);
    expect(cut.head.length).toBeLessThanOrEqual(62);
    expect(cut.tail).toContain("done: PR web #42 checks green");
    expect(cut.chars).toBe(text.length);
  });

  it("gives no tail when none is asked for", () => {
    expect(headAndTail("a b c d e f g h i j", 6, 0).tail).toBe("");
  });
});

describe("tapOnlyReason", () => {
  it.each([
    ["Merge", "Merge https://github.com/you/web/pull/42", "a merge"],
    ["Land web#42", "Land https://github.com/you/web/pull/42", "a merge"],
    ["Ship it", "Ship it", "a merge"],
    ["Discard", "Throw away the branch", "destructive or irreversible"],
    ["Clean up", "Archive the worker and delete its branch", "destructive or irreversible"],
    ["Release", "Cut release 1.2.0", "publishing"],
    ["Rotate", "Rotate the API key", "credentials"],
    ["Yolo", "Turn on yolo for web", "settings"],
    ["Approve", "Approve the worker's permission", "settings"],
  ])("keeps %s on the board (%s)", (label, prompt, reason) => {
    expect(tapOnlyReason(label, prompt)).toBe(reason);
  });

  it.each([
    ["Hold", "Leave https://github.com/you/web/pull/42 open until I say"],
    ["Postgres", "Use Postgres for the web project's database (pick-db)"],
    ["Review loop on web#42", "Run a review loop on https://github.com/you/web/pull/42"],
    ["Retry", "Retry the flaky test once more"],
  ])("lets the voice press %s after a yes", (label, prompt) => {
    expect(tapOnlyReason(label, prompt)).toBeNull();
  });
});

describe("VoiceRefs", () => {
  it("keeps a card's ref when it moves to another column", () => {
    const refs = new VoiceRefs();
    const fleet = voiceFleet();
    const first = buildVoiceBrief(fleet, MATE, refs, 0);
    const moved = voiceFleet({ cards: fleet.cards.map((card) => (card.taskId === "dark-mode" ? { ...card, column: "blocked" as const } : card)) });
    const second = buildVoiceBrief(moved, MATE, refs, 0);
    expect(first.working[0]?.ref).toBe("c2");
    expect(second.blocked[0]?.ref).toBe("c2");
    expect(second.working).toEqual([]);
  });
});

describe("buildVoiceBrief", () => {
  it("files the board for the voice with refs, labels and no ids, URLs or prompts", () => {
    const brief = buildVoiceBrief(voiceFleet(), MATE, new VoiceRefs(), Date.UTC(2026, 10, 13, 14, 2));
    expect(VoiceBriefSchema.parse(brief)).toEqual(brief);
    expect(brief.firstMate).toMatchObject({ status: "idle", waiting: false, repliedAt: "2026-11-13T14:01:00.000Z" });
    expect(brief.firstMate?.lastReply?.head).toBe("PR ready for review, captain: web #42 (fix the flaky login test - risk: low - CI green)");
    expect(brief.captainsCall).toEqual([
      expect.objectContaining({
        ref: "c1",
        title: "Fix the flaky login test",
        pr: "web #42",
        hold: "merge web#42?",
        actions: [
          { ref: "c1.a1", label: "Merge", tapOnly: "a merge" },
          { ref: "c1.a2", label: "Hold", tapOnly: null },
        ],
      }),
    ]);
    expect(brief.working.map((card) => card.title)).toEqual(["Add dark mode"]);
    expect(brief.queued.map((card) => [card.title, card.blockedBy])).toEqual([["Upgrade the date library", "dark-mode"]]);
    expect(brief.landed).toEqual([{ title: "Fix the typo", outcome: "merged 2026-11-12" }]);
    expect(brief.suggestions).toEqual([
      { ref: "s1", label: "Review loop on web#42", tapOnly: null },
      { ref: "s2", label: "Land web#42", tapOnly: "a merge" },
    ]);
    const text = JSON.stringify(brief);
    expect(text).not.toMatch(/https?:|thr_|Run a review loop|Leave https/u);
  });

  it("changes its etag when the board changes, and only then", () => {
    const refs = new VoiceRefs();
    const a = buildVoiceBrief(voiceFleet(), MATE, refs, 1);
    const b = buildVoiceBrief(voiceFleet(), MATE, refs, 2);
    const c = buildVoiceBrief(voiceFleet({ suggestions: [] }), MATE, refs, 3);
    expect(a.etag).toBe(b.etag);
    expect(c.etag).not.toBe(a.etag);
  });

  it("works with no first mate aboard", () => {
    expect(buildVoiceBrief(voiceFleet({ mate: null }), null, new VoiceRefs(), 0).firstMate).toBeNull();
  });
});

describe("voiceCard", () => {
  it("reads a card back from the board with the pull request in words", () => {
    const refs = new VoiceRefs();
    const fleet = voiceFleet();
    buildVoiceBrief(fleet, MATE, refs, 0);
    const card = voiceCard(fleet, refs, "c1");
    expect(VoiceCardSchema.parse(card)).toEqual(card);
    expect(card?.pressable.map((item) => item.readBack)).toEqual([
      'Press "Merge" on Fix the flaky login test, web pull request 42?',
      'Press "Hold" on Fix the flaky login test, web pull request 42?',
    ]);
    expect(readBack("Review loop on web#42", null)).toBe('Press the suggestion "Review loop on web#42"?');
  });

  it("changes the etag when a button's prompt is rewritten under the same label", () => {
    const refs = new VoiceRefs();
    const fleet = voiceFleet();
    const before = voiceCard(fleet, refs, "c1");
    const call = fleet.cards[0]!;
    const rewritten = voiceFleet({
      cards: [{ ...call, backlog: { ...call.backlog!, actions: [{ label: "Merge", prompt: "Merge something else" }, call.backlog!.actions[1]!] } }, ...fleet.cards.slice(1)],
    });
    expect(voiceCard(rewritten, refs, "c1")?.etag).not.toBe(before?.etag);
  });

  it("answers null for a ref the board does not have", () => {
    const refs = new VoiceRefs();
    expect(voiceCard(voiceFleet(), refs, "c99")).toBeNull();
    expect(voiceCard(voiceFleet(), refs, "nonsense")).toBeNull();
  });
});

describe("resolveButton", () => {
  it("finds a card's action and a suggestion with the prompt their buttons send", () => {
    const refs = new VoiceRefs();
    const fleet = voiceFleet();
    buildVoiceBrief(fleet, MATE, refs, 0);
    expect(resolveButton(fleet, refs, "c1.a2")?.prompt).toBe("Leave https://github.com/you/web/pull/42 open until I say");
    expect(resolveButton(fleet, refs, "s1")?.prompt).toBe("Run a review loop on https://github.com/you/web/pull/42");
    expect(resolveButton(fleet, refs, "c1.a3")).toBeNull();
    expect(resolveButton(fleet, refs, "c1")).toBeNull();
  });
});
