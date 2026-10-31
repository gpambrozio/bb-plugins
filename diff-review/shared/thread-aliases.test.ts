import { describe, expect, it } from "vitest";

import { mergeReplyDrafts, remapThreadKeys } from "./thread-aliases";
import { BODY_MAX_CHARS } from "./types";

const draft = (body: string) => ({ body, severity: null, range: null });

describe("a reply typed on a thread folded into another", () => {
  it("keeps both texts when both threads had one, once when they read the same, and never an empty editor over text", () => {
    expect(mergeReplyDrafts(draft("First thought"), draft("Second thought")).body).toBe("First thought\n\nSecond thought");
    expect(mergeReplyDrafts(draft(""), draft("Typed on the copy")).body).toBe("Typed on the copy");
    expect(mergeReplyDrafts(draft("Typed here"), draft("  ")).body).toBe("Typed here");
    expect(mergeReplyDrafts(draft("Same"), draft("Same ")).body).toBe("Same");
    expect(mergeReplyDrafts(draft("a".repeat(BODY_MAX_CHARS)), draft("b")).body).toHaveLength(BODY_MAX_CHARS);
  });

  it("moves drafts and folds to the kept thread, wherever its own draft sits, and leaves the rest", () => {
    const state = {
      drafts: { general: draft("Overall"), "reply:copy": draft("Second thought"), "reply:kept": draft("First thought"), "edit:c1": draft("Edit") },
      expandedThreads: { copy: false, other: true },
      collapsed: {},
      scroll: null,
      savedAt: 3,
    };
    const remapped = remapThreadKeys(state, { copy: "kept" })!;
    expect(remapped.changedDrafts).toEqual(["reply:kept"]);
    expect(remapped.state).toEqual({
      ...state,
      drafts: { general: draft("Overall"), "reply:kept": draft("First thought\n\nSecond thought"), "edit:c1": draft("Edit") },
      expandedThreads: { other: true, kept: false },
    });
    // A fold the kept thread has wins.
    expect(remapThreadKeys({ drafts: {}, expandedThreads: { kept: true, copy: false } }, { copy: "kept" })!.state.expandedThreads).toEqual({ kept: true });
    expect(remapThreadKeys(state, { elsewhere: "kept" })).toBeNull();
  });
});
