// @vitest-environment jsdom
/**
 * A held worker's own FirstMate tab, through a whole Answer: the send goes out, the line is shut while it
 * does, the landed send brings the first mate's thread (and its board) into view, and coming back finds the
 * worker's card again with nothing lost.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fleet } from "../shared/types";
import { Panel } from "./panel";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

const FLEET: Fleet = {
  home: "/h",
  homeReady: true,
  mate: { threadId: "thr_mate", status: "idle", title: "First mate" },
  mateMissing: false,
  cards: [
    {
      key: "fix-login",
      column: "blocked",
      taskId: "fix-login",
      title: "Fix login",
      project: "web",
      kind: "ship",
      backlog: {
        section: "in-flight",
        id: "fix-login",
        title: "Fix login",
        project: "web",
        kind: "ship",
        mode: null,
        threadId: "thr_worker",
        hold: "merge?",
        actions: [{ label: "Merge", prompt: "Merge https://github.com/you/web/pull/42" }],
        blockedBy: null,
        since: null,
        url: "https://github.com/you/web/pull/42",
        reportPath: null,
        outcome: null,
      },
      crew: {
        threadId: "thr_worker",
        title: "Fix login",
        status: "idle",
        pendingInteractions: 0,
        projectId: "proj_web",
        environmentId: "env_w",
        updatedAt: 0,
        task: "fix-login",
        kind: "ship",
        project: "web",
      },
      report: { state: "done", text: "PR ready" },
      url: "https://github.com/you/web/pull/42",
    },
  ],
  suggestions: [],
  charter: { edited: false, outdated: false },
  watches: [],
};

const answerBox = () => screen.getByRole("textbox", { name: "Answer for fix-login" }) as HTMLInputElement;
const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("a worker's panel, answering its hold", () => {
  it("shuts the line while the send is out, follows it to the first mate, and finds the card unchanged on return", async () => {
    let land: (value: null) => void = () => {};
    const view = renderSlot(
      { component: Panel },
      { threadId: "thr_worker" },
      {
        rpc: {
          "fleet.load": () => FLEET,
          "mate.ask": () => new Promise<null>((resolve) => (land = resolve)),
        },
      },
    );
    await waitFor(() => expect(answerBox()).toBeTruthy());

    fireEvent.change(answerBox(), { target: { value: "Postgres" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(answerBox().disabled).toBe(true));
    expect(sendButton().disabled).toBe(true);

    land(null);
    await waitFor(() => expect(view.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mate" }]));
    expect(view.rpcCalls.filter((call) => call.method === "mate.ask")).toEqual([
      { method: "mate.ask", input: { text: "fix-login — Fix login: Postgres" } },
    ]);

    // Follow the navigation: the tab now shows the first mate's board, where the card is too.
    view.lifecycle.rerender(<Panel threadId="thr_mate" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Bearings" })).toBeTruthy());
    expect(answerBox().disabled).toBe(false);

    // And back to the worker: its card, its line open and empty, nothing else sent.
    view.lifecycle.rerender(<Panel threadId="thr_worker" />);
    await waitFor(() => expect(screen.getByText("Save note")).toBeTruthy());
    expect(answerBox().value).toBe("");
    expect(answerBox().disabled).toBe(false);
    expect(view.rpcCalls.filter((call) => call.method === "mate.ask")).toHaveLength(1);
  });
});
