import { describe, expect, it } from "vitest";

import { mergeReplyDrafts, remapThreadKeys, withoutSent } from "./thread-aliases";
import { BODY_MAX_CHARS, DRAFT_MAX_CHARS, draftSchema } from "./types";

const draft = (body: string) => ({ body, severity: null, range: null });

describe("a reply typed on a thread folded into another", () => {
  it("keeps both texts when both threads had one, once when they read the same, and never an empty editor over text", () => {
    expect(mergeReplyDrafts(draft("First thought"), draft("Second thought"))!.body).toBe("First thought\n\nSecond thought");
    expect(mergeReplyDrafts(draft(""), draft("Typed on the copy"))!.body).toBe("Typed on the copy");
    expect(mergeReplyDrafts(draft("Typed here"), draft("  "))!.body).toBe("Typed here");
    expect(mergeReplyDrafts(draft("Same"), draft("Same "))!.body).toBe("Same");
  });

  it("never cuts two long replies: the joined text is kept whole, and is still a valid draft", () => {
    const first = "a".repeat(12_000);
    const second = "b".repeat(12_000);
    const joined = mergeReplyDrafts(draft(first), draft(second))!;
    expect(joined.body).toBe(`${first}\n\n${second}`);
    expect(draftSchema.safeParse(joined).success).toBe(true);
    // Two full-length replies fit; a joined one meeting another stays where it was, whole.
    const full = mergeReplyDrafts(draft("a".repeat(BODY_MAX_CHARS)), draft("b".repeat(BODY_MAX_CHARS)))!;
    expect(full.body).toHaveLength(DRAFT_MAX_CHARS);
    expect(mergeReplyDrafts(full, draft("c"))).toBeNull();
    const state = { drafts: { "reply:copy": draft("c"), "reply:kept": full } };
    expect(remapThreadKeys(state, { copy: "kept" })).toBeNull();
  });

  it("takes only the text posted out of a draft, keeping what was joined to it", () => {
    expect(withoutSent("Sent", "Sent")).toBeNull();
    expect(withoutSent("Sent\n\nUnsent", "Sent")).toBe("Unsent");
    expect(withoutSent("Unsent\n\nSent", "Sent")).toBe("Unsent");
    expect(withoutSent("Something else", "Sent")).toBe("Something else");
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
