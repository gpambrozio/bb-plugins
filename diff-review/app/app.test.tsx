// @vitest-environment jsdom
/**
 * The Review tab against a recorded RPC backend. `@pierre/diffs` is bb's at run time and needs a
 * highlighter jsdom does not have, so a stand-in renders each annotation through the tab's own
 * `renderAnnotation` and offers the gutter "+" as a button.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewThread, ReviewView } from "../shared/types";
import { ReviewPanel } from "./review-panel";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: (props: {
    lineAnnotations: { side: string; lineNumber: number; metadata: unknown }[];
    renderAnnotation(annotation: unknown): ReactNode;
    options: { onGutterUtilityClick(range: { start: number; end: number; side: string }): void };
  }) => (
    <div data-testid="patch">
      <button type="button" onClick={() => props.options.onGutterUtilityClick({ start: 1, end: 2, side: "additions" })}>
        gutter +
      </button>
      {props.lineAnnotations.map((annotation) => (
        <div key={`${annotation.side}:${annotation.lineNumber}`} data-testid={`annotation-${annotation.side}-${annotation.lineNumber}`}>
          {props.renderAnnotation(annotation)}
        </div>
      ))}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;", ""].join("\n");

function thread(overrides: Partial<ReviewThread> & { id: string; body: string }): ReviewThread {
  const { body, ...rest } = overrides;
  return {
    sessionId: "ses_1",
    filePath: "src/a.ts",
    side: "new",
    startLine: 2,
    endLine: 2,
    status: "open",
    severity: null,
    anchorContent: "const b = 3;",
    createdAt: 1,
    updatedAt: 1,
    comments: [{ id: `c_${rest.id}`, authorType: "user", authorName: "You", body, createdAt: 1, editedAt: null }],
    delivery: null,
    ...rest,
  };
}

const VIEW: Extract<ReviewView, { ok: true }> = {
  ok: true,
  sessionId: "ses_1",
  environmentId: "env_1",
  target: { kind: "uncommitted" },
  defaultBase: "main",
  currentBranch: "feature",
  commits: [],
  files: [
    {
      path: "src/a.ts",
      previousPath: null,
      changeKind: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
      loadMode: "auto",
      untracked: false,
      patch: PATCH,
      patchTruncated: false,
    },
  ],
  ignoredPaths: ["package-lock.json"],
  truncated: false,
  threads: [
    // Made on line 5 but its text is on line 2 now: shown there, as moved.
    thread({ id: "aaaaaa000001", body: "Why three?", startLine: 5, endLine: 5, severity: "question" }),
    thread({ id: "aaaaaa000002", body: "Add tests for this change", filePath: "__general__", side: null, startLine: 0, endLine: 0, anchorContent: null }),
    thread({ id: "aaaaaa000003", body: "This line is gone", anchorContent: "const d = 5;" }),
    thread({
      id: "aaaaaa000004",
      body: "Already sent",
      delivery: { state: "sent", sendId: "s1", threadId: "thr_1", sentAt: 1 },
    }),
  ],
};

function render(rpc: Record<string, (input: never) => unknown> = {}) {
  return renderSlot(
    { component: ReviewPanel },
    { threadId: "thr_1", params: null },
    { rpc: { getReview: () => VIEW, ...rpc }, codeTheme: { mode: "dark", name: "pierre-dark" } },
  );
}

describe("the app", () => {
  it("registers the Review tab and a palette command", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadPanelActions.map((action) => [action.id, action.title, action.layout])).toEqual([["review", "Review", "flush"]]);
  });
});

describe("the Review tab", () => {
  it("shows the diff with each thread where its code is now, whole-diff threads on top, and lost ones apart", async () => {
    const slot = render();
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(slot.inspection.rpcCalls[0]).toEqual({ method: "getReview", input: { threadId: "thr_1", target: { kind: "uncommitted" } } });

    const line = screen.getByTestId("annotation-additions-2");
    expect(within(line).getByText("Why three?")).toBeTruthy();
    expect(within(line).getByText("Moved from line 5")).toBeTruthy();
    expect(within(line).getByText("Already sent")).toBeTruthy();
    expect(within(line).getByText("Sent · waiting for the agent")).toBeTruthy();

    expect(screen.getByText("About the whole diff")).toBeTruthy();
    expect(screen.getByText("Add tests for this change")).toBeTruthy();
    const lost = screen.getByText("Not on the current diff (the code changed or left the view)").parentElement!;
    expect(within(lost).getByText("This line is gone")).toBeTruthy();
    expect(within(lost).getByText("const d = 5;")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send to agent \(4\)/ })).toBeTruthy();
  });

  it("adds a comment on the lines the gutter picked, with their text as the anchor", async () => {
    const created = thread({ id: "bbbbbb000001", body: "Rename b", startLine: 1, endLine: 2, anchorContent: "const a = 1;\nconst b = 3;" });
    const slot = render({ createThread: () => ({ thread: created }) });
    fireEvent.click(await screen.findByText("gutter +"));
    expect(screen.getByText("New comment on lines 1–2 (new side)")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Leave a comment. Markdown works."), { target: { value: "Rename b" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByText("Rename b");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "createThread")!.input).toEqual({
      sessionId: "ses_1",
      filePath: "src/a.ts",
      side: "new",
      startLine: 1,
      endLine: 2,
      anchorContent: "const a = 1;\nconst b = 3;",
      body: "Rename b",
      severity: null,
    });
  });

  it("sends the open threads not already waiting on the agent, with the note", async () => {
    const slot = render({ send: () => ({ delivery: "queued", count: 3 }) });
    fireEvent.click(await screen.findByRole("button", { name: /Send to agent/ }));
    fireEvent.change(await screen.findByPlaceholderText("An overall note for the agent (optional)"), { target: { value: "Small diffs please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send 3" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "send")).toBe(true));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "send")!.input).toEqual({
      sessionId: "ses_1",
      threadId: "thr_1",
      reviewThreadIds: ["aaaaaa000001", "aaaaaa000002", "aaaaaa000003"],
      note: "Small diffs please",
    });
  });

  it("re-reads the threads when the workspace's channel says they changed, and reloads on a diff signal", async () => {
    const slot = render({ listThreads: () => ({ threads: [thread({ id: "cccccc000001", body: "From the agent's side" })] }) });
    await screen.findByText("Why three?");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "threads", sessionId: "ses_1" });
    await screen.findByText("From the agent's side");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(2));
  });

  it("says why there is nothing to review", async () => {
    renderSlot({ component: ReviewPanel }, { threadId: "thr_1", params: null }, { rpc: { getReview: () => ({ ok: false, message: "No workspace." }) } });
    await screen.findByText("No workspace.");
  });
});
