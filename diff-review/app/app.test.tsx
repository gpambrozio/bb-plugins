// @vitest-environment jsdom
/**
 * The Review tab against a recorded RPC backend. `@pierre/diffs` is bb's at run time and needs a
 * highlighter jsdom does not have, so a stand-in renders each annotation through the tab's own
 * `renderAnnotation` and offers the gutter "+" as a button.
 */
import { act, cleanup, fireEvent, render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewThread, ReviewView, ViewState } from "../shared/types";
import { ANNOTATION_FIT } from "./annotation-fit";
import { RangeDialog } from "./range-dialog";
import { fromPicker, pickerValue, ReviewPanel } from "./review-panel";
import { dispatchReviewCommand, forgetReviewCommands } from "./commands";
import { forgetViewStates } from "./view-state";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/** What the stand-in saw: each render's patch and annotations array, and how many times one mounted. */
const pierre = vi.hoisted(() => ({ renders: [] as { patch: string; annotations: unknown }[], mounts: 0 }));

vi.mock("@pierre/diffs/react", async () => {
  const { useEffect } = await import("react");
  return {
  File: (props: {
    file: { name: string; contents: string };
    lineAnnotations: { lineNumber: number; metadata: unknown }[];
    renderAnnotation(annotation: unknown): ReactNode;
    options: { onGutterUtilityClick(range: { start: number; end: number; side: string }): void };
  }) => (
    <div data-testid="file" data-name={props.file.name} data-contents={props.file.contents}>
      <button type="button" onClick={() => props.options.onGutterUtilityClick({ start: 1, end: 1, side: "additions" })}>
        file gutter +
      </button>
      {props.lineAnnotations.map((annotation) => (
        <div key={annotation.lineNumber} data-testid={`file-annotation-${annotation.lineNumber}`}>
          {props.renderAnnotation(annotation)}
        </div>
      ))}
    </div>
  ),
  PatchDiff: (props: {
    patch: string;
    lineAnnotations: { side: string; lineNumber: number; metadata: unknown }[];
    renderAnnotation(annotation: unknown): ReactNode;
    options: { onGutterUtilityClick(range: { start: number; end: number; side: string }): void };
    selectedLines?: { start: number; side?: string } | null;
  }) => {
    pierre.renders.push({ patch: props.patch, annotations: props.lineAnnotations });
    useEffect(() => {
      pierre.mounts += 1;
    }, []);
    return (
    <div data-testid="patch" data-patch={props.patch} data-selected={props.selectedLines === null || props.selectedLines === undefined ? "" : `${props.selectedLines.side}:${props.selectedLines.start}`}>
      <button type="button" onClick={() => props.options.onGutterUtilityClick({ start: 1, end: 2, side: "additions" })}>
        gutter +
      </button>
      {props.lineAnnotations.map((annotation) => (
        <div key={`${annotation.side}:${annotation.lineNumber}`} data-testid={`annotation-${annotation.side}-${annotation.lineNumber}`}>
          {props.renderAnnotation(annotation)}
        </div>
      ))}
    </div>
    );
  },
  };
});

afterEach(() => {
  cleanup();
  pierre.renders.length = 0;
  pierre.mounts = 0;
  vi.clearAllMocks();
  window.localStorage.clear();
  forgetViewStates();
  forgetReviewCommands();
});

const ENVIRONMENT = { id: "env_1" };

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
    fileRevision: null,
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
  mergeBaseRef: null,
  headRef: null,
  viewable: true,
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
      revision: "rev-a",
      viewed: "no",
      patch: PATCH,
      patchTruncated: false,
    },
  ],
  ignoredPaths: ["package-lock.json"],
  truncated: false,
  runs: [],
  viewState: null,
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

function render(rpc: Record<string, (input: never) => unknown> = {}, threadId = "thr_1", options: { tabVisible?: boolean } = {}) {
  return renderSlot(
    { component: ReviewPanel },
    { threadId, environment: ENVIRONMENT, params: null },
    { rpc: { getReview: () => VIEW, ...rpc }, codeTheme: { mode: "dark", name: "pierre-dark" }, ...options },
  );
}

const loadsOf = (slot: ReturnType<typeof render>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "getReview").map((call) => call.input as { reason: string; ignoreWhitespace?: boolean; target?: unknown });

describe("the app", () => {
  it("registers the Review tab and one Review button of its own in the thread's header", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.tabs.map((tab) => [tab.id, tab.context, tab.availability, tab.title, tab.layout])).toEqual([["review", { kind: "thread" }, "action", "Review", "flush"]]);
    // bb 0.48 folds every plugin's header thread action into one shared split button; the old slot
    // draws Review as its own control, so Review registers there and nowhere else.
    expect(app.threadHeaderActions.map((action) => [action.id, action.title])).toEqual([["review", "Review"]]);
    expect(app.threadActions).toEqual([]);
  });

  it("opens and closes the Review tab through bb's panel controller from the header button", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, { experimental_panel: { toggleTab: () => true } });
    fireEvent.click(screen.getByRole("button", { name: "Review this thread's changes" }));
    expect(slot.inspection.experimental_panelCalls).toEqual([{ method: "toggleTab", options: { tab: { id: "review", context: { kind: "thread" }, availability: "action" } } }]);
  });

  it("falls back to a header thread action on a bb without the old header slot, still one control", async () => {
    const actions: { id: string; placement?: string; item(context: unknown): { label: string; run(context: unknown): unknown } | null }[] = [];
    const definition = (await import("../app")).default as unknown as { setup(builder: unknown): void };
    const slots = new Proxy({} as Record<string, unknown>, {
      get: (_target, name) => (name === "experimental_threadAction" ? (action: (typeof actions)[number]) => actions.push(action) : name === "experimental_threadHeaderAction" ? undefined : () => undefined),
    });
    definition.setup({ slots, commands: { register: () => undefined }, composer: { customize: () => undefined } });
    expect(actions.map((action) => [action.id, action.placement])).toEqual([["review", "header"]]);
    const calls: unknown[] = [];
    const panel = { openTab: (options: unknown) => (calls.push(options), true), toggleTab: () => true, close: () => true };
    const action = actions[0]!.item({ thread: { id: "thr_1" }, data: undefined, experimental_panel: panel })!;
    expect(action.label).toBe("Review");
    await action.run({ requestRename: () => undefined });
    expect(calls).toEqual([{ tab: { id: "review", context: { kind: "thread" }, availability: "action" } }]);
  });
});

describe("the palette's commands, find and Go to", () => {
  it("registers a palette command per action, each opening the Review tab and acting there", async () => {
    // loadPluginApp does not capture commands; run the definition against a stub builder instead.
    const registered: { id: string; title: string; run(context: unknown): void }[] = [];
    const definition = (await import("../app")).default as unknown as { setup(builder: unknown): void };
    const slots = new Proxy({}, { get: () => () => undefined });
    definition.setup({ slots, commands: { register: (command: (typeof registered)[number]) => registered.push(command) }, composer: { customize: () => undefined } });
    expect(registered.map((command) => command.id)).toContain("find");
    expect(registered.find((command) => command.id === "send")!.title).toBe("Diff Review: send comments to the agent");
    const calls: unknown[] = [];
    registered.find((command) => command.id === "go-to")!.run({ threadId: "thr_1", projectId: null, experimental_panel: { openTab: (options: unknown) => (calls.push(options), true) } });
    expect(calls).toEqual([{ tab: { id: "review", context: { kind: "thread" }, availability: "action" } }]);
  });

  it("takes a command left for it before the tab showed, and opens what it names", async () => {
    dispatchReviewCommand("thr_1", "go-to");
    render();
    expect(await screen.findByRole("dialog", { name: "Go to" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter" }), { target: { value: "file a.ts" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Filesrc/a.ts+1 −1"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter" }), { target: { value: "comment three" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["CommentWhy three?src/a.ts:5 (new side)"]);
  });

  it("finds across the diff and selects each match's line", async () => {
    render();
    await screen.findByTestId("patch");
    fireEvent.click(screen.getByRole("button", { name: "Find in the diff" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in the diff" }), { target: { value: "const b" } });
    expect(await screen.findByText("1 of 2")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("patch").getAttribute("data-selected")).toBe("deletions:2"));
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("2 of 2")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("patch").getAttribute("data-selected")).toBe("additions:2"));
  });

  it("steps through the open comments from the palette", async () => {
    render();
    await screen.findByTestId("patch");
    // The whole-diff thread comes first, then the file's: one no longer on the diff (at its header),
    // then the line threads in line order.
    await act(async () => dispatchReviewCommand("thr_1", "next-comment"));
    await act(async () => dispatchReviewCommand("thr_1", "next-comment"));
    expect(screen.getByTestId("patch").getAttribute("data-selected")).toBe("");
    await act(async () => dispatchReviewCommand("thr_1", "next-comment"));
    await waitFor(() => expect(screen.getByTestId("patch").getAttribute("data-selected")).toBe("additions:2"));
  });
});

describe("changing the workspace from the tab", () => {
  const suggesting = thread({ id: "aaaaaa000010", body: "Four is better:\n```suggestion\nconst b = 4;\n```", startLine: 2, endLine: 2 });

  it("shows a suggested change and applies it to the working copy", async () => {
    const slot = render({
      getReview: () => ({ ...VIEW, threads: [suggesting] }),
      applySuggestion: () => ({ thread: { ...suggesting, status: "resolved" } }),
    });
    expect(await screen.findByText("Suggested change")).toBeTruthy();
    expect(screen.getByText("Four is better:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply suggestion" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "applySuggestion")).toBe(true));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "applySuggestion")!.input).toEqual({
      threadId: "thr_1",
      reviewThreadId: "aaaaaa000010",
      commentId: "c_aaaaaa000010",
      startLine: 2,
      endLine: 2,
      expected: "const b = 3;",
      code: "const b = 4;",
    });
    // The view reloads, since a file changed.
    await waitFor(() => expect(loadsOf(slot).map((load) => load.reason)).toContain("manual"));
  });

  it("offers no Apply in a view whose new side is not the working copy", async () => {
    render({ getReview: () => ({ ...VIEW, target: { kind: "commit", sha: "abcdef1" }, threads: [suggesting] }) });
    expect(await screen.findByText("Suggested change")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply suggestion" })).toBeNull();
  });

  it("inserts a suggestion block seeded with the commented lines", async () => {
    render({ getReview: () => ({ ...VIEW, threads: [] }) });
    fireEvent.click(await screen.findByText("gutter +"));
    fireEvent.click(screen.getByRole("button", { name: "Suggest a change" }));
    expect((screen.getByPlaceholderText(/^Leave a comment\. Markdown works/) as HTMLTextAreaElement).value).toBe("```suggestion\nconst a = 1;\nconst b = 3;\n```");
  });

  it("reverts a file of the uncommitted view after asking", async () => {
    const slot = render({ revertChanges: () => ({ ok: true }) });
    fireEvent.click(await screen.findByRole("button", { name: "Revert src/a.ts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revert the whole file to its last commit" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "revertChanges")?.input).toEqual({ threadId: "thr_1", path: "src/a.ts", revision: "rev-a", hunks: null }));
  });
});

describe("explanations", () => {
  const run = { id: "run_1", sessionId: "ses_1", kind: "explain", threadId: "thr_run", reviewThreadId: null, focus: "src/a.ts", providerId: "claude-code", model: null, status: "running", summary: null, changedFiles: null, createdAt: 1, finishedAt: null };

  it("asks an agent to explain a file, and lists the run", async () => {
    const slot = render({ startExplain: () => ({ run }) });
    fireEvent.click(await screen.findByRole("button", { name: "Explain src/a.ts" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "startExplain")?.input).toEqual({ sessionId: "ses_1", threadId: "thr_1", filePath: "src/a.ts", side: null, startLine: 0, endLine: 0, code: null }));
    expect(await screen.findByText("Explain · src/a.ts")).toBeTruthy();
  });

  it("asks it to explain the lines a new comment is on", async () => {
    const slot = render({ startExplain: () => ({ run }) });
    fireEvent.click(await screen.findByText("gutter +"));
    fireEvent.click(screen.getByRole("button", { name: "Ask AI to explain these lines" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "startExplain")?.input).toMatchObject({ filePath: "src/a.ts", side: "new", startLine: 1, endLine: 2, code: "const a = 1;\nconst b = 3;" }),
    );
  });
});

describe("the staged, unstaged and range views", () => {
  it("picks a range in the range dialog, as git writes it", async () => {
    const picked: unknown[] = [];
    renderPlain(<RangeDialog open onOpenChange={() => undefined} initial="main...HEAD" onPick={(range) => picked.push(range)} />);
    const input = await screen.findByRole("textbox", { name: "Range" });
    expect((input as HTMLInputElement).value).toBe("main...HEAD");
    fireEvent.change(input, { target: { value: "-x..y" } });
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "v1..v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(picked).toEqual([{ kind: "range", from: "v1", to: "v2", symmetric: false }]);
  });

  it("round-trips each view through the picker's values", () => {
    for (const target of [{ kind: "staged" }, { kind: "unstaged" }, { kind: "range", from: "a", to: "b", symmetric: true }, { kind: "commit", sha: "abcdef1" }] as const) {
      expect(fromPicker(pickerValue(target))).toEqual(target);
    }
  });

  it("offers no Viewed marks where bb has none", async () => {
    render({ getReview: () => ({ ...VIEW, target: { kind: "staged" }, viewable: false }) });
    await screen.findByTestId("patch");
    expect(screen.queryByRole("checkbox", { name: "Viewed src/a.ts" })).toBeNull();
  });
});

describe("the Files view", () => {
  const FILES = { ...VIEW, target: { kind: "files" as const }, files: [], viewable: false, threads: [thread({ id: "aaaaaa000020", body: "Odd name", filePath: "src/util.ts", startLine: 1, endLine: 1, anchorContent: "export const x = 1;" })] };

  it("lists files with comments, opens one with its threads, and comments on its lines", async () => {
    const slot = render({
      getReview: () => FILES,
      readFile: () => ({ path: "src/util.ts", content: "export const x = 1;\n", reason: null, revision: "sha-1" }),
      createThread: (input: never) => ({ thread: thread({ id: "aaaaaa000021", body: (input as { body: string }).body, filePath: "src/util.ts", startLine: 1, endLine: 1 }) }),
    });
    expect(screen.queryByRole("button", { name: "AI review" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /src\/util\.ts.*1 comment thread/ }));
    expect(await screen.findByTestId("file")).toBeTruthy();
    expect(within(screen.getByTestId("file-annotation-1")).getByText("Odd name")).toBeTruthy();
    fireEvent.click(screen.getByText("file gutter +"));
    fireEvent.change(screen.getByPlaceholderText(/^Leave a comment\. Markdown works/), { target: { value: "Rename x" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.find((call) => call.method === "createThread")?.input).toMatchObject({
        filePath: "src/util.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        anchorContent: "export const x = 1;",
        body: "Rename x",
        fileRevision: "sha-1",
      }),
    );
  });

  it("reads the open file again on Reload and on a workspace change, keeping its draft", async () => {
    let contents = "export const x = 1;\n";
    const slot = render({ getReview: () => FILES, readFile: () => ({ path: "src/util.ts", content: contents, reason: null, revision: `sha-${contents.length}-${contents}` }) });
    fireEvent.click(await screen.findByRole("button", { name: /src\/util\.ts.*1 comment thread/ }));
    await waitFor(() => expect(screen.getByTestId("file").getAttribute("data-contents")).toBe("export const x = 1;\n"));
    fireEvent.click(screen.getByText("file gutter +"));
    fireEvent.change(screen.getByPlaceholderText(/^Leave a comment\. Markdown works/), { target: { value: "Half written" } });

    contents = "export const x = 2;\n";
    fireEvent.click(screen.getByRole("button", { name: "Reload the diff" }));
    await waitFor(() => expect(screen.getByTestId("file").getAttribute("data-contents")).toBe("export const x = 2;\n"));
    expect((screen.getByPlaceholderText(/^Leave a comment\. Markdown works/) as HTMLTextAreaElement).value).toBe("Half written");

    contents = "export const x = 3;\n";
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await waitFor(() => expect(screen.getByTestId("file").getAttribute("data-contents")).toBe("export const x = 3;\n"));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "readFile")).toHaveLength(3);
  });

  it("searches the workspace for a file", async () => {
    const slot = render({ getReview: () => ({ ...FILES, threads: [] }), searchFiles: () => ({ paths: ["lib/a.ts"], truncated: false }) });
    fireEvent.change(await screen.findByRole("textbox", { name: "Find a file" }), { target: { value: "a.ts" } });
    expect(await screen.findByRole("button", { name: "lib/a.ts" })).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((call) => call.method === "searchFiles")!.input).toEqual({ threadId: "thr_1", query: "a.ts" });
  });
});

describe("keeping the Review tab current", () => {
  it("holds the workspace's watch while it shows, and gives it back when it goes", async () => {
    const leases = () => slot.inspection.rpcCalls.filter((call) => call.method === "watchWorkspace").map((call) => (call.input as { active: boolean; view: string }));
    const slot = render({ watchWorkspace: () => ({ ok: true }) });
    await waitFor(() => expect(leases()).toEqual([{ threadId: "thr_1", tab: expect.any(String), view: "uncommitted", active: true }]));
    slot.lifecycle.unmount();
    await waitFor(() => expect(leases().at(-1)).toMatchObject({ active: false }));
    cleanup();
    const hidden = render({ watchWorkspace: () => ({ ok: true }) }, "thr_1", { tabVisible: false });
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(hidden.inspection.rpcCalls.some((call) => call.method === "watchWorkspace")).toBe(false);
  });

  it("leaves a hidden tab alone: no reload on a signal", async () => {
    const slot = render({}, "thr_1", { tabVisible: false });
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadsOf(slot).map((load) => load.reason)).toEqual(["open"]);
  });

  it("hears the workspace's signals from the first render, before the view has loaded", async () => {
    let answer!: (view: unknown) => void;
    let loads = 0;
    const slot = render({ getReview: () => (++loads === 1 ? new Promise((resolve) => (answer = resolve)) : VIEW) });
    await waitFor(() => expect(answer).toBeDefined());
    // A signal during the first load runs one more load after it.
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    answer(VIEW);
    await waitFor(() => expect(loadsOf(slot).map((load) => load.reason)).toEqual(["open", "diff-signal"]));
  });

  it("hides whitespace-only changes when asked, and remembers it", async () => {
    const slot = render();
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    fireEvent.click(screen.getByRole("switch", { name: "Hide whitespace" }));
    await waitFor(() => expect(loadsOf(slot).at(-1)).toMatchObject({ reason: "whitespace", ignoreWhitespace: true }));
    expect(window.localStorage.getItem("diff-review:ignore-whitespace")).toBe("true");
  });
});

describe("the Review tab", () => {
  it("shows the diff with each thread where its code is now, whole-diff threads on top, and lost ones apart", async () => {
    const slot = render();
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(slot.inspection.rpcCalls[0]).toEqual({ method: "getReview", input: { threadId: "thr_1", target: { kind: "uncommitted" }, reason: "open", tab: expect.any(String), autoTarget: true } });

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

  it("fits every comment box in the diff to the pane's width, so a long line in it never widens the code", async () => {
    render();
    fireEvent.click(await screen.findByText("gutter +"));
    fireEvent.click(within(screen.getByTestId("patch")).getAllByRole("button", { name: "Reply" })[0]!);
    const annotations = screen.getAllByTestId(/^annotation-/);
    // An existing thread (with its reply box open) and the new comment's box.
    expect(annotations.some((annotation) => annotation.querySelector("[data-thread-id] textarea") !== null)).toBe(true);
    expect(annotations.some((annotation) => within(annotation).queryByText("New comment on lines 1–2 (new side)") !== null)).toBe(true);
    for (const annotation of annotations) {
      const box = annotation.firstElementChild as HTMLElement;
      expect(box.dataset.annotationFit).toBe("");
      expect(box.className).toBe(ANNOTATION_FIT);
    }
    expect(ANNOTATION_FIT.split(" ")).toEqual(["[contain:inline-size]", "[overflow-wrap:anywhere]", "[&_pre]:overflow-x-auto"]);
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
      fileRevision: "rev-a",
    });
  });

  it("marks a file Viewed through bb's marks, folding it, and says when a viewed file changed", async () => {
    const slot = render({ setViewed: () => ({ ok: true }) });
    await screen.findByTestId("patch");
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed src/a.ts" }));
    await waitFor(() => expect(screen.queryByTestId("patch")).toBeNull());
    expect(slot.inspection.rpcCalls.find((call) => call.method === "setViewed")!.input).toEqual({
      threadId: "thr_1",
      target: { kind: "uncommitted" },
      path: "src/a.ts",
      revision: "rev-a",
      viewed: true,
    });
    cleanup();
    forgetViewStates();

    render({ getReview: () => ({ ...VIEW, files: [{ ...VIEW.files[0]!, viewed: "changed" }] }) });
    expect(await screen.findByText("changed since viewed")).toBeTruthy();
    expect(screen.getByTestId("patch")).toBeTruthy();
  });

  it("draws added and removed lines in blue and orange with the colour-blind setting", async () => {
    renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
      { rpc: { getReview: () => VIEW }, codeTheme: { mode: "dark", name: "pierre-dark" }, settings: { colorBlindDiffs: true } },
    );
    const wrapper = (await screen.findByTestId("patch")).parentElement!;
    expect(wrapper.getAttribute("data-diff-palette")).toBe("colorblind");
    expect(wrapper.style.getPropertyValue("--diffs-addition-color-override")).toBe("#58a6ff");
    expect(wrapper.style.getPropertyValue("--diffs-deletion-color-override")).toBe("#f0883e");
  });

  it("starts a file viewed at its current revision folded", async () => {
    render({ getReview: () => ({ ...VIEW, files: [{ ...VIEW.files[0]!, viewed: "yes" }] }) });
    await screen.findByRole("checkbox", { name: "Viewed src/a.ts" });
    expect(screen.queryByTestId("patch")).toBeNull();
  });

  it("opens a file in bb's preview at the version the view shows", async () => {
    const opened: unknown[] = [];
    const slot = renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
      { rpc: { getReview: () => ({ ...VIEW, target: { kind: "commit", sha: "abcdef1" } }) }, openFilePreview: (options) => (opened.push(options), true) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open src/a.ts" }));
    expect(opened).toEqual([{ target: { kind: "workspace", environmentId: "env_1", path: "src/a.ts", experimental_ref: "abcdef1" }, location: null }]);
    expect(slot).toBeTruthy();
  });

  it("notes a comment whose file changed since it was made", async () => {
    render({ getReview: () => ({ ...VIEW, threads: [thread({ id: "aaaaaa000009", body: "Hm", fileRevision: "rev-old" })] }) });
    expect(await screen.findByText("File changed since this comment")).toBeTruthy();
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

  describe("an agent's answer arriving", () => {
    const PATCH_B = PATCH.replaceAll("src/a.ts", "src/b.ts");
    /** What the RPC returns, as the wire does: a fresh copy each time. */
    const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const onB = thread({ id: "bbbbbb000009", body: "Untouched", filePath: "src/b.ts" });
    const twoFiles = { ...VIEW, files: [VIEW.files[0]!, { ...VIEW.files[0]!, path: "src/b.ts", patch: PATCH_B }], threads: [...VIEW.threads, onB] };
    const annotationsOf = (patch: string) => new Set(pierre.renders.filter((entry) => entry.patch === patch).map((entry) => entry.annotations));

    it("updates only the answered thread in place: no reload, no remount, other files' diffs untouched", async () => {
      const answered = fresh(twoFiles.threads);
      answered[0]!.comments.push({ id: "c_reply", authorType: "agent", authorName: "Claude Code", body: "Because b changed.", createdAt: 2, editedAt: null });
      const slot = render({ getReview: () => fresh(twoFiles), listThreads: () => ({ threads: fresh(answered), runs: [] }) });
      await waitFor(() => expect(screen.getAllByTestId("patch")).toHaveLength(2));
      await waitFor(() => expect(pierre.mounts).toBe(2));
      const mounts = pierre.mounts;
      const before = { a: annotationsOf(PATCH), b: annotationsOf(PATCH_B) };
      expect(before.b.size).toBe(1);

      await slot.behavior.emitRealtime("environment:env_1", { kind: "threads", sessionId: "ses_1" });
      await screen.findByText("Because b changed.");
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(1);
      expect(pierre.mounts).toBe(mounts);
      // src/b.ts's thread did not change: its diff is handed the very same annotations, so Pierre leaves it be.
      expect(annotationsOf(PATCH_B)).toEqual(before.b);
      expect(screen.queryByText("Loading the diff…")).toBeNull();
    });

    it("reloads a changed diff in place: unchanged files keep their diffs, and loaded patches stay up while they reload", async () => {
      const onDemand = { ...VIEW.files[0]!, path: "src/big.ts", patch: null, loadMode: "on_demand" as const };
      const BIG = PATCH.replaceAll("src/a.ts", "src/big.ts");
      const view = { ...VIEW, threads: [], files: [VIEW.files[0]!, onDemand] };
      let answer: ((value: unknown) => void) | null = null;
      let loads = 0;
      const slot = render({
        getReview: () => fresh(view),
        loadPatches: () =>
          ++loads === 1 ? { patches: [{ path: "src/big.ts", patch: BIG, truncated: false }] } : new Promise((resolve) => (answer = resolve)),
      });
      await waitFor(() => expect(screen.getAllByTestId("patch").map((node) => node.getAttribute("data-patch"))).toEqual([PATCH, BIG]));
      // Both diffs drawn and mounted (a mount's effect can trail its render) before the baseline is taken.
      await waitFor(() => expect(pierre.mounts).toBe(2));
      const mounts = pierre.mounts;
      const before = annotationsOf(PATCH);

      await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
      await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(2));
      await waitFor(() => expect(answer).not.toBeNull());
      // While the on-demand patch reloads, the one already shown stays: no "Loading the diff…" flash.
      expect(screen.queryByText("Loading the diff…")).toBeNull();
      expect(screen.getAllByTestId("patch").map((node) => node.getAttribute("data-patch"))).toEqual([PATCH, BIG]);
      expect(pierre.mounts).toBe(mounts);
      expect(annotationsOf(PATCH)).toEqual(before);

      const NEWER = BIG.replace("const b = 3;", "const b = 4;");
      answer!({ patches: [{ path: "src/big.ts", patch: NEWER, truncated: false }] });
      await waitFor(() => expect(screen.getAllByTestId("patch")[1]!.getAttribute("data-patch")).toBe(NEWER));
    });
  });

  it("loads the patches bb did not send, in one batch, without a tap", async () => {
    const unloaded = (path: string) => ({ ...VIEW.files[0]!, path, revision: `rev-${path}`, patch: null, loadMode: "on_demand" as const });
    const view = { ...VIEW, threads: [], files: [unloaded("src/a.ts"), unloaded("src/b.ts")] };
    const slot = renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
      {
        rpc: {
          getReview: () => view,
          loadPatches: (input: unknown) => ({
            patches: (input as { files: { path: string }[] }).files.map(({ path }) => ({ path, patch: PATCH, truncated: false })),
          }),
        },
      },
    );
    await waitFor(() => expect(screen.getAllByTestId("patch")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "loadPatches").map((call) => call.input)).toEqual([
      {
        threadId: "thr_1",
        target: { kind: "uncommitted" },
        files: [
          { path: "src/a.ts", revision: "rev-src/a.ts" },
          { path: "src/b.ts", revision: "rev-src/b.ts" },
        ],
      },
    ]);
  });

  it("drops a patch that arrives after the view was reloaded", async () => {
    const unloaded = { ...VIEW.files[0]!, patch: null, loadMode: "on_demand" as const };
    const stale = PATCH.replace("const b = 3;", "const b = 9;");
    let answer!: (value: unknown) => void;
    let loads = 0;
    renderSlot(
      { component: ReviewPanel },
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
      {
        rpc: {
          getReview: () => (++loads === 1 ? { ...VIEW, threads: [], files: [unloaded] } : { ...VIEW, threads: [] }),
          loadPatches: () => new Promise((resolve) => (answer = resolve)),
        },
      },
    );
    await screen.findByText("Loading the diff…");
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Reload the diff" }));
    await waitFor(() => expect(screen.getByTestId("patch").getAttribute("data-patch")).toBe(PATCH));
    answer({ patches: [{ path: "src/a.ts", patch: stale, truncated: false }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("patch").getAttribute("data-patch")).toBe(PATCH);
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
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
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
    renderSlot({ component: ReviewPanel }, { threadId: "thr_1", environment: ENVIRONMENT, params: null }, { rpc: { getReview: () => ({ ...VIEW, threads: [], files: [VIEW.files[0]!, second] }) } });
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
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
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
      { threadId: "thr_1", target: { kind: "uncommitted" }, reason: "open", tab: expect.any(String), autoTarget: true },
      { threadId: "thr_1", target: { kind: "branch", base: "main" }, reason: "diff-signal", tab: expect.any(String) },
    ]);
  });

  it("never picks for a tab opened on a chosen view", async () => {
    const slot = renderSlot({ component: ReviewPanel }, { threadId: "thr_1", environment: ENVIRONMENT, params: { target: { kind: "uncommitted" } } }, { rpc: { getReview: () => VIEW } });
    await screen.findByText("1 file · +1 −1 · 1 left out by the ignore patterns");
    expect(slot.inspection.rpcCalls[0]!.input).toEqual({ threadId: "thr_1", target: { kind: "uncommitted" }, reason: "open", tab: expect.any(String) });
  });

  it("runs one load for signals that arrive while a load is under way, and names each load's trigger", async () => {
    let answer: ((value: unknown) => void) | null = null;
    let loads = 0;
    const slot = render({ getReview: () => (++loads === 2 ? new Promise((resolve) => (answer = resolve)) : VIEW) });
    await screen.findByText("Why three?");
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await waitFor(() => expect(answer).not.toBeNull());
    // While that load runs, another signal and a reconnect: no second load beside it.
    await slot.behavior.emitRealtime("environment:env_1", { kind: "diff" });
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(2);
    // When it ends, one more load runs, for what may have changed meanwhile.
    answer!(VIEW);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview")).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "getReview").map((call) => (call.input as { reason: string }).reason)).toEqual(["open", "diff-signal", "reconnect"]);
  });

  it("reloads once when the connection comes back, and not on the first connection", async () => {
    const slot = renderSlot({ component: ReviewPanel }, { threadId: "thr_1", environment: ENVIRONMENT, params: null }, { rpc: { getReview: () => VIEW } });
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
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
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

  it("starts a summary from the AI review dialog", async () => {
    const execution = { providerId: "claude-code", model: "big", reasoningLevel: "high" };
    const slot = render({
      runDefaults: () => ({ execution, message: null, permissionMode: "auto" }),
      startSummary: () => ({
        run: { id: "run3", sessionId: "ses_1", kind: "summary", threadId: "thr_sum", reviewThreadId: null, focus: null, providerId: "claude-code", model: "big", status: "running", summary: null, changedFiles: null, createdAt: 1, finishedAt: null },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(screen.queryByRole("button", { name: "Security" })).toBeNull();
    await waitFor(() => expect((screen.getAllByRole("button", { name: "Summarize" }).at(-1) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByRole("button", { name: "Summarize" }).at(-1)!);
    await screen.findByText("Summary");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "startSummary")!.input).toEqual({ sessionId: "ses_1", threadId: "thr_1", execution });
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

  it("shows only the files with comments when the switch is on, and remembers it per thread", async () => {
    render({ getReview: () => withSecondFile() });
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    expect(screen.getByText("src/b.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Only files with comments" }));
    await screen.findByText("1 of 2 files · +1 −1 · 1 left out by the ignore patterns");
    expect(screen.queryByText("src/b.ts")).toBeNull();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    // With the switch on every file shown has comments, so the headers drop the count.
    expect(screen.queryByRole("img", { name: /comment thread/ })).toBeNull();

    // Another thread, one that never set the switch, starts with it off.
    cleanup();
    render({ getReview: () => withSecondFile() }, "thr_2");
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    expect(screen.getByRole("switch", { name: "Only files with comments" }).getAttribute("aria-checked")).toBe("false");

    // Back in the first thread, it is still on.
    cleanup();
    render({ getReview: () => withSecondFile() });
    await screen.findByText("1 of 2 files · +1 −1 · 1 left out by the ignore patterns");
    expect(screen.getByRole("switch", { name: "Only files with comments" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("switch", { name: "Only files with comments" }));
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    cleanup();
    render({ getReview: () => withSecondFile() });
    await screen.findByText("2 files · +3 −2 · 1 left out by the ignore patterns");
    expect(screen.getByRole("switch", { name: "Only files with comments" }).getAttribute("aria-checked")).toBe("false");
  });

  it("says so when the switch is on and no file has comments", async () => {
    window.localStorage.setItem("diff-review:only-commented:thr_1", "true");
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
      { threadId: "thr_1", environment: ENVIRONMENT, params: null },
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

  describe("leaving the tab and coming back", () => {
    type Slot = ReturnType<typeof render>;
    const lastSaved = (slot: Slot) => {
      const saves = slot.inspection.rpcCalls.filter((call) => call.method === "saveViewState");
      expect(saves.length).toBeGreaterThan(0);
      return (saves.at(-1)!.input as { state: ViewState }).state;
    };
    const renderWith = (viewState: ViewState | null, view: Partial<typeof VIEW> = {}) =>
      render({ getReview: () => ({ ...VIEW, ...view, viewState }), saveViewState: () => ({ ok: true }) });
    const type = (placeholder: RegExp, value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

    it("keeps every unsent comment as typed, with its editor open, until it is sent or cancelled", async () => {
      const first = renderWith(null);
      await screen.findByText("Why three?");
      fireEvent.click(screen.getByRole("button", { name: "Comment on the diff" }));
      type(/A comment about the whole change/, "Half a thought");
      fireEvent.click(screen.getByRole("button", { name: "Comment on file" }));
      type(/A comment about the whole file/, "File note");
      fireEvent.click(within(screen.getByTestId("patch")).getByRole("button", { name: "gutter +" }));
      type(/Leave a comment/, "Line note");
      const card = screen.getByText("Why three?").closest("[data-thread-id]") as HTMLElement;
      fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
      type(/^Reply/, "Not sure");
      fireEvent.click(within(card).getAllByRole("button", { name: "Edit" })[0]!);
      type(/Edit your comment/, "Why three, really?");

      // Leaving the tab writes at once; a restart starts from what was written.
      cleanup();
      const saved = lastSaved(first);
      expect(saved.drafts).toEqual({
        general: { body: "Half a thought", severity: null, range: null },
        "file:src/a.ts": { body: "File note", severity: null, range: null },
        "line:src/a.ts": { body: "Line note", severity: null, range: { side: "new", startLine: 1, endLine: 2 } },
        "reply:aaaaaa000001": { body: "Not sure", severity: null, range: null },
        "edit:c_aaaaaa000001": { body: "Why three, really?", severity: null, range: null },
      });
      forgetViewStates();

      const second = renderWith(saved);
      await screen.findByDisplayValue("Half a thought");
      expect(screen.getByDisplayValue("File note")).toBeTruthy();
      expect(screen.getByDisplayValue("Line note")).toBeTruthy();
      expect(screen.getByText("New comment on lines 1–2 (new side)")).toBeTruthy();
      expect(screen.getByDisplayValue("Not sure")).toBeTruthy();
      expect(screen.getByDisplayValue("Why three, really?")).toBeTruthy();

      // Cancelling drops a draft for good.
      fireEvent.keyDown(screen.getByDisplayValue("Half a thought"), { key: "Escape" });
      cleanup();
      expect(Object.keys(lastSaved(second).drafts).sort()).toEqual(["edit:c_aaaaaa000001", "file:src/a.ts", "line:src/a.ts", "reply:aaaaaa000001"]);
    });

    it("never hides a restored draft: its folded file opens, and lines gone from the diff put it above the diff", async () => {
      renderWith({
        drafts: { "line:src/a.ts": { body: "About old lines", severity: null, range: { side: "new", startLine: 7, endLine: 8 } } },
        collapsed: { "src/a.ts": true },
        scroll: null,
        savedAt: 1,
      });
      const composer = await screen.findByDisplayValue("About old lines");
      expect(screen.getByText("New comment on lines 7–8 (new side). Those lines are no longer in this diff.")).toBeTruthy();
      expect(within(screen.getByTestId("patch")).queryByDisplayValue("About old lines")).toBeNull();
      expect(composer.closest("section")!.querySelector('[aria-label="Collapse file"]')).toBeTruthy();
    });

    it("keeps a draft's text when its editor is opened again", async () => {
      const first = renderWith(null);
      await screen.findByText("Why three?");
      fireEvent.click(screen.getByRole("button", { name: "Comment on the diff" }));
      type(/A comment about the whole change/, "Keep this");
      fireEvent.click(screen.getByRole("button", { name: "Comment on the diff" }));
      fireEvent.click(within(screen.getByTestId("patch")).getByRole("button", { name: "gutter +" }));
      type(/Leave a comment/, "And this");
      fireEvent.click(within(screen.getByTestId("patch")).getByRole("button", { name: "gutter +" }));
      expect(screen.getByDisplayValue("Keep this")).toBeTruthy();
      expect(screen.getByDisplayValue("And this")).toBeTruthy();
      cleanup();
      expect(lastSaved(first).drafts).toMatchObject({ general: { body: "Keep this" }, "line:src/a.ts": { body: "And this" } });
    });

    it("lists unsent comments on files that left the view, where they can still be sent or cancelled", async () => {
      const slot = render({
        getReview: () => ({
          ...VIEW,
          viewState: {
            drafts: {
              "line:src/gone.ts": { body: "On gone lines", severity: null, range: { side: "new", startLine: 3, endLine: 3 } },
              "file:src/gone.ts": { body: "On the gone file", severity: null, range: null },
            },
            collapsed: {},
            scroll: null,
            savedAt: 1,
          },
        }),
        saveViewState: () => ({ ok: true }),
        createThread: (input: never) => ({ thread: thread({ id: "cccccc000001", body: (input as { body: string }).body, filePath: "src/gone.ts", side: null, startLine: 0, endLine: 0, anchorContent: null }) }),
      });
      const section = (await screen.findByText("Unsent comments on files not in this view")).parentElement!;
      expect(within(section).getByText("src/gone.ts")).toBeTruthy();
      expect(within(section).getByText("New comment on line 3 (new side). This file is not in this view any more.")).toBeTruthy();
      fireEvent.keyDown(within(section).getByDisplayValue("On gone lines"), { key: "Escape" });
      await waitFor(() => expect(within(section).queryByDisplayValue("On gone lines")).toBeNull());
      fireEvent.click(within(section).getByRole("button", { name: "Comment" }));
      await waitFor(() => expect(screen.queryByText("Unsent comments on files not in this view")).toBeNull());
      expect(slot.inspection.rpcCalls.find((call) => call.method === "createThread")!.input).toMatchObject({ filePath: "src/gone.ts", startLine: 0, body: "On the gone file" });
    });

    it("folds a thread as soon as it is dismissed, opens it again on a click, and keeps it as left", async () => {
      const dismissed = { ...VIEW.threads[0]!, status: "dismissed" as const };
      const first = render({ getReview: () => ({ ...VIEW, viewState: null }), setStatus: () => ({ thread: dismissed }), saveViewState: () => ({ ok: true }) });
      const card = (await screen.findByText("Why three?")).closest("[data-thread-id]") as HTMLElement;
      fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
      // The one-line folded form: a button with the first comment, no Reply.
      const folded = await screen.findByRole("button", { name: /Why three\?/ });
      expect(screen.queryByText("Why three?")?.closest("[data-thread-id]")).toBeFalsy();
      expect(first.inspection.rpcCalls.find((call) => call.method === "setStatus")!.input).toEqual({ reviewThreadId: "aaaaaa000001", status: "dismissed" });

      fireEvent.click(folded);
      const open = (await screen.findByText("Why three?")).closest("[data-thread-id]") as HTMLElement;
      expect(within(open).getByRole("button", { name: "Reopen" })).toBeTruthy();

      // Left open, it comes back open; folded again, it comes back folded.
      cleanup();
      const saved = lastSaved(first);
      expect(saved.expandedThreads).toEqual({ aaaaaa000001: true });
      forgetViewStates();
      const threads = [dismissed, ...VIEW.threads.slice(1)];
      const second = renderWith(saved, { threads });
      const reopened = (await screen.findByText("Why three?")).closest("[data-thread-id]") as HTMLElement;
      fireEvent.click(within(reopened).getByRole("button", { name: "Fold" }));
      await screen.findByRole("button", { name: /Why three\?/ });
      cleanup();
      forgetViewStates();
      renderWith(lastSaved(second), { threads });
      await screen.findByRole("button", { name: /Why three\?/ });
      expect(screen.queryByText("Why three?")?.closest("[data-thread-id]")).toBeFalsy();
    });

    it("unfolds a folded file when its whole-file comment box opens, and keeps it unfolded", async () => {
      const large = { ...VIEW.files[0]!, path: "src/large.ts", additions: 2501, patch: PATCH.replaceAll("src/a.ts", "src/large.ts") };
      const first = renderWith(null, { threads: [], files: [VIEW.files[0]!, large] });
      // src/large.ts starts folded (a large change); fold src/a.ts by hand.
      const section = (path: string) => document.querySelector(`[data-file-path="${path}"]`) as HTMLElement;
      await waitFor(() => expect(within(section("src/large.ts")).getByRole("button", { name: "Expand file" })).toBeTruthy());
      fireEvent.click(within(section("src/a.ts")).getByRole("button", { name: "Collapse file" }));
      expect(within(section("src/a.ts")).queryByPlaceholderText("A comment about the whole file")).toBeNull();

      for (const path of ["src/large.ts", "src/a.ts"]) {
        fireEvent.click(within(section(path)).getByRole("button", { name: "Comment on file" }));
        // The box shows at once, no second click needed.
        expect(within(section(path)).getByPlaceholderText("A comment about the whole file")).toBeTruthy();
        expect(within(section(path)).getByRole("button", { name: "Collapse file" })).toBeTruthy();
      }
      cleanup();
      expect(lastSaved(first).collapsed).toEqual({ "src/a.ts": false, "src/large.ts": false });
    });

    it("comes back to this window's copy when the server's is older", async () => {
      renderWith(null);
      await screen.findByText("Why three?");
      fireEvent.click(screen.getByRole("button", { name: "Comment on the diff" }));
      type(/A comment about the whole change/, "Typed just now");
      cleanup();
      renderWith(null);
      await screen.findByDisplayValue("Typed just now");
    });

    it("keeps files folded or unfolded by hand", async () => {
      const first = renderWith(null);
      const section = (await screen.findByTestId("patch")).closest("section")!;
      fireEvent.click(within(section).getByRole("button", { name: "Collapse file" }));
      cleanup();
      const saved = lastSaved(first);
      expect(saved.collapsed).toEqual({ "src/a.ts": true });
      forgetViewStates();
      renderWith(saved);
      await screen.findByRole("button", { name: "Expand file" });
      expect(screen.queryByTestId("patch")).toBeNull();
    });

    it("comes back to the same file and offset, even when files were added or removed above it", async () => {
      const file = (path: string) => ({ ...VIEW.files[0]!, path });
      // Each file is 500px tall; the scroll area's top is at 100px.
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const root = document.querySelector("section[data-file-path]")?.parentElement;
        if (!(this instanceof HTMLElement) || this.dataset.filePath === undefined || root == null) return { top: 100, bottom: 100 } as DOMRect;
        const index = Array.from(root.querySelectorAll("section[data-file-path]")).indexOf(this);
        const top = 100 + index * 500 - root.scrollTop;
        return { top, bottom: top + 500 } as DOMRect;
      });
      try {
        const first = renderWith(null, { threads: [], files: [file("src/a.ts"), file("src/b.ts")] });
        await waitFor(() => expect(screen.getAllByTestId("patch")).toHaveLength(2));
        const root = document.querySelector("section[data-file-path]")!.parentElement!;
        root.scrollTop = 540;
        fireEvent.scroll(root);
        await waitFor(() => expect(lastSaved(first).scroll).toEqual({ path: "src/b.ts", index: 1, offset: 40 }));
        cleanup();
        const saved = lastSaved(first);
        forgetViewStates();

        renderWith(saved, { threads: [], files: [file("src/a.ts"), file("src/b.ts")] });
        await waitFor(() => expect(document.querySelector("section[data-file-path]")!.parentElement!.scrollTop).toBe(540));
        cleanup();
        forgetViewStates();

        // A file added above: the same place in src/b.ts is now 500px further down.
        renderWith(saved, { threads: [], files: [file("src/0.ts"), file("src/a.ts"), file("src/b.ts")] });
        await waitFor(() => expect(document.querySelector("section[data-file-path]")!.parentElement!.scrollTop).toBe(1040));
        cleanup();
        forgetViewStates();

        // src/b.ts left the diff: the file now in its place takes over.
        renderWith(saved, { threads: [], files: [file("src/a.ts"), file("src/c.ts")] });
        await waitFor(() => expect(document.querySelector("section[data-file-path]")!.parentElement!.scrollTop).toBe(540));
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it("says why there is nothing to review", async () => {
    renderSlot({ component: ReviewPanel }, { threadId: "thr_1", environment: ENVIRONMENT, params: null }, { rpc: { getReview: () => ({ ok: false, message: "No workspace." }) } });
    await screen.findByText("No workspace.");
  });
});
