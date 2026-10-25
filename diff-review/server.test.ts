import { fileURLToPath } from "node:url";

import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import type { ReviewThread, ReviewView } from "./shared/types";

const ENV = "env_1";
const THREAD = "thr_review";

function environment(overrides: Record<string, unknown> = {}) {
  return {
    baseBranch: "main",
    branchName: "feature",
    createdAt: 1,
    defaultBranch: "main",
    environmentProviderId: null,
    environmentProviderInstanceKey: null,
    environmentProviderSelection: null,
    hostId: "host_1",
    hostLifecycle: "active" as const,
    id: ENV,
    isGitRepo: true,
    isWorktree: true,
    lifecycle: { phase: "active" as const, retireAt: null, teardown: null },
    managed: true,
    mergeBaseBranch: null,
    name: null,
    path: "/work/repo",
    projectId: "proj_1",
    status: "ready" as const,
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree" as const,
    ...overrides,
  };
}

const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", ""].join("\n");

interface Setup {
  threads?: Record<string, { environmentId: string | null; providerId?: string }>;
  turnStarts?: number[];
  sendFails?: boolean;
  diffityignore?: string;
  /** Views (`uncommitted`, `branch_committed`, …) whose diff has no files. */
  emptyTargets?: string[];
}

async function setup(options: Setup = {}) {
  const threads = options.threads ?? { [THREAD]: { environmentId: ENV } };
  const turnStarts = options.turnStarts ?? [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "diff-review",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const row = threads[threadId];
          if (row === undefined) throw new Error(`thread ${threadId} not found`);
          return makeThreadResponse({ id: threadId, environmentId: row.environmentId, providerId: row.providerId ?? "claude-code" });
        },
        send: async () => {
          if (options.sendFails === true) throw new Error("thread is archived");
          return { ok: true as const, delivery: "sent" as const };
        },
        events: {
          list: async () =>
            turnStarts.map((createdAt, index) => ({
              id: `ev_${index}`,
              scope: "thread",
              threadId: THREAD,
              seq: index,
              createdAt,
              type: "turn/started",
              data: { providerThreadId: "p" },
            })),
        },
      },
      environments: {
        get: async () => environment(),
        status: async () => ({
          outcome: "available" as const,
          workspace: {
            branch: { currentBranch: "feature", defaultBranch: "main" },
            checkout: { kind: "branch" as const, branchName: "feature", headSha: "abc" },
            mergeBase: {
              aheadCount: 1,
              baseRef: "origin/main",
              behindCount: 0,
              commits: [{ authorName: "a", authoredAt: 1, sha: "abcdef1234567", shortSha: "abcdef1", subject: "Add a" }],
              deletions: 1,
              files: [],
              hasCommittedUnmergedChanges: true,
              insertions: 1,
              lineStatsComplete: true,
              mergeBaseBranch: "main",
            },
            workingTree: { deletions: 1, files: [], hasUncommittedChanges: true, insertions: 1, lineStatsComplete: true, state: "dirty_uncommitted" as const },
          },
        }),
        diffFiles: async (query: { target: string }) => ({
          outcome: "available" as const,
          files: (options.emptyTargets ?? []).includes(query.target) ? [] : [
            { path: "src/a.ts", previousPath: null, changeKind: "modified" as const, additions: 1, deletions: 1, binary: false, loadMode: "auto" as const, origin: "tracked" as const },
            { path: "package-lock.json", previousPath: null, changeKind: "modified" as const, additions: 9, deletions: 9, binary: false, loadMode: "auto" as const, origin: "tracked" as const },
            { path: "big.txt", previousPath: null, changeKind: "added" as const, additions: 9000, deletions: 0, binary: false, loadMode: "on_demand" as const, origin: "untracked" as const },
          ],
          initialPatches: (options.emptyTargets ?? []).includes(query.target) ? [] : [{ path: "src/a.ts", patch: PATCH, truncated: false }],
          mergeBaseRef: null,
          shortstat: "",
          truncated: false,
        }),
        diffPatch: async ({ paths }: { paths: string[] }) => ({
          outcome: "available" as const,
          patches: paths.map((path) => ({ path, patch: `patch of ${path}`, truncated: false })),
        }),
      },
      files: {
        read: async ({ path }: { path: string }) => {
          if (path === "/work/repo/.diffityignore" && options.diffityignore !== undefined) {
            return { content: options.diffityignore, contentEncoding: "utf8", sha256: "x" };
          }
          throw new Error("ENOENT");
        },
      },
    },
  });
  await plugin(bb);
  const rpc = harness.behavior.callRpc.bind(harness.behavior) as (method: string, input?: unknown) => Promise<unknown>;
  const view = async (target: unknown = { kind: "uncommitted" }) => (await rpc("getReview", { threadId: THREAD, target })) as Extract<ReviewView, { ok: true }>;
  const comment = async (sessionId: string, body = "Why 3?") =>
    ((await rpc("createThread", {
      sessionId,
      filePath: "src/a.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      severity: "question",
      anchorContent: "const b = 3;",
      body,
    })) as { thread: ReviewThread }).thread;
  return { bb, harness, rpc, view, comment, threads, turnStarts };
}

describe("the Review tab's view", () => {
  it("loads the thread's diff, leaving out ignored files and keeping on-demand ones unloaded", async () => {
    const { view } = await setup({ diffityignore: "# generated\npackage-lock.json\n" });
    const result = await view();
    expect(result.ok).toBe(true);
    expect(result.target).toEqual({ kind: "uncommitted" });
    expect(result.files.map((file) => [file.path, file.patch !== null])).toEqual([
      ["src/a.ts", true],
      ["big.txt", false],
    ]);
    expect(result.files[1]!.untracked).toBe(true);
    expect(result.ignoredPaths).toEqual(["package-lock.json"]);
    expect(result.defaultBase).toBe("main");
    expect(result.commits.map((commit) => commit.shortSha)).toEqual(["abcdef1"]);
  });

  it("applies the ignore setting, and skips the ignore files when told to", async () => {
    const { harness, view } = await setup({ diffityignore: "src/\n" });
    await harness.behavior.setSettings({ ignorePatterns: "*.json", readIgnoreFiles: false });
    const result = await view();
    expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "big.txt"]);
  });

  it("fills in the base branch, and keeps one session per view", async () => {
    const { view } = await setup();
    const branch = await view({ kind: "branch" });
    expect(branch.target).toEqual({ kind: "branch", base: "main" });
    const again = await view({ kind: "branch", base: "main" });
    const uncommitted = await view();
    expect(again.sessionId).toBe(branch.sessionId);
    expect(uncommitted.sessionId).not.toBe(branch.sessionId);
  });

  it("opens on the branch's commits when there is nothing uncommitted, only when asked to pick", async () => {
    const { rpc } = await setup({ emptyTargets: ["uncommitted"] });
    const picked = (await rpc("getReview", { threadId: THREAD, target: { kind: "uncommitted" }, autoTarget: true })) as Extract<ReviewView, { ok: true }>;
    expect(picked.target).toEqual({ kind: "branch", base: "main" });
    expect(picked.files.map((file) => file.path)).toContain("src/a.ts");
    const chosen = (await rpc("getReview", { threadId: THREAD, target: { kind: "uncommitted" } })) as Extract<ReviewView, { ok: true }>;
    expect(chosen.target).toEqual({ kind: "uncommitted" });
    expect(chosen.files).toEqual([]);
  });

  it("keeps the uncommitted view when the branch has nothing either, or when there are uncommitted changes", async () => {
    const empty = await setup({ emptyTargets: ["uncommitted", "branch_committed"] });
    expect(((await empty.rpc("getReview", { threadId: THREAD, target: { kind: "uncommitted" }, autoTarget: true })) as ReviewView & { target: unknown }).target).toEqual({ kind: "uncommitted" });
    const dirty = await setup();
    expect(((await dirty.rpc("getReview", { threadId: THREAD, target: { kind: "uncommitted" }, autoTarget: true })) as ReviewView & { target: unknown }).target).toEqual({ kind: "uncommitted" });
  });

  it("says why there is nothing to review", async () => {
    const { rpc } = await setup({ threads: { [THREAD]: { environmentId: null } } });
    expect(await rpc("getReview", { threadId: THREAD, target: { kind: "uncommitted" } })).toEqual({
      ok: false,
      message: "This thread has no workspace yet, so there is no diff to review.",
    });
  });

  it("loads on-demand patches", async () => {
    const { rpc } = await setup();
    expect(await rpc("loadPatches", { threadId: THREAD, target: { kind: "uncommitted" }, paths: ["big.txt"] })).toEqual({
      patches: [{ path: "big.txt", patch: "patch of big.txt", truncated: false }],
    });
  });
});

describe("comments", () => {
  it("stores line, file and whole-diff threads and signals the workspace's channel", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const line = await comment(sessionId);
    expect(line).toMatchObject({ filePath: "src/a.ts", side: "new", startLine: 2, endLine: 2, status: "open", severity: "question", delivery: null });
    expect(line.comments.map((c) => [c.authorType, c.body])).toEqual([["user", "Why 3?"]]);

    const file = (await rpc("createThread", { sessionId, filePath: "src/a.ts", side: "new", startLine: 0, endLine: 7, severity: null, anchorContent: "x", body: "Split this file" })) as { thread: ReviewThread };
    expect(file.thread).toMatchObject({ side: null, startLine: 0, endLine: 0, anchorContent: null });
    const general = (await rpc("createThread", { sessionId, filePath: "__general__", side: "old", startLine: 3, endLine: 3, severity: null, anchorContent: null, body: "Add tests" })) as { thread: ReviewThread };
    expect(general.thread).toMatchObject({ side: null, startLine: 0 });

    const listed = (await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] };
    expect(listed.threads.map((thread) => thread.id)).toEqual([line.id, file.thread.id, general.thread.id]);
    expect(harness.inspection.realtimeSignals.at(-1)).toEqual({ channel: `environment:${ENV}`, payload: { kind: "threads", sessionId } });
  });

  it("refuses a range that ends before it starts, and an empty comment", async () => {
    const { rpc, view } = await setup();
    const { sessionId } = await view();
    await expect(rpc("createThread", { sessionId, filePath: "src/a.ts", side: "new", startLine: 5, endLine: 2, severity: null, anchorContent: null, body: "x" })).rejects.toThrow(
      "A range must end at or after its start.",
    );
    await expect(rpc("createThread", { sessionId, filePath: "src/a.ts", side: "new", startLine: 2, endLine: 2, severity: null, anchorContent: null, body: "  " })).rejects.toThrow("The comment is empty.");
  });

  it("replies, edits, resolves and deletes", async () => {
    const { rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const thread = await comment(sessionId);
    const replied = ((await rpc("addComment", { reviewThreadId: thread.id, body: "Also 4?" })) as { thread: ReviewThread }).thread;
    expect(replied.comments).toHaveLength(2);
    const edited = ((await rpc("editComment", { commentId: replied.comments[1]!.id, body: "Also 5?" })) as { thread: ReviewThread }).thread;
    expect(edited.comments[1]).toMatchObject({ body: "Also 5?" });
    expect(edited.comments[1]!.editedAt).not.toBeNull();
    const resolved = ((await rpc("setStatus", { reviewThreadId: thread.id, status: "resolved" })) as { thread: ReviewThread }).thread;
    expect(resolved.status).toBe("resolved");
    await rpc("deleteComment", { commentId: replied.comments[1]!.id });
    await rpc("deleteComment", { commentId: replied.comments[0]!.id });
    expect(((await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads).toEqual([]);
  });
});

describe("sending to the agent and its answers", () => {
  async function sent(options: Setup = {}) {
    const context = await setup(options);
    const { sessionId } = await context.view();
    const thread = await context.comment(sessionId);
    const result = await context.rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "Keep it small." });
    return { ...context, sessionId, thread, result };
  }

  it("sends the threads, queued behind the current turn, in a message that lists them", async () => {
    const { harness, thread, result } = await sent();
    expect(result).toEqual({ delivery: "sent", count: 1 });
    const call = harness.inspection.sdk.callsTo("threads.send")[0]![0] as { threadId: string; mode: string; input: { text: string }[] };
    expect(call.threadId).toBe(THREAD);
    expect(call.mode).toBe("queue-if-active");
    const text = call.input[0]!.text;
    expect(text).toContain(`### Thread \`${thread.id}\` — src/a.ts:2 (new side) · question`);
    expect(text).toContain("> Why 3?");
    expect(text).toContain("## Review summary\n\nKeep it small.");
    expect(text).toContain("bb diff-review reply <thread-id> --text-base64-stdin");
  });

  it("marks the threads as sent to that thread", async () => {
    const { rpc, sessionId } = await sent();
    const [thread] = ((await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads;
    expect(thread!.delivery).toMatchObject({ state: "sent", threadId: THREAD });
  });

  it("forgets a send bb refused", async () => {
    const context = await setup({ sendFails: true });
    const { sessionId } = await context.view();
    const thread = await context.comment(sessionId);
    await expect(context.rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" })).rejects.toThrow("thread is archived");
    const [row] = ((await context.rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads;
    expect(row!.delivery).toBeNull();
  });

  it("refuses a thread in another workspace, and a thread that is not open", async () => {
    const context = await setup({ threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: "env_2" } } });
    const { sessionId } = await context.view();
    const thread = await context.comment(sessionId);
    await expect(context.rpc("send", { sessionId, threadId: "thr_other", reviewThreadIds: [thread.id], note: "" })).rejects.toThrow("another workspace");
    await context.rpc("setStatus", { reviewThreadId: thread.id, status: "resolved" });
    await expect(context.rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" })).rejects.toThrow("is resolved");
  });

  it("lets the agent list, reply and resolve, by id prefix and base64 text", async () => {
    const { harness, rpc, sessionId, thread } = await sent();
    const listed = await harness.behavior.runCli(["list"], { threadId: THREAD });
    expect(listed.stdout).toContain(`${thread.id}  open · src/a.ts:2 (new side) · question`);
    expect(listed.stdout).toContain("    Why 3?");

    const reply = await harness.behavior.runCli(["reply", thread.id.slice(0, 6), "--text-base64", Buffer.from("Because `b` grew.\nSee src/a.ts:2\n").toString("base64")], { threadId: THREAD });
    expect(reply).toMatchObject({ exitCode: 0, stdout: `Replied on ${thread.id} (src/a.ts:2 (new side)).\n` });
    let [row] = ((await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads;
    expect(row!.comments.at(-1)).toMatchObject({ authorType: "agent", authorName: "Claude Code", body: "Because `b` grew.\nSee src/a.ts:2" });
    expect(row!.delivery!.state).toBe("answered");
    expect(row!.status).toBe("open");

    const resolve = await harness.behavior.runCli(["resolve", thread.id, "Fixed:", "renamed", "b."], { threadId: THREAD });
    expect(resolve.exitCode).toBe(0);
    [row] = ((await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads;
    expect(row!.status).toBe("resolved");
    expect(row!.comments.at(-1)!.body).toBe("Fixed: renamed b.");
    expect((await harness.behavior.runCli(["list"], { threadId: THREAD })).stdout).toBe("No open comment threads were sent to this thread.\n");
    expect((await harness.behavior.runCli(["list", "--all", "--json"], { threadId: THREAD })).stdout).toContain(thread.id);
  });

  it("refuses an answer from any other thread, or from outside a thread", async () => {
    const { harness, thread } = await sent({ threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: ENV } } });
    const other = await harness.behavior.runCli(["dismiss", thread.id, "nope"], { threadId: "thr_other" });
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr).toContain("was not sent to this thread");
    const outside = await harness.behavior.runCli(["reply", thread.id, "hi"]);
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toContain("Run this inside the bb thread");
    const bad = await harness.behavior.runCli(["reply", thread.id, "--text-base64", "not base64!"], { threadId: THREAD });
    expect(bad.stderr).toContain("not valid base64");
  });

  it("marks unanswered threads 'no reply' once a turn that started after the send ends", async () => {
    const context = await sent();
    const { harness, rpc, sessionId, turnStarts } = context;
    const idle = () => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: THREAD, environmentId: ENV }), lastAssistantText: "done" });

    // The turn that was running when the comments were queued ends first: not their turn.
    turnStarts.splice(0, turnStarts.length, 0);
    await idle();
    let [row] = ((await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads;
    expect(row!.delivery!.state).toBe("sent");

    turnStarts.splice(0, turnStarts.length, Date.now() + 60_000);
    await idle();
    [row] = ((await rpc("listThreads", { sessionId })) as { threads: ReviewThread[] }).threads;
    expect(row!.delivery!.state).toBe("no_reply");
    expect(harness.inspection.realtimeSignals.slice(-2)).toEqual([
      { channel: `environment:${ENV}`, payload: { kind: "threads", sessionId } },
      { channel: `environment:${ENV}`, payload: { kind: "diff" } },
    ]);
  });
});

describe("the package", () => {
  it("imports only public SDK entry points", () => {
    // Beyond the SDK: the vendored UI (`@/`), the host-shimmed packages, the bundled ones, and test tools.
    const allow = [
      /^@\//,
      /^react(-dom)?(\/.*)?$/,
      /^@radix-ui\//,
      /^@pierre\/diffs(\/.*)?$/,
      /^(sonner|vaul|clsx|tailwind-merge|class-variance-authority|ignore|better-sqlite3)$/,
      /^(vitest|vitest\/config|@testing-library\/react)$/,
    ];
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
