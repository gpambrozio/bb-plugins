// @vitest-environment jsdom
/**
 * The realtime signals are broadcast, not persisted: a window that was
 * disconnected while another one edited a label, the display preferences or
 * the templates never hears about it. These hooks refetch when the connection
 * comes back.
 */
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import type { Board } from "../shared/board";
import { DEFAULT_PROMPTS } from "../shared/settings";
import { DISPLAY_PREFS_CHANGED, ITEM_PATCHED, PROMPTS_CHANGED } from "../shared/schemas";
import { BoardPatchListener, useBoard, useDisplayPrefs, usePrompts } from "./state";

afterEach(() => cleanup());

function Probe() {
  const { board } = useBoard();
  const { prefs } = useDisplayPrefs();
  const { prompts } = usePrompts();
  return (
    <pre data-testid="state">
      {JSON.stringify({
        labels: board?.columns[0]?.items[0]?.labels ?? null,
        hidden: prefs?.hiddenRepositories ?? null,
        issues: prompts?.byType.issues ?? null,
      })}
    </pre>
  );
}

function boardWith(labels: string[]): Board {
  return {
    login: "me",
    fetchedAt: "2026-09-30T00:00:00Z",
    repositoryProjects: {},
    columns: [
      {
        id: "issues",
        title: "Issues",
        error: null,
        items: [
          {
            id: "I1",
            number: 1,
            title: "t",
            url: "https://github.com/o/r/issues/1",
            repository: "o/r",
            updatedAt: "",
            commentsCount: 0,
            labels,
            author: null,
            detail: null,
            linkedIssues: [],
            checks: null,
            branch: null,
          },
        ],
      },
    ],
  };
}

describe("after a reconnect", () => {
  it("refetches the board, the display preferences and the templates", async () => {
    // What the server holds; edited below while this window is disconnected.
    const server = {
      labels: ["old"],
      hidden: [] as string[],
      issues: DEFAULT_PROMPTS.issues,
    };
    const view = renderSlot(
      { component: Probe },
      {},
      {
        rpc: {
          loadBoard: () => boardWith(server.labels),
          getDisplayPrefs: () => ({ hiddenRepositories: server.hidden, detailWidthFraction: null }),
          getPrompts: () => ({ byType: { ...DEFAULT_PROMPTS, issues: server.issues }, byProject: {} }),
        },
      },
    );
    const state = () => JSON.parse(view.getByTestId("state").textContent ?? "{}");

    await waitFor(() =>
      expect(state()).toEqual({ labels: ["old"], hidden: [], issues: DEFAULT_PROMPTS.issues }),
    );

    await view.behavior.setRealtimeConnectionState("reconnecting");
    // Another window's edits, whose signals this one never received.
    server.labels = ["old", "new"];
    server.hidden = ["o/other"];
    server.issues = "Fix {url}";
    expect(state()).toEqual({ labels: ["old"], hidden: [], issues: DEFAULT_PROMPTS.issues });

    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(state()).toEqual({ labels: ["old", "new"], hidden: ["o/other"], issues: "Fix {url}" }),
    );
    const calls = view.inspection.rpcCalls.map((call) => call.method);
    expect(calls.filter((method) => method === "loadBoard")).toHaveLength(2);
    expect(calls.filter((method) => method === "getDisplayPrefs")).toHaveLength(2);
    expect(calls.filter((method) => method === "getPrompts")).toHaveLength(2);
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("answers that arrive out of order", () => {
  const prefs = (hidden: string[]) => ({ hiddenRepositories: hidden, detailWidthFraction: null });
  const prompts = (issues: string) => ({ byType: { ...DEFAULT_PROMPTS, issues }, byProject: {} });

  it("drops a board load that a reconnect's newer load overtook", async () => {
    const first = deferred<Board>();
    let calls = 0;
    const view = renderSlot(
      { component: Probe },
      {},
      {
        rpc: {
          loadBoard: () => {
            calls += 1;
            return calls === 1 ? first.promise : boardWith(["fresh"]);
          },
          getDisplayPrefs: () => prefs([]),
          getPrompts: () => prompts(DEFAULT_PROMPTS.issues),
        },
      },
    );
    const labels = () => JSON.parse(view.getByTestId("state").textContent ?? "{}").labels;
    await view.behavior.setRealtimeConnectionState("reconnecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(labels()).toEqual(["fresh"]));
    first.resolve(boardWith(["stale"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(labels()).toEqual(["fresh"]);
    view.unmount();
  });

  it("keeps an edit that arrived while the load was running", async () => {
    const load = deferred<Board>();
    const view = renderSlot(
      { component: Probe },
      {},
      {
        rpc: {
          loadBoard: () => load.promise,
          getDisplayPrefs: () => prefs([]),
          getPrompts: () => prompts(DEFAULT_PROMPTS.issues),
        },
      },
    );
    const labels = () => JSON.parse(view.getByTestId("state").textContent ?? "{}").labels;
    // The overlay's listener is what adopts the signal app-wide.
    const listener = renderSlot({ component: BoardPatchListener }, {}, {});
    await listener.behavior.emitRealtime(ITEM_PATCHED, { itemId: "I1", patch: { labels: ["patched"] } });
    load.resolve(boardWith(["before the edit"]));
    // Let the load's answer land before looking, or this sees the patch alone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(labels()).toEqual(["patched"]);
    listener.unmount();
    view.unmount();
  });

  it("keeps pushed display prefs and templates over a fetch that started before them", async () => {
    const prefsFetch = deferred<ReturnType<typeof prefs>>();
    const promptsFetch = deferred<ReturnType<typeof prompts>>();
    const view = renderSlot(
      { component: Probe },
      {},
      {
        rpc: {
          loadBoard: () => boardWith(["x"]),
          getDisplayPrefs: () => prefsFetch.promise,
          getPrompts: () => promptsFetch.promise,
        },
      },
    );
    const state = () => JSON.parse(view.getByTestId("state").textContent ?? "{}");
    await view.behavior.emitRealtime(DISPLAY_PREFS_CHANGED, prefs(["pushed"]));
    await view.behavior.emitRealtime(PROMPTS_CHANGED, prompts("Pushed {url}"));
    prefsFetch.resolve(prefs([]));
    promptsFetch.resolve(prompts(DEFAULT_PROMPTS.issues));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state()).toMatchObject({ hidden: ["pushed"], issues: "Pushed {url}" });
    view.unmount();
  });
});
