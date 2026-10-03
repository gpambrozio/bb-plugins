// @vitest-environment jsdom
/**
 * The suggestion cards: pressing one sends its prompt and, once it has landed, removes it; the trash
 * removes it without sending; and the chevron opens the whole suggestion without sending anything. jsdom lays nothing out and has no `ResizeObserver`, so a card
 * there counts as cut unless a test supplies an observer and the sizes it should read.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Suggestion } from "../shared/types";
import { Suggestions } from "./suggestions";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LAND: Suggestion = { label: "Land web#42", prompt: "Merge web#42 once its checks are green, then delete the branch." };
const TIDY: Suggestion = { label: "Tidy the backlog", prompt: "Drop the backlog items that already shipped." };

function renderList(suggestions: readonly Suggestion[] = [LAND, TIDY], ask: () => null = () => null) {
  const changed: unknown[] = [];
  const view = renderSlot(
    { component: Suggestions },
    { suggestions, mateThreadId: "thr_mate", onChanged: () => changed.push(null) },
    {
      rpc: {
        "mate.ask": ask,
        "suggestion.remove": () => [],
      },
    },
  );
  return { ...view, changed };
}

function sendButton(suggestion: Suggestion): HTMLElement {
  return screen.getByRole("button", { name: `${suggestion.label}: send "${suggestion.prompt}" to the first mate` });
}

describe("Suggestions", () => {
  it("draws nothing when there is nothing to suggest", () => {
    const { container } = renderList([]);
    expect(container.textContent).toBe("");
  });

  it("sends a card's prompt, then removes that suggestion and opens the first mate's thread", async () => {
    const view = renderList();
    fireEvent.click(sendButton(LAND));
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([
      { method: "mate.ask", input: { text: LAND.prompt } },
      { method: "suggestion.remove", input: LAND },
    ]);
    expect(view.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mate" }]);
  });

  it("keeps the card, and shows why, when the send fails", async () => {
    const view = renderList([LAND, TIDY], () => {
      throw new Error("The first mate is not aboard.");
    });
    fireEvent.click(sendButton(LAND));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The first mate is not aboard."));
    expect(view.rpcCalls).toEqual([{ method: "mate.ask", input: { text: LAND.prompt } }]);
    expect(view.changed).toEqual([]);
    expect(view.navigateCalls).toEqual([]);
    expect((sendButton(LAND) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes a suggestion with its trash, without sending it", async () => {
    const view = renderList();
    fireEvent.click(screen.getByRole("button", { name: `Remove suggestion: ${TIDY.label}` }));
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([{ method: "suggestion.remove", input: TIDY }]);
  });

  it("opens and folds the whole suggestion without sending it", () => {
    const view = renderList();
    const toggle = screen.getByRole("button", { name: `Show the whole suggestion: ${LAND.label}` });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    const hide = screen.getByRole("button", { name: `Hide the whole suggestion: ${LAND.label}` });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    const full = document.getElementById(hide.getAttribute("aria-controls") ?? "");
    expect(full?.textContent).toBe(LAND.prompt);
    expect(full?.className).toContain("whitespace-pre-wrap");
    expect(full?.className).toContain("select-text");
    // The other card stays folded.
    expect(screen.getByRole("button", { name: `Show the whole suggestion: ${TIDY.label}` })).toBeTruthy();

    fireEvent.click(hide);
    expect(screen.getByRole("button", { name: `Show the whole suggestion: ${LAND.label}` }).getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(hide.getAttribute("aria-controls") ?? "")).toBeNull();
    expect(view.rpcCalls).toEqual([]);
    expect(view.navigateCalls).toEqual([]);
  });

  it("still sends from an opened card", async () => {
    const view = renderList();
    fireEvent.click(screen.getByRole("button", { name: `Show the whole suggestion: ${LAND.label}` }));
    fireEvent.click(sendButton(LAND));
    await waitFor(() => expect(view.changed).toHaveLength(1));
    expect(view.rpcCalls).toEqual([
      { method: "mate.ask", input: { text: LAND.prompt } },
      { method: "suggestion.remove", input: LAND },
    ]);
    expect(view.navigateCalls).toHaveLength(1);
  });

  it("offers no chevron for a card whose text fits", () => {
    stubLayout({ cut: (line) => line.textContent === LAND.prompt });
    renderList();
    expect(screen.getByRole("button", { name: `Show the whole suggestion: ${LAND.label}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Show the whole suggestion: ${TIDY.label}` })).toBeNull();
  });
});

/** A `ResizeObserver` and line sizes for jsdom: a line `cut` holds twice the height it shows. */
function stubLayout({ cut }: { cut: (line: Element) => boolean }): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(32);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return cut(this) ? 64 : 32;
  });
}
