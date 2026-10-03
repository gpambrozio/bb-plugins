// @vitest-environment jsdom
/**
 * Add to chat through the SDK's app harness: its `useComposers()` reports one
 * composer, which is the case drawn as a plain button. No composer and several
 * are driven through `AddToChatControl` with fake handles, because the harness
 * always has exactly one.
 */
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { PluginComposerApi, PluginComposerScope } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardItem } from "../shared/board";
import { AddToChatButton, AddToChatControl } from "./add-to-chat-button";

afterEach(() => cleanup());

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
const reference = "Issue octo/widgets#42: Crash on empty input — https://github.com/octo/widgets/issues/42";

const thread = {
  id: "thr_a",
  projectId: "proj_w",
  title: "Refactor the lexer",
  titleFallback: null,
  displayTitle: "Refactor the lexer",
};

describe("AddToChatButton with one composer on screen", () => {
  it("adds the card after the draft, leaves the draft and sends nothing", async () => {
    const view = renderSlot(
      { component: () => <AddToChatButton item={item} column="issues" /> },
      {},
      {
        composer: { text: "Look at this:", scope: { kind: "thread", threadId: "thr_a" } },
        sidebarThreads: { status: "ready", threads: [thread as never], projects: [] },
      },
    );

    fireEvent.click(view.getByRole("button", { name: "Add to chat: Refactor the lexer" }));

    await waitFor(() => expect(view.inspection.composer.text).toBe(`Look at this:\n\n${reference}`));
    expect(view.inspection.composer.focusCount).toBe(1);
    expect(view.inspection.composer.submits).toEqual([]);
    expect(view.inspection.rpcCalls).toEqual([]);
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

const names = {
  threads: [{ id: "thr_a", displayTitle: "Refactor the lexer" }],
  projects: [{ id: "proj_w", name: "widgets" }],
};

function renderControl(composers: ReturnType<typeof fakeComposer>[]) {
  return renderSlot(
    {
      component: () => (
        <AddToChatControl
          composers={composers as unknown as PluginComposerApi[]}
          names={names}
          item={item}
          column="issues"
        />
      ),
    },
    {},
    {},
  );
}

describe("AddToChatControl", () => {
  it("draws nothing while no composer is on screen", () => {
    const view = renderControl([]);
    expect(view.queryByRole("button", { name: /Add to chat/ })).toBeNull();
  });

  it("lets the user pick among several composers and writes only to that one", async () => {
    const first = fakeComposer("thread:thr_a", { kind: "thread", threadId: "thr_a" });
    const second = fakeComposer("new-thread", { kind: "new-thread", projectId: "proj_w" });
    // The composer's editor, outside the menu: picking must leave the caret there.
    const editor = document.body.appendChild(document.createElement("textarea"));
    second.focus.mockImplementation(() => editor.focus());
    const view = renderControl([first, second]);

    const trigger = view.getByRole("button", { name: "Add to chat" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const option = await view.findByRole("menuitem", { name: "New thread in widgets" });
    expect(view.getByRole("menuitem", { name: "Refactor the lexer" })).toBeTruthy();
    fireEvent.click(option);

    await waitFor(() => expect(second.insert).toHaveBeenCalledWith(reference, { at: "end", block: true }));
    expect(second.focus).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(editor);
    editor.remove();
    expect(first.insert).not.toHaveBeenCalled();
    expect(second.submit).not.toHaveBeenCalled();
  });
});
