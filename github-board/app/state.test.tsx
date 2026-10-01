// @vitest-environment jsdom
/**
 * The realtime signals are broadcast, not persisted: a window that was
 * disconnected while another one edited a label, the display preferences or
 * the templates never hears about it. These hooks refetch when the connection
 * comes back.
 */
import { waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

import type { Board } from "../shared/board";
import { DEFAULT_PROMPTS } from "../shared/settings";
import { useBoard, useDisplayPrefs, usePrompts } from "./state";

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
