import { describe, expect, it, vi } from "vitest";

import { addCardToComposer, cardReference, composerLabel, type ComposerNames } from "./add-to-chat";

const item = {
  repository: "octo/widgets",
  number: 42,
  title: "Fix the parser",
  url: "https://github.com/octo/widgets/pull/42",
};

const names: ComposerNames = {
  threads: [{ id: "thr_a", displayTitle: "Refactor the lexer" }],
  projects: [{ id: "proj_w", name: "widgets" }],
};

describe("cardReference", () => {
  it("names the kind, the item, its title and its URL on one line", () => {
    expect(cardReference(item, "open-prs")).toBe(
      "Pull request octo/widgets#42: Fix the parser — https://github.com/octo/widgets/pull/42",
    );
    expect(cardReference({ ...item, url: "https://github.com/octo/widgets/issues/42" }, "issues")).toBe(
      "Issue octo/widgets#42: Fix the parser — https://github.com/octo/widgets/issues/42",
    );
  });

  it("keeps a title with line breaks on one line", () => {
    expect(cardReference({ ...item, title: "  Fix\nthe\r\n parser  " }, "draft-prs")).toBe(
      "Pull request octo/widgets#42: Fix the parser — https://github.com/octo/widgets/pull/42",
    );
  });
});

describe("composerLabel", () => {
  it("names a thread's composer after the thread", () => {
    expect(composerLabel({ kind: "thread", threadId: "thr_a" }, names)).toBe("Refactor the lexer");
  });

  it("names a queued-message editor after its thread", () => {
    expect(composerLabel({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "q1" }, names)).toBe(
      "Queued message in Refactor the lexer",
    );
  });

  it("names the new-thread composer after its project when it has one", () => {
    expect(composerLabel({ kind: "new-thread", projectId: "proj_w" }, names)).toBe("New thread in widgets");
    expect(composerLabel({ kind: "new-thread", projectId: null }, names)).toBe("New thread");
    expect(composerLabel({ kind: "new-thread", projectId: "proj_gone" }, names)).toBe("New thread");
  });

  it("falls back for a thread the sidebar does not list", () => {
    expect(composerLabel({ kind: "thread", threadId: "thr_hidden" }, names)).toBe("A thread");
  });
});

describe("addCardToComposer", () => {
  it("appends the card as its own paragraph at the end, then focuses the composer", () => {
    const calls: string[] = [];
    const composer = {
      insert: vi.fn(() => calls.push("insert")),
      focus: vi.fn(() => calls.push("focus")),
    };
    addCardToComposer(composer, item, "open-prs");
    expect(composer.insert).toHaveBeenCalledWith(cardReference(item, "open-prs"), { at: "end", block: true });
    expect(calls).toEqual(["insert", "focus"]);
  });

  it("does not focus a composer the insert failed on", () => {
    const composer = {
      insert: vi.fn(() => {
        throw new Error("This composer is no longer available");
      }),
      focus: vi.fn(),
    };
    expect(() => addCardToComposer(composer, item, "issues")).toThrow("no longer available");
    expect(composer.focus).not.toHaveBeenCalled();
  });
});
