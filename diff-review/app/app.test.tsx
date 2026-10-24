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
import { ReviewHeaderAction } from "./header-action";
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
  runs: [],
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

/** VIEW with a second, uncommented file, and any more threads given. */
function withSecondFile(more: ReviewThread[] = []): Extract<ReviewView, { ok: true }> {
  const second = { ...VIEW.files[0]!, path: "src/b.ts", additions: 2, deletions: 1, patch: PATCH.replaceAll("src/a.ts", "src/b.ts") };
  return { ...VIEW, files: [...VIEW.files, second], threads: [...VIEW.threads, ...more] };
}

function render(rpc: Record<string, (input: never) => unknown> = {}) {
  return renderSlot(
    { component: ReviewPanel },
    { threadId: "thr_1", params: null },
    { rpc: { getReview: () => VIEW, ...rpc }, codeTheme: { mode: "dark", name: "pierre-dark" } },
  );
}

describe("the app", () => {
  it("registers the Review tab, a title-bar button and a palette command", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadPanelActions.map((action) => [action.id, action.title, action.layout])).toEqual([["review", "Review", "flush"]]);
    expect(app.threadHeaderActions.map((action) => [action.id, action.title])).toEqual([["review", "Review"]]);
  });

  it("opens the Review tab from the title-bar button", () => {
    const slot = renderSlot({ component: ReviewHeaderAction }, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false });
    fireEvent.click(screen.getByRole("button", { name: "Review this thread's changes" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "review" } }]);
  });
});

describe("the Review tab", () => {
  it("shows the diff with each thread where its code is now, whole-diff threads on top, and lost ones apart", async () => {
    const slot = render();
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(slot.inspection.rpcCalls[0]).toEqual({ method: "getReview", input: { threadId: "thr_1", target: { kind: "uncommitted" }, autoTarget: true } });

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
    fireEvent.change(screen.getByPlaceholderText(/^Leave a comment\. Markdown works/), { target: { value: "Rename b" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByText("Rename b");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "createThread")!.input).toEqual({
      sessionId: "ses_1",
      threadId: "thr_1",
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
    const slot = render({ listThreads: () => ({ threads: [thread({ id: "cccccc000001", body: "From the agent's side" })], runs: [] }) });
    await screen.findByText("Why three?");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "threads", sessionId: "ses_1" });
    await screen.findByText("From the agent's side");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(2));
  });

  it("loads the patches bb did not send, in one batch, without a tap", async () => {
    const unloaded = (path: string) => ({ ...VIEW.files[0]!, path, patch: null, loadMode: "on_demand" as const });
    const view = { ...VIEW, threads: [], files: [unloaded("src/a.ts"), unloaded("src/b.ts")] };
    const slot = renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getReview: () => view,
          loadPatches: (input: unknown) => ({
            patches: (input as { paths: string[] }).paths.map((path) => ({ path, patch: PATCH, truncated: false })),
          }),
        },
      },
    );
    await waitFor(() => expect(screen.getAllByTestId("patch")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "loadPatches").map((call) => call.input)).toEqual([
      { threadId: "thr_1", target: { kind: "uncommitted" }, paths: ["src/a.ts", "src/b.ts"] },
    ]);
  });

  it("offers to try again when a patch fails to load, and says why a file has no diff", async () => {
    const view = {
      ...VIEW,
      threads: [],
      files: [
        { ...VIEW.files[0]!, patch: null },
        { ...VIEW.files[0]!, path: "logo.png", patch: null, binary: true },
      ],
    };
    let fail = true;
    renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getReview: () => view,
          loadPatches: () => {
            if (fail) throw new Error("host offline");
            return { patches: [{ path: "src/a.ts", patch: PATCH, truncated: false }] };
          },
        },
      },
    );
    expect(await screen.findByText("Binary file; no line diff.")).toBeTruthy();
    const retry = await screen.findByRole("button", { name: "Try again" });
    fail = false;
    fireEvent.click(retry);
    await screen.findByTestId("patch");
  });

  it("keeps a folded file's header at the top when it is folded while scrolled part-way through", async () => {
    const second = { ...VIEW.files[0]!, path: "src/b.ts" };
    renderSlot({ component: ReviewPanel }, { threadId: "thr_1", params: null }, { rpc: { getReview: () => ({ ...VIEW, threads: [], files: [VIEW.files[0]!, second] }) } });
    await waitFor(() => expect(screen.getAllByTestId("patch")).toHaveLength(2));
    const section = document.querySelector('[data-file-path="src/a.ts"]') as HTMLElement;
    const root = section.parentElement!;
    // src/a.ts starts 300px above the scroll area's top: its sticky header is pinned, its lines scrolled past.
    root.scrollTop = 500;
    root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    section.getBoundingClientRect = () => ({ top: -200 }) as DOMRect;
    fireEvent.click(within(section).getByRole("button", { name: "Collapse file" }));
    expect(within(section).queryByTestId("patch")).toBeNull();
    expect(root.scrollTop).toBe(200);

    // A file whose header is in view folds without moving the view.
    const other = document.querySelector('[data-file-path="src/b.ts"]') as HTMLElement;
    other.getBoundingClientRect = () => ({ top: 150 }) as DOMRect;
    fireEvent.click(within(other).getByRole("button", { name: "Collapse file" }));
    expect(root.scrollTop).toBe(200);
  });

  it("opens on the branch's commits when the server finds nothing uncommitted, and asks only once", async () => {
    const slot = renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getReview: (input: unknown) => {
            const { autoTarget } = input as { autoTarget?: boolean };
            return autoTarget === true ? { ...VIEW, target: { kind: "branch", base: "main" } } : { ...VIEW, target: (input as { target: unknown }).target };
          },
        },
      },
    );
    await screen.findByText("Committed since main");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(2));
    // The first load may pick; every later one keeps the view, now the branch's.
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview").map((call) => call.input)).toEqual([
      { threadId: "thr_1", target: { kind: "uncommitted" }, autoTarget: true },
      { threadId: "thr_1", target: { kind: "branch", base: "main" } },
    ]);
  });

  it("never picks for a tab opened on a chosen view", async () => {
    const slot = renderSlot({ component: ReviewPanel }, { threadId: "thr_1", params: { target: { kind: "uncommitted" } } }, { rpc: { getReview: () => VIEW } });
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(slot.inspection.rpcCalls[0]!.input).toEqual({ threadId: "thr_1", target: { kind: "uncommitted" } });
  });

  it("reloads once when the connection comes back, and not on the first connection", async () => {
    const slot = renderSlot({ component: ReviewPanel }, { threadId: "thr_1", params: null }, { rpc: { getReview: () => VIEW } });
    await screen.findByText("Why three?");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(2));
  });

  it("lists the AI runs, with the files a review changed, and closes one", async () => {
    const run = {
      id: "run000000001",
      sessionId: "ses_1",
      kind: "review" as const,
      threadId: "thr_run",
      reviewThreadId: null,
      focus: "Security",
      providerId: "claude-code",
      model: "big",
      status: "done" as const,
      summary: "1 must-fix",
      changedFiles: ["src/a.ts"],
      createdAt: 1,
      finishedAt: 2,
    };
    const slot = renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", params: null },
      { rpc: { getReview: () => ({ ...VIEW, runs: [run] }), closeRun: () => ({ ok: true }) } },
    );
    const row = (await screen.findByText("AI review · Security")).closest("li")!;
    expect(within(row).getByText("Files changed in this workspace while it ran: src/a.ts")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Open thread" }));
    expect(slot.inspection.navigateCalls[0]).toMatchObject({ method: "toThread", threadId: "thr_run" });
    fireEvent.click(within(row).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("AI review · Security")).toBeNull());
    expect(slot.inspection.rpcCalls.find((call) => call.method === "closeRun")!.input).toEqual({ runId: "run000000001" });
  });

  it("starts an AI review with the chosen focus and the default agent", async () => {
    const execution = { providerId: "claude-code", model: "big", reasoningLevel: "high" };
    const slot = render({
      runDefaults: () => ({ execution, message: null, permissionMode: "auto" }),
      startReview: () => ({
        run: { id: "run1", sessionId: "ses_1", kind: "review", threadId: "thr_run", reviewThreadId: null, focus: "Security", providerId: "claude-code", model: "big", status: "running", summary: null, changedFiles: null, createdAt: 1, finishedAt: null },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Security" }));
    await screen.findByText(/in Approve for me mode/);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start review" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    await screen.findByText("AI review · Security");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "startReview")!.input).toEqual({ sessionId: "ses_1", threadId: "thr_1", focuses: ["Security"], instructions: "", execution });
  });

  it("sends to a new thread when asked", async () => {
    const execution = { providerId: "claude-code", model: "big", reasoningLevel: "high" };
    const slot = render({
      runDefaults: () => ({ execution, message: null, permissionMode: "auto" }),
      fixInNewThread: () => ({
        count: 3,
        run: { id: "run2", sessionId: "ses_1", kind: "fix", threadId: "thr_fix", reviewThreadId: null, focus: null, providerId: "claude-code", model: "big", status: "running", summary: null, changedFiles: null, createdAt: 1, finishedAt: null },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Send to agent/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "A new thread…" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Start a thread with 3" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start a thread with 3" }));
    await screen.findByText("Fixes in a new thread");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "fixInNewThread")!.input).toEqual({
      sessionId: "ses_1",
      threadId: "thr_1",
      reviewThreadIds: ["aaaaaa000001", "aaaaaa000002", "aaaaaa000003"],
      note: "",
      execution,
    });
    expect(slot.inspection.rpcCalls.some((call) => call.method === "send")).toBe(false);
  });

  it("counts each file's comment threads, open and closed, in its header", async () => {
    render({ getReview: () => withSecondFile([thread({ id: "aaaaaa000005", body: "Done", status: "resolved" })]) });
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    const counts = screen.getAllByRole("img", { name: /comment thread/ });
    expect(counts.map((count) => count.getAttribute("aria-label"))).toEqual(["4 comment threads: 3 open, 1 resolved or dismissed"]);
    expect(counts[0]!.textContent).toBe("3 open·1 closed");
  });

  it("shows only the files with comments when the switch is on, and remembers it", async () => {
    render({ getReview: () => withSecondFile() });
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    expect(screen.getByText("src/b.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Only files with comments" }));
    await screen.findByText("1 of 2 files · +1 −1 · 1 left out by the ignore patterns");
    expect(screen.queryByText("src/b.ts")).toBeNull();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    // With the switch on every file shown has comments, so the headers drop the count.
    expect(screen.queryByRole("img", { name: /comment thread/ })).toBeNull();
    expect(window.localStorage.getItem("diff-review:only-commented")).toBe("true");

    cleanup();
    render({ getReview: () => withSecondFile() });
    await screen.findByText("1 of 2 files · +1 −1 · 1 left out by the ignore patterns");
    expect(screen.getByRole("switch", { name: "Only files with comments" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("switch", { name: "Only files with comments" }));
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    expect(window.localStorage.getItem("diff-review:only-commented")).toBe("false");
  });

  it("says so when the switch is on and no file has comments", async () => {
    window.localStorage.setItem("diff-review:only-commented", "true");
    // A comment on the whole diff is on no file: it stays, and no file is shown.
    render({ getReview: () => ({ ...withSecondFile(), threads: VIEW.threads.filter((entry) => entry.filePath === "__general__") }) });
    await screen.findByText('No file in this view has comments. Turn off "Only files with comments" to see all 2 files.');
    expect(screen.getByText("0 of 2 files · +0 −0 · 1 left out by the ignore patterns")).toBeTruthy();
    expect(screen.getByText("Add tests for this change")).toBeTruthy();
    expect(screen.queryByText("src/a.ts")).toBeNull();
  });

  it("clears the whole review after a confirm that says it can't be undone", async () => {
    const run = { id: "run000000001", sessionId: "ses_1", kind: "review" as const, threadId: "thr_run", reviewThreadId: null, focus: null, providerId: "claude-code", model: "big", status: "done" as const, summary: null, changedFiles: null, createdAt: 1, finishedAt: 2 };
    let cleared = false;
    const slot = renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getReview: () => ({ ...VIEW, runs: [run] }),
          clearReview: () => {
            cleared = true;
            return { deletedThreads: 4, closedRuns: 1 };
          },
          listThreads: () => (cleared ? { threads: [], runs: [] } : { threads: VIEW.threads, runs: [run] }),
        },
      },
    );
    await screen.findByText("Why three?");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    // Cancel keeps everything.
    fireEvent.click(screen.getByRole("button", { name: "Clear review" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This deletes 4 comment threads in this view, yours and the AI's, open or closed, and closes 1 AI run, archiving its thread in bb. It can't be undone.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(slot.inspection.rpcCalls.some((call) => call.method === "clearReview")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Clear review" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear review" }));
    await waitFor(() => expect(screen.queryByText("Why three?")).toBeNull());
    expect(slot.inspection.rpcCalls.find((call) => call.method === "clearReview")!.input).toEqual({ sessionId: "ses_1" });
    expect(screen.queryByRole("listitem")).toBeNull(); // the run's row
    expect(screen.queryByText("About the whole diff")).toBeNull();
    // With nothing left there is nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear review" })).toBeNull();
    expect(screen.getByTestId("patch")).toBeTruthy();
  });

  it("offers no clear before the view has comments or runs", async () => {
    render({ getReview: () => ({ ...VIEW, threads: [] }) });
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(screen.queryByRole("button", { name: "Clear review" })).toBeNull();
  });

  it("says why there is nothing to review", async () => {
    renderSlot({ component: ReviewPanel }, { threadId: "thr_1", params: null }, { rpc: { getReview: () => ({ ok: false, message: "No workspace." }) } });
    await screen.findByText("No workspace.");
  });
});
