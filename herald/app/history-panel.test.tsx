// @vitest-environment jsdom
/**
 * The Herald tab while bb keeps it mounted but not showing: it reads nothing
 * and its clock stands still, and it catches up when it shows again. bb 0.48
 * says whether the tab is showing; the harness answers one value per render,
 * so the hook is replaced here by one the test can flip.
 */
import { act, cleanup, screen } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_STORED_CONFIG, ENTRIES_CHANNEL, type HistoryItem, type RecentHistoryItem } from "../shared/herald";
import { NO_CHOICE } from "../shared/thread-choice";

const visibility = vi.hoisted(() => {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    get: () => visible,
    set(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("./bb-features", () => ({
  HAS_PANEL_CONTROLLER: true,
  useTabVisible: () => useSyncExternalStore(visibility.subscribe, visibility.get),
}));

const { HeraldHistoryPanel } = await import("./history-panel");

afterEach(() => {
  cleanup();
  visibility.set(true);
});

function backend(items: () => HistoryItem[], reads: { count: number }) {
  return {
    list: () => ({ entries: [] }),
    "config.get": () => DEFAULT_STORED_CONFIG,
    "config.set": () => DEFAULT_STORED_CONFIG,
    "history.list": () => {
      reads.count += 1;
      return { items: items() };
    },
    "history.recent": () => ({ items: [] as RecentHistoryItem[] }),
    "speech.voices": () => ({ available: false, voices: [] }),
    "speech.render": () => ({ mimeType: "audio/wav", base64: "" }),
    "choices.list": () => ({ threads: {} }),
    "choices.set": () => NO_CHOICE,
    "choices.setMany": () => null,
    "push.status": () => ({ state: "off" as const, message: null }),
    log: () => null,
  };
}

const DONE: HistoryItem = { eventId: "t1:idle:1", reason: "finished", createdAt: new Date().toISOString(), headline: "Finished", text: "Login fix is done." };
const ASKED: HistoryItem = { eventId: "t1:interaction:i1", reason: "question", createdAt: new Date().toISOString(), headline: "Which DB?", text: "Login fix has a question." };

describe("Herald's tab while it is not showing", () => {
  it("reads nothing until it shows, then reads once", async () => {
    visibility.set(false);
    const reads = { count: 0 };
    const slot = renderSlot<{ threadId: string; params: null }, RpcContract>(
      { component: HeraldHistoryPanel },
      { threadId: "t1", params: null },
      { rpc: backend(() => [DONE], reads) },
    );
    await slot.emitRealtime(ENTRIES_CHANNEL, { at: 1 });
    expect(reads.count).toBe(0);
    act(() => visibility.set(true));
    await screen.findByText("Login fix is done.");
    expect(reads.count).toBe(1);
  });

  it("notes a nudge while hidden and reads it when it shows again; reads at once while showing", async () => {
    let items = [DONE];
    const reads = { count: 0 };
    const slot = renderSlot<{ threadId: string; params: null }, RpcContract>(
      { component: HeraldHistoryPanel },
      { threadId: "t1", params: null },
      { rpc: backend(() => items, reads) },
    );
    await screen.findByText("Login fix is done.");
    expect(reads.count).toBe(1);

    act(() => visibility.set(false));
    items = [ASKED, DONE];
    await slot.emitRealtime(ENTRIES_CHANNEL, { at: 2 });
    expect(reads.count).toBe(1);
    expect(screen.queryByText("Login fix has a question.")).toBeNull();

    act(() => visibility.set(true));
    await screen.findByText("Login fix has a question.");
    expect(reads.count).toBe(2);

    // Shown again with nothing missed: no extra read.
    act(() => visibility.set(false));
    act(() => visibility.set(true));
    expect(reads.count).toBe(2);
    await slot.emitRealtime(ENTRIES_CHANNEL, { at: 3 });
    expect(reads.count).toBe(3);
  });

  it("stops its clock while hidden", () => {
    vi.useFakeTimers();
    try {
      const reads = { count: 0 };
      renderSlot<{ threadId: string; params: null }, RpcContract>(
        { component: HeraldHistoryPanel },
        { threadId: "t1", params: null },
        { rpc: backend(() => [], reads) },
      );
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const running = vi.getTimerCount();
      act(() => visibility.set(false));
      expect(vi.getTimerCount()).toBe(running - 1);
      act(() => visibility.set(true));
      expect(vi.getTimerCount()).toBe(running);
    } finally {
      vi.useRealTimers();
    }
  });
});
