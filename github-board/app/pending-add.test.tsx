// @vitest-environment jsdom
/**
 * A card picked for a thread whose chat was not on screen: held until that
 * thread's composer shows up, delivered once, dropped after the timeout.
 */
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { PendingAddToChat } from "./pending-add-delivery";
import { createPendingAdds, PENDING_ADD_TIMEOUT_MS } from "./pending-add";

const card = {
  threadId: "thr_b",
  title: "Tune the cache",
  item: {
    repository: "octo/widgets",
    number: 7,
    title: "Slow start",
    url: "https://github.com/octo/widgets/pull/7",
  },
  column: "open-prs" as const,
};
const reference = "Pull request octo/widgets#7: Slow start — https://github.com/octo/widgets/pull/7";

beforeEach(() => toastError.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("createPendingAdds", () => {
  it("holds one card, which a later pick replaces", () => {
    const store = createPendingAdds(() => 1_000);
    const first = store.request(card);
    const second = store.request({ ...card, threadId: "thr_c" });
    expect(first.deadline).toBe(1_000 + PENDING_ADD_TIMEOUT_MS);
    expect(store.current()).toBe(second);
    expect(store.take(first.id)).toBeNull();
    expect(store.take(second.id)).toBe(second);
    expect(store.current()).toBeNull();
    expect(store.take(second.id)).toBeNull();
  });

  it("tells subscribers when the card changes", () => {
    const store = createPendingAdds();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const pending = store.request(card);
    store.take(pending.id);
    unsubscribe();
    store.request(card);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("PendingAddToChat", () => {
  it("adds the card to the opened thread's draft once its composer is on screen", async () => {
    const store = createPendingAdds();
    store.request(card);
    const view = renderSlot(
      { component: () => <PendingAddToChat store={store} /> },
      {},
      { composer: { text: "Draft so far", scope: { kind: "thread", threadId: "thr_b" } } },
    );

    await waitFor(() => expect(view.inspection.composer.text).toBe(`Draft so far\n\n${reference}`));
    expect(view.inspection.composer.focusCount).toBe(1);
    expect(view.inspection.composer.submits).toEqual([]);
    expect(store.current()).toBeNull();
  });

  it("waits while another chat is on screen, then gives up and says so", async () => {
    vi.useFakeTimers();
    const store = createPendingAdds();
    store.request(card);
    const view = renderSlot(
      { component: () => <PendingAddToChat store={store} /> },
      {},
      { composer: { text: "Elsewhere", scope: { kind: "thread", threadId: "thr_a" } } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_ADD_TIMEOUT_MS - 1);
    });
    expect(store.current()).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(store.current()).toBeNull();
    expect(toastError).toHaveBeenCalledWith("Could not add to chat: “Tune the cache” did not open.");
    expect(view.inspection.composer.text).toBe("Elsewhere");
  });

  it("delivers to the thread when its composer replaces the one on screen", async () => {
    const store = createPendingAdds();
    store.request(card);
    const view = renderSlot(
      { component: () => <PendingAddToChat store={store} /> },
      {},
      { composer: { text: "", scope: { kind: "new-thread", projectId: null } } },
    );
    expect(store.current()).not.toBeNull();

    await view.behavior.setComposerScope({ kind: "thread", threadId: "thr_b" });

    await waitFor(() => expect(store.current()).toBeNull());
    expect(toastError).not.toHaveBeenCalled();
  });
});
