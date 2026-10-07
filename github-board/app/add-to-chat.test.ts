import { describe, expect, it, vi } from "vitest";

import type { PluginComposerScope } from "@get-bb/plugin-sdk/app";

import { DEFAULT_PROMPTS } from "../shared/settings";
import {
  addCardToComposer,
  cardPrompt,
  chatTargets,
  composerLabel,
  composerProjectId,
  type ComposerNames,
} from "./add-to-chat";

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

describe("cardPrompt", () => {
  const prompts = {
    byType: { ...DEFAULT_PROMPTS, "open-prs": "Review {repository}#{number} ({title}): {url}" },
    byProject: { proj_w: { "open-prs": "Widgets review of {url}" }, proj_g: { issues: "Gadgets issue {url}" } },
  };

  it("fills in the card's column template", () => {
    expect(cardPrompt(prompts, item, "open-prs", null)).toBe(
      "Review octo/widgets#42 (Fix the parser): https://github.com/octo/widgets/pull/42",
    );
    expect(cardPrompt(prompts, item, "draft-prs", null)).toBe(
      "Read draft pull request https://github.com/octo/widgets/pull/42 and help me finish it.",
    );
  });

  it("uses the override of the chat's project for that column", () => {
    expect(cardPrompt(prompts, item, "open-prs", "proj_w")).toBe(
      "Widgets review of https://github.com/octo/widgets/pull/42",
    );
  });

  it("falls back to the column template where the project has no override for the column", () => {
    expect(cardPrompt(prompts, item, "open-prs", "proj_g")).toBe(cardPrompt(prompts, item, "open-prs", null));
    expect(cardPrompt(prompts, item, "open-prs", "proj_other")).toBe(cardPrompt(prompts, item, "open-prs", null));
  });
});

describe("composerProjectId", () => {
  const threads = [{ id: "thr_a", projectId: "proj_w" }];

  it("is a new thread's selected project", () => {
    expect(composerProjectId({ kind: "new-thread", projectId: "proj_g" }, threads)).toBe("proj_g");
    expect(composerProjectId({ kind: "new-thread", projectId: null }, threads)).toBeNull();
  });

  it("is the project of the thread a composer writes to", () => {
    expect(composerProjectId({ kind: "thread", threadId: "thr_a" }, threads)).toBe("proj_w");
    expect(composerProjectId({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "q1" }, threads)).toBe(
      "proj_w",
    );
  });

  it("is unknown for a thread the sidebar does not list", () => {
    expect(composerProjectId({ kind: "thread", threadId: "thr_hidden" }, threads)).toBeNull();
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
    addCardToComposer(composer, "Review this");
    expect(composer.insert).toHaveBeenCalledWith("Review this", { at: "end", block: true });
    expect(calls).toEqual(["insert", "focus"]);
  });

  it("does not focus a composer the insert failed on", () => {
    const composer = {
      insert: vi.fn(() => {
        throw new Error("This composer is no longer available");
      }),
      focus: vi.fn(),
    };
    expect(() => addCardToComposer(composer, "Read this")).toThrow("no longer available");
    expect(composer.focus).not.toHaveBeenCalled();
  });
});

describe("chatTargets", () => {
  const thread = (id: string, projectId: string, updatedAt: number, extra: object = {}) => ({
    id,
    projectId,
    displayTitle: `Thread ${id}`,
    isHidden: false,
    isArchived: false,
    updatedAt,
    ...extra,
  });
  const projects = [
    { id: "proj_w", name: "widgets" },
    { id: "proj_g", name: "gadgets" },
  ];
  const composer = (scope: PluginComposerScope) => ({ scope });
  const base = {
    threads: [thread("a", "proj_g", 400), thread("b", "proj_w", 100), thread("c", "proj_w", 300), thread("d", "proj_g", 200)],
    projects,
    cardProjectIds: new Set(["proj_w"]),
    sendDialogOpen: false,
  };

  it("lists the chats on screen first, in bb's order, named for the picker", () => {
    const thr = composer({ kind: "thread", threadId: "a" });
    const fresh = composer({ kind: "new-thread", projectId: "proj_w" });
    const targets = chatTargets({ ...base, composers: [thr, fresh] });
    expect(targets.onScreen).toEqual([
      { composer: thr, label: "Thread a", projectId: "proj_g" },
      { composer: fresh, label: "New thread in widgets", projectId: "proj_w" },
    ]);
  });

  it("never offers the Send to chat dialog's composer while the dialog is open", () => {
    const dialog = composer({ kind: "new-thread", projectId: "proj_w" });
    const thr = composer({ kind: "thread", threadId: "a" });
    const targets = chatTargets({ ...base, composers: [thr, dialog], sendDialogOpen: true });
    expect(targets.onScreen.map((target) => target.composer)).toEqual([thr]);
    expect(chatTargets({ ...base, composers: [dialog], sendDialogOpen: true }).onScreen).toEqual([]);
  });

  it("lists other threads with the card's projects first, most recent first within each", () => {
    const targets = chatTargets({ ...base, composers: [] });
    expect(targets.threads).toEqual([
      { threadId: "c", title: "Thread c", projectId: "proj_w", projectName: "widgets" },
      { threadId: "b", title: "Thread b", projectId: "proj_w", projectName: "widgets" },
      { threadId: "a", title: "Thread a", projectId: "proj_g", projectName: "gadgets" },
      { threadId: "d", title: "Thread d", projectId: "proj_g", projectName: "gadgets" },
    ]);
  });

  it("lists a thread on screen only once, and leaves out hidden and archived threads", () => {
    const targets = chatTargets({
      ...base,
      threads: [...base.threads, thread("h", "proj_w", 900, { isHidden: true }), thread("x", "proj_w", 900, { isArchived: true })],
      composers: [composer({ kind: "thread", threadId: "c" })],
    });
    expect(targets.threads.map((target) => target.threadId)).toEqual(["b", "a", "d"]);
  });

  it("keeps a thread whose queued message is being edited among the threads", () => {
    const targets = chatTargets({
      ...base,
      composers: [composer({ kind: "queued-message", threadId: "c", queuedMessageId: "q1" })],
    });
    expect(targets.threads.map((target) => target.threadId)).toContain("c");
  });

  it("caps the threads and names a thread's project only when it is known", () => {
    const targets = chatTargets({
      ...base,
      threads: [thread("z", "proj_gone", 1), ...base.threads],
      composers: [],
      limit: 5,
    });
    expect(targets.threads).toHaveLength(5);
    expect(targets.threads.at(-1)).toEqual({ threadId: "z", title: "Thread z", projectId: "proj_gone", projectName: null });
    expect(chatTargets({ ...base, composers: [], limit: 2 }).threads.map((target) => target.threadId)).toEqual(["c", "b"]);
  });
});
