// @vitest-environment jsdom
/**
 * The overlay that puts an "Add to chat" block into the chat's composer once
 * that composer is on screen — and onto the clipboard when it never shows.
 */
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => void toasts.success.push(message),
    error: (message: string) => void toasts.error.push(message),
  },
}));

const { ChatDelivery, createDeliveryStore } = await import("./chat-delivery");

afterEach(() => {
  cleanup();
  toasts.success.length = 0;
  toasts.error.length = 0;
});

const block = "Terminal output from build on Mac mini:\n\n```text\nok\n```";

function mount(scope: Parameters<typeof renderSlot>[2] extends infer O ? O : never, store = createDeliveryStore()) {
  const rendered = renderSlot({ component: () => <ChatDelivery store={store} /> }, {}, scope);
  return { rendered, store };
}

describe("ChatDelivery", () => {
  it("adds the block to the thread's draft, keeping what the user wrote, and focuses it", async () => {
    const { rendered, store } = mount({ composer: { scope: { kind: "thread", threadId: "thr_1" }, text: "Look:" } });
    store.request({ target: { kind: "thread", threadId: "thr_1" }, block, deadline: Date.now() + 10_000 });
    await waitFor(() => expect(rendered.composer.text).toBe(`Look:\n\n${block}\n`));
    expect(rendered.composer.focusCount).toBe(1);
    expect(rendered.composer.submits).toEqual([]);
    expect(store.get()).toBeNull();
  });

  it("waits for the composer of the thread it is for", async () => {
    const { rendered, store } = mount({ composer: { scope: { kind: "thread", threadId: "thr_other" } } });
    store.request({ target: { kind: "thread", threadId: "thr_1" }, block, deadline: Date.now() + 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rendered.composer.text).toBe("");
    expect(store.get()).not.toBeNull();

    // bb opened the thread: its composer is now on screen.
    await rendered.setComposerScope({ kind: "thread", threadId: "thr_1" });
    await waitFor(() => expect(rendered.composer.text).toBe(`${block}\n`));
    expect(store.get()).toBeNull();
  });

  it("writes into the New thread composer once it shows the chosen project", async () => {
    const { rendered, store } = mount({ composer: { scope: { kind: "new-thread", projectId: "proj_old" } } });
    store.request({ target: { kind: "new-thread", projectId: "proj_app" }, block, deadline: Date.now() + 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rendered.composer.text).toBe("");
    await rendered.setComposerScope({ kind: "new-thread", projectId: "proj_app" });
    await waitFor(() => expect(rendered.composer.text).toBe(`${block}\n`));
  });

  it("puts the block on the clipboard when the composer does not show up in time", async () => {
    const { rendered, store } = mount({
      composer: { scope: { kind: "thread", threadId: "thr_other" } },
      experimental_copyToClipboard: async () => true,
    });
    store.request({ target: { kind: "thread", threadId: "thr_1" }, block, deadline: Date.now() + 30 });
    await waitFor(() => expect(rendered.experimental_clipboardWrites).toEqual([{ text: block }]));
    expect(toasts.error).toEqual(["The chat did not open in time. The selection is on the clipboard instead."]);
    expect(rendered.composer.text).toBe("");
    expect(store.get()).toBeNull();
  });
});
