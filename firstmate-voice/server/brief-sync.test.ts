import { describe, expect, it } from "vitest";

import { BRIEF_LABEL, BriefSync, FULL_AFTER_UPDATES, UPDATE_LABEL, diffBriefs } from "./brief-sync";
import { brief } from "./testing/fakes";

const call = brief().captainsCall[0]!;

describe("diffBriefs", () => {
  it("lists column moves, new cards, landings and suggestions", () => {
    const before = brief({ working: [{ ...call, ref: "c3", title: "Add dark mode", column: "working", hold: null, actions: [] }] });
    const after = brief({
      etag: "e2",
      blocked: [{ ...call, ref: "c3", title: "Add dark mode", column: "blocked", hold: null, actions: [] }],
      queued: [{ ...call, ref: "c4", title: "Upgrade the date library", column: "queued", hold: null, actions: [] }],
      landed: [{ title: "Fix the typo", outcome: "merged 2026-11-12" }],
      suggestions: [],
    });
    const { lines, events } = diffBriefs(before, after);
    expect(lines).toEqual(
      expect.arrayContaining([
        'c3 "Add dark mode": working → blocked.',
        'New on the board: c4 "Upgrade the date library" (queued).',
        'Landed: "Fix the typo" (merged 2026-11-12).',
        "Suggestions now: none.",
      ]),
    );
    expect(events).toEqual([]);
  });

  it("raises a new or changed captain's call, a failure, the first mate waiting and its reply", () => {
    const after = brief({
      etag: "e2",
      captainsCall: [{ ...call, hold: "merge web#42 now?" }],
      failed: [{ ...call, ref: "c7", title: "Upgrade the date library", column: "failed", hold: null, actions: [] }],
      firstMate: { status: "idle", waiting: true, lastReply: { untrusted: true, head: "Captain, ready.", tail: "", chars: 15 }, repliedAt: "2026-11-13T14:06:00.000Z" },
    });
    expect(diffBriefs(brief(), after).events).toEqual([
      { kind: "call", ref: "c1", title: "Fix the flaky login test", hold: "merge web#42 now?" },
      { kind: "failed", ref: "c7", title: "Upgrade the date library" },
      { kind: "mate-waiting" },
      { kind: "mate-replied", repliedAt: "2026-11-13T14:06:00.000Z" },
    ]);
  });

  it("finds nothing between equal briefs", () => {
    expect(diffBriefs(brief(), brief())).toEqual({ lines: [], events: [] });
  });
});

describe("BriefSync", () => {
  it("seeds the brief, adds an update per change, and replaces both after enough updates", () => {
    const added: { id: string; text: string }[] = [];
    const removed: string[] = [];
    const sync = new BriefSync({ add: (id, text) => added.push({ id, text }), remove: (id) => removed.push(id) }, () => 0);
    sync.seed(brief());
    expect(added[0]?.text.startsWith(BRIEF_LABEL)).toBe(true);
    expect(sync.apply(brief())).toEqual([]);
    expect(added).toHaveLength(1);
    for (let i = 1; i < FULL_AFTER_UPDATES; i += 1) sync.apply(brief({ etag: `e${i + 1}`, suggestions: i % 2 === 1 ? [] : brief().suggestions }));
    expect(added.filter((item) => item.text.startsWith(UPDATE_LABEL))).toHaveLength(FULL_AFTER_UPDATES - 1);
    sync.apply(brief({ etag: "final", landed: [{ title: "Fix the typo", outcome: null }] }));
    expect(removed).toHaveLength(FULL_AFTER_UPDATES);
    expect(added.at(-2)?.text.startsWith(BRIEF_LABEL)).toBe(true);
  });
});
