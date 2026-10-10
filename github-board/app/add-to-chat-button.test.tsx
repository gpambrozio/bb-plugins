// @vitest-environment jsdom
/**
 * Add to chat through the SDK's app harness. Its `useComposers()` reports one
 * composer, so a picker with several on screen is driven through
 * `AddToChatControl` with fake handles.
 */
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginComposerApi, PluginComposerScope } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardItem, PromptSettings } from "../shared/board";
import { DEFAULT_PROMPTS } from "../shared/settings";
import { AddToChatButton, AddToChatControl } from "./add-to-chat-button";
import type { ChatTargets } from "./add-to-chat";
import { pendingAdds } from "./pending-add";

afterEach(() => {
  cleanup();
  const pending = pendingAdds.current();
  if (pending !== null) pendingAdds.take(pending.id);
});

const item: BoardItem = {
  id: "I_42",
  number: 42,
  title: "Crash on empty input",
  url: "https://github.com/octo/widgets/issues/42",
  repository: "octo/widgets",
  updatedAt: "",
  commentsCount: 0,
  labels: [],
  author: null,
  detail: null,
  linkedIssues: [],
  checks: null,
  branch: null,
};
// widgets overrides the issue template; gadgets overrides only another column's.
const prompts: PromptSettings = {
  byType: { ...DEFAULT_PROMPTS, issues: "Fix issue {repository}#{number}: {url}" },
  byProject: { proj_w: { issues: "Widgets: triage {title} at {url}" }, proj_g: { "open-prs": "Gadgets review {url}" } },
};
/** The issue template with widgets' override, and without any. */
const widgetsPrompt = "Widgets: triage Crash on empty input at https://github.com/octo/widgets/issues/42";
const columnPrompt = "Fix issue octo/widgets#42: https://github.com/octo/widgets/issues/42";

function sidebarThread(id: string, projectId: string, displayTitle: string, updatedAt: number) {
  return { id, projectId, title: displayTitle, titleFallback: null, displayTitle, isHidden: false, isArchived: false, updatedAt };
}

const projects = [
  { id: "proj_w", name: "widgets" },
  { id: "proj_g", name: "gadgets" },
];
const threads = [
  sidebarThread("thr_a", "proj_w", "Refactor the lexer", 300),
  sidebarThread("thr_b", "proj_g", "Tune the cache", 200),
  sidebarThread("thr_c", "proj_w", "Write the changelog", 100),
];

const sendOptions = () => ({
  project: { id: "proj_w", name: "widgets" },
  candidates: [{ id: "proj_w", name: "widgets" }],
  launch: null,
});

function renderButton({
  scope,
  sendDialogOpen = false,
  getPrompts = () => prompts,
}: {
  scope: PluginComposerScope;
  sendDialogOpen?: boolean;
  getPrompts?: () => PromptSettings | Promise<PromptSettings>;
}) {
  return renderSlot(
    { component: () => <AddToChatButton item={item} column="issues" sendDialogOpen={sendDialogOpen} /> },
    {},
    {
      composer: { text: "Look at this:", scope },
      sidebarThreads: { status: "ready", threads: threads as never, projects: projects as never },
      rpc: { sendOptions, getPrompts } as never,
    },
  );
}

/** Picks a menu entry once the templates have loaded and enabled it. */
async function clickWhenEnabled(entry: HTMLElement) {
  await waitFor(() => expect(entry.getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(entry);
}

async function openMenu(view: ReturnType<typeof renderSlot>) {
  const trigger = view.getByRole("button", { name: "Add to chat" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return view.findByRole("menu");
}

describe("AddToChatButton", () => {
  it("adds the card's prompt to a chat on screen, after the draft, and sends nothing", async () => {
    // thr_a is in widgets, so widgets' issue template is the one used.
    const view = renderButton({ scope: { kind: "thread", threadId: "thr_a" } });

    const menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: "Refactor the lexer" }));

    await waitFor(() => expect(view.inspection.composer.text).toBe(`Look at this:\n\n${widgetsPrompt}`));
    expect(view.inspection.composer.focusCount).toBe(1);
    expect(view.inspection.composer.submits).toEqual([]);
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("is there with no chat on screen but the Send to chat dialog's, and never offers that one", async () => {
    // The dialog's composer is a new-thread composer, the only one on screen.
    const view = renderButton({ scope: { kind: "new-thread", projectId: "proj_w" }, sendDialogOpen: true });

    const menu = await openMenu(view);
    expect(within(menu).queryByText("On screen")).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /New thread/ })).toBeNull();
    // Recent threads instead, the card's project first.
    await waitFor(() =>
      expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
        "Refactor the lexerwidgets",
        "Write the changelogwidgets",
        "Tune the cachegadgets",
      ]),
    );
  });

  it("offers a new-thread composer on screen while the dialog is closed, with its project's template", async () => {
    const view = renderButton({ scope: { kind: "new-thread", projectId: "proj_w" } });

    const menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: "New thread in widgets" }));

    await waitFor(() => expect(view.inspection.composer.text).toBe(`Look at this:\n\n${widgetsPrompt}`));
  });

  it("uses the column's template for a chat whose project has no override for it", async () => {
    const view = renderButton({ scope: { kind: "new-thread", projectId: "proj_g" } });

    const menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: "New thread in gadgets" }));

    await waitFor(() => expect(view.inspection.composer.text).toBe(`Look at this:\n\n${columnPrompt}`));
  });

  it("uses the column's template for a new thread with no project", async () => {
    const view = renderButton({ scope: { kind: "new-thread", projectId: null } });

    const menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: "New thread" }));

    await waitFor(() => expect(view.inspection.composer.text).toBe(`Look at this:\n\n${columnPrompt}`));
  });

  it("keeps every chat disabled until the templates have loaded, and never writes anything else", async () => {
    const view = renderButton({ scope: { kind: "thread", threadId: "thr_a" }, getPrompts: () => new Promise(() => {}) });

    const menu = await openMenu(view);
    expect(within(menu).getByText("Loading prompt templates…")).toBeTruthy();
    const onScreen = within(menu).getByRole("menuitem", { name: "Refactor the lexer" });
    const other = await within(menu).findByRole("menuitem", { name: /Tune the cache/ });
    expect(onScreen.getAttribute("aria-disabled")).toBe("true");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(onScreen);
    fireEvent.click(other);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.inspection.composer.text).toBe("Look at this:");
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(pendingAdds.current()).toBeNull();
  });

  it("says why when the templates could not load", async () => {
    const view = renderButton({
      scope: { kind: "thread", threadId: "thr_a" },
      getPrompts: () => Promise.reject(new Error("storage is down")),
    });

    const menu = await openMenu(view);
    expect(await within(menu).findByText(/Could not load prompt templates: .*storage is down/)).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Refactor the lexer" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("opens a thread that is not on screen beside the board and leaves the card pending for it", async () => {
    const view = renderButton({ scope: { kind: "thread", threadId: "thr_a" } });

    const menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: /Tune the cache/ }));

    await waitFor(() =>
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_b", options: { split: true } },
      ]),
    );
    // thr_b is in gadgets, which overrides no issue template.
    expect(pendingAdds.current()).toMatchObject({ threadId: "thr_b", title: "Tune the cache", prompt: columnPrompt });
    // The chat on screen is left alone.
    expect(view.inspection.composer.text).toBe("Look at this:");
  });

  it("renders a pending card with the override of the opened thread's project", async () => {
    const view = renderButton({ scope: { kind: "new-thread", projectId: "proj_g" } });

    const menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: /Write the changelog/ }));

    await waitFor(() => expect(pendingAdds.current()).toMatchObject({ threadId: "thr_c", prompt: widgetsPrompt }));
  });

  it("takes one thread at a time: a second pick waits, with the reason, while chats on screen still work", async () => {
    const view = renderButton({ scope: { kind: "thread", threadId: "thr_a" } });

    let menu = await openMenu(view);
    await clickWhenEnabled(within(menu).getByRole("menuitem", { name: /Tune the cache/ }));
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());

    // Neither opened thread's composer has appeared yet.
    menu = await openMenu(view);
    expect(within(menu).getByText("Adding to Tune the cache…")).toBeTruthy();
    const other = within(menu).getByRole("menuitem", { name: /Write the changelog/ });
    expect(other.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(other);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.inspection.navigateCalls).toHaveLength(1);
    expect(pendingAdds.current()?.threadId).toBe("thr_b");

    // The chat already on screen still takes the card at once.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Refactor the lexer" }));
    await waitFor(() => expect(view.inspection.composer.text).toBe(`Look at this:\n\n${widgetsPrompt}`));
    expect(pendingAdds.current()?.threadId).toBe("thr_b");
  });
});

function fakeComposer(key: string, scope: PluginComposerScope) {
  return {
    key,
    scope,
    insert: vi.fn(),
    focus: vi.fn(),
    submit: vi.fn(),
  };
}

function renderControl(targets: ChatTargets<ReturnType<typeof fakeComposer>>, loading = false) {
  const onOpenThread = vi.fn();
  const view = renderSlot(
    {
      component: () => (
        <AddToChatControl
          targets={targets as unknown as ChatTargets<PluginComposerApi>}
          loading={loading}
          addingTo={null}
          prompts={prompts}
          promptsError={null}
          item={item}
          column="issues"
          onOpenThread={onOpenThread}
        />
      ),
    },
    {},
    {},
  );
  return { view, onOpenThread };
}

describe("AddToChatControl", () => {
  it("lets the user pick among several chats on screen and writes only to that one", async () => {
    const first = fakeComposer("thread:thr_a", { kind: "thread", threadId: "thr_a" });
    const second = fakeComposer("new-thread", { kind: "new-thread", projectId: "proj_w" });
    // The composer's editor, outside the menu: picking must leave the caret there.
    const editor = document.body.appendChild(document.createElement("textarea"));
    second.focus.mockImplementation(() => editor.focus());
    const { view, onOpenThread } = renderControl({
      onScreen: [
        { composer: first, label: "Refactor the lexer", projectId: "proj_w" },
        { composer: second, label: "New thread in widgets", projectId: null },
      ],
      threads: [],
    });

    const menu = await openMenu(view);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New thread in widgets" }));

    await waitFor(() => expect(second.insert).toHaveBeenCalledWith(columnPrompt, { at: "end", block: true }));
    expect(second.focus).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(editor);
    editor.remove();
    expect(first.insert).not.toHaveBeenCalled();
    expect(second.submit).not.toHaveBeenCalled();
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to add to", async () => {
    const { view } = renderControl({ onScreen: [], threads: [] });
    const menu = await openMenu(view);
    expect(within(menu).getByRole("menuitem", { name: "No threads to add to" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("waits for the sidebar before writing to a thread's composer, whose project it names", async () => {
    const thread = fakeComposer("thread:thr_a", { kind: "thread", threadId: "thr_a" });
    const fresh = fakeComposer("new-thread", { kind: "new-thread", projectId: "proj_w" });
    const { view } = renderControl(
      {
        onScreen: [
          { composer: thread, label: "A thread", projectId: null },
          { composer: fresh, label: "New thread in widgets", projectId: "proj_w" },
        ],
        threads: [],
      },
      true,
    );
    const menu = await openMenu(view);
    expect(within(menu).getByRole("menuitem", { name: "A thread" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: "New thread in widgets" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("says the threads are loading while the sidebar has not answered", async () => {
    const { view } = renderControl({ onScreen: [], threads: [] }, true);
    const menu = await openMenu(view);
    expect(within(menu).getByRole("menuitem", { name: "Loading threads…" })).toBeTruthy();
  });
});
