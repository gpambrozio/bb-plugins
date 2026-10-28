import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createFakePluginHost, experimental_scanPublicSdkOnly, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ProviderInfo } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import plugin from "./server";
import { REPORT_LINE } from "./server/run-prompts";
import { TOOL_NAMES } from "./server/tool-names";
import type { ReviewThread, ReviewView, Run } from "./shared/types";

const ENV = "env_1";
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
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
  spawnFails?: boolean;
  diffityignore?: string;
  /** More files the host can read, by absolute path; `/work/repo/.git` is a directory unless listed. */
  files?: Record<string, string>;
  /** Awaited before answering `threads.get` for that thread, or `threads.spawn`: a test holds bb mid-call. */
  holdThreadGet?: (threadId: string) => Promise<void>;
  holdSpawn?: () => Promise<void>;
  /** Awaited before answering `environments.get` and `threads.events.list`. */
  holdEnvironmentGet?: () => Promise<void>;
  holdEvents?: (threadId: string) => Promise<void>;
  /** Runs once bb has made a spawned thread but before `spawn` answers: the child acting early. */
  duringSpawn?: (threadId: string) => Promise<void>;
  /** More fields in bb's status answer, as a later bb may add (a time stamp, say). */
  statusExtra?: () => Record<string, unknown>;
  /** Files as committed at HEAD, by absolute path, for `files.read` with `ref`. */
  headFiles?: Record<string, string>;
  /** Views (`uncommitted`, `branch_committed`, …) whose diff has no files. */
  emptyTargets?: string[];
  /** The permission modes each provider supports, as `providers.list` reports them; every mode when unlisted. */
  providerModes?: Record<string, ("auto" | "accept-edits" | "full")[]>;
}

async function setup(options: Setup = {}) {
  const threads = options.threads ?? { [THREAD]: { environmentId: ENV } };
  const turnStarts = options.turnStarts ?? [];
  const reads: string[] = [];
  // What the workspace holds; a test edits it to play a run that changes files.
  const workspace = { extraFile: false, head: "abc", bigVersion: 1 };
  // What bb would hold for spawned threads: their origin plugin and metadata.
  const spawnedMetadata: Record<string, Record<string, unknown>> = {};
  let spawned = 0;
  // The workspace's files the host can read and write, by absolute path.
  const files: Record<string, string> = { ...options.files };
  const writes: string[] = [];
  // bb's Git plugin: on unless a test turns it off; Viewed marks by path; every call it got.
  const git = { enabled: true, viewed: {} as Record<string, string>, calls: [] as { method: string; input: unknown }[] };
  const revisionOf = (path: string) => (path === "big.txt" ? `rev-big-${workspace.bigVersion}` : `rev-${path}`);
  const gitAnswer = (method: string, input: Record<string, unknown>): unknown => {
    switch (method) {
      case "workspaceStatus":
        return {
          outcome: "available" as const,
          workspace: {
            branch: { currentBranch: "feature", defaultBranch: "main" },
            checkout: { kind: "branch" as const, branchName: "feature", headSha: workspace.head, ...options.statusExtra?.() },
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
        };
      case "files": {
        const target = (input.target as { type: string }).type;
        const empty = (options.emptyTargets ?? []).includes(target);
        const entry = (path: string, changeKind: string, additions: number, deletions: number, loadMode: string, origin: string) => ({
          path, previousPath: null, changeKind, additions, deletions, binary: false, loadMode, origin, revision: revisionOf(path),
        });
        return {
          outcome: "available" as const,
          files: empty ? [] : [
            entry("src/a.ts", "modified", 1, 1, "auto", "tracked"),
            entry("package-lock.json", "modified", 9, 9, "auto", "tracked"),
            entry("big.txt", "added", 9000, 0, "on_demand", "untracked"),
            ...(workspace.extraFile ? [entry("src/new.ts", "added", 3, 0, "auto", "untracked")] : []),
          ],
          initialPatches: empty ? [] : [{ path: "src/a.ts", patch: PATCH, truncated: false }],
          mergeBaseRef: null,
          shortstat: "",
          truncated: false,
        };
      }
      case "patches":
        return Object.fromEntries(
          (input.keys as string[]).map((key) => {
            const [, , , path, revision] = JSON.parse(key) as [string, unknown, boolean, string, string];
            // A revision that is no longer the file's is still answered, as bb's Git plugin does.
            return [key, { outcome: "available" as const, patch: { path, patch: `patch of ${path}, version ${workspace.bigVersion} at ${revision}`, truncated: false } }];
          }),
        );
      case "viewed":
        return { files: ((input.paths as string[] | undefined) ?? []).filter((path) => git.viewed[path] !== undefined).map((path) => ({ path, revision: git.viewed[path]! })) };
      case "markViewed":
        git.viewed[input.path as string] = input.revision as string;
        return { ok: true as const };
      case "clearViewed":
        delete git.viewed[input.path as string];
        return { ok: true as const };
      default:
        throw new Error(`the fake Git plugin has no ${method}`);
    }
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "diff-review",
    // The skill bb imports from `skills/diff-review`, which `configure` names.
    agentSkillIds: ["diff-review"],
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          await options.holdThreadGet?.(threadId);
          const row = threads[threadId];
          if (row === undefined) throw new Error(`thread ${threadId} not found`);
          return makeThreadResponse({
            id: threadId,
            environmentId: row.environmentId,
            providerId: row.providerId ?? "claude-code",
            originPluginId: spawnedMetadata[threadId] === undefined ? null : "diff-review",
          });
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => spawnedMetadata[threadId] ?? {},
        send: async () => {
          if (options.sendFails === true) throw new Error("thread is archived");
          return { ok: true as const, delivery: "sent" as const };
        },
        spawn: async (input: { pluginMetadata?: Record<string, unknown> }) => {
          await options.holdSpawn?.();
          if (options.spawnFails === true) throw new Error("provider not installed");
          const id = `thr_run_${++spawned}`;
          threads[id] = { environmentId: ENV };
          spawnedMetadata[id] = input.pluginMetadata ?? {};
          await options.duringSpawn?.(id);
          return makeThreadResponse({ id, environmentId: ENV, providerId: "claude-code", originPluginId: "diff-review" });
        },
        archive: async () => ({ ok: true as const }),
        events: {
          list: async ({ threadId }: { threadId: string }) => {
            await options.holdEvents?.(threadId);
            return turnStarts.map((createdAt, index) => ({
              id: `ev_${index}`,
              scope: "thread",
              threadId: THREAD,
              seq: index,
              createdAt,
              type: "turn/started",
              data: { providerThreadId: "p" },
            }));
          },
        },
      },
      environments: {
        get: async () => {
          await options.holdEnvironmentGet?.();
          return environment();
        },
      },
      plugins: {
        list: async () => ({ plugins: [{ id: "bb--git", enabled: git.enabled }] }) as never,
        // bb's Git plugin, as `bb.sdk.plugins.callRpc` reaches it; `git.calls` records each call.
        callRpc: async ({ pluginId, method, input, outputSchema }: { pluginId: string; method: string; input?: unknown; outputSchema: { parse: (value: unknown) => unknown } }) => {
          if (pluginId !== "bb--git") throw new Error(`no plugin ${pluginId}`);
          git.calls.push({ method, input });
          if (!git.enabled) throw new Error("Plugin RPC failed");
          return outputSchema.parse(gitAnswer(method, input as Record<string, unknown>)) as never;
        },
      },
      providers: {
        list: async () =>
          Object.entries(options.providerModes ?? {}).map(([id, permissionModes]) => ({ id, capabilities: { permissionModes } }) as unknown as ProviderInfo),
        models: async () => ({
          modelLoadError: null,
          models: [
            { id: "small", model: "small", displayName: "Small", description: "", isDefault: false, defaultReasoningEffort: "low" as const, supportedReasoningEfforts: [] },
            { id: "big", model: "big", displayName: "Big", description: "", isDefault: true, defaultReasoningEffort: "high" as const, supportedReasoningEfforts: [] },
          ],
          permissionCeiling: "full" as const,
          providers: [],
        }),
      },
      files: {
        write: async ({ path, content, expectedSha256 }: { path: string; content: string; expectedSha256?: string | null }) => {
          const current = files[path];
          if (expectedSha256 !== undefined && expectedSha256 !== null && (current === undefined || sha(current) !== expectedSha256)) throw new Error("sha256 mismatch");
          files[path] = content;
          writes.push(path);
          return { ok: true } as never;
        },
        remove: async ({ path }: { path: string }) => {
          delete files[path];
          writes.push(`rm ${path}`);
          return { ok: true } as never;
        },
        read: async ({ path, ref }: { path: string; ref?: string }) => {
          if (ref !== undefined) {
            const committed = options.headFiles?.[path];
            if (committed === undefined) throw new Error("ENOENT");
            return { content: committed, contentEncoding: "utf8", sha256: sha(committed) };
          }
          reads.push(path);
          if (path === "/work/repo/.diffityignore" && options.diffityignore !== undefined) {
            return { content: options.diffityignore, contentEncoding: "utf8", sha256: "x" };
          }
          const content = files[path];
          if (content !== undefined) return { content, contentEncoding: "utf8", sha256: sha(content) };
          if (path === "/work/repo/.git") throw new Error("EISDIR: illegal operation on a directory, read");
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
      threadId: THREAD,
      filePath: "src/a.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      severity: "question",
      anchorContent: "const b = 3;",
      body,
    })) as { thread: ReviewThread }).thread;
  return { bb, harness, rpc, view, comment, threads, turnStarts, workspace, reads, git, files, writes };
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

  it("reads the repository's info/diffityignore from .git in a plain checkout", async () => {
    const { view } = await setup({ files: { "/work/repo/.git/info/diffityignore": "src/\n" } });
    expect((await view()).ignoredPaths).toEqual(["src/a.ts"]);
  });

  it("reads info/diffityignore from the common git dir in a linked worktree, whose .git is a file", async () => {
    const { view, reads } = await setup({
      files: {
        "/work/repo/.git": "gitdir: /main/.git/worktrees/repo\n",
        "/main/.git/worktrees/repo/commondir": "../..\n",
        "/main/.git/info/diffityignore": "src/\n",
      },
    });
    expect((await view()).ignoredPaths).toEqual(["src/a.ts"]);
    expect(reads.some((path) => path.startsWith("/work/repo/.git/"))).toBe(false);
  });

  it("follows a relative gitdir, and treats a missing ignore file in a worktree as no ignores", async () => {
    const relative = await setup({ files: { "/work/repo/.git": "gitdir: ../main/.git/worktrees/repo", "/work/main/.git/worktrees/repo/commondir": "../..", "/work/main/.git/info/diffityignore": "src/" } });
    expect((await relative.view()).ignoredPaths).toEqual(["src/a.ts"]);
    const missing = await setup({ files: { "/work/repo/.git": "gitdir: /main/.git/worktrees/repo\n", "/main/.git/worktrees/repo/commondir": "../..\n" } });
    const result = await missing.view();
    expect(result.ok).toBe(true);
    expect(result.ignoredPaths).toEqual([]);
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

  it("loads on-demand patches at the revision the file list gave", async () => {
    const { rpc, view, git } = await setup();
    const big = (await view()).files.find((file) => file.path === "big.txt")!;
    expect(big.revision).toBe("rev-big-1");
    expect(await rpc("loadPatches", { threadId: THREAD, target: { kind: "uncommitted" }, files: [{ path: "big.txt", revision: big.revision }] })).toEqual({
      patches: [{ path: "big.txt", patch: "patch of big.txt, version 1 at rev-big-1", truncated: false }],
    });
    const call = git.calls.filter((entry) => entry.method === "patches").at(-1)!;
    expect(call.input).toEqual({ keys: [JSON.stringify([ENV, { type: "uncommitted" }, false, "big.txt", "rev-big-1"])] });
  });

  it("reads every diff through bb's Git plugin, hiding whitespace when asked", async () => {
    const { rpc, git } = await setup();
    await rpc("getReview", { threadId: THREAD, target: { kind: "branch" }, ignoreWhitespace: true });
    expect(git.calls.find((entry) => entry.method === "files" && (entry.input as { ignoreWhitespace: boolean }).ignoreWhitespace)?.input).toEqual({
      environmentId: ENV,
      target: { type: "branch_committed", mergeBaseBranch: "main" },
      ignoreWhitespace: true,
    });
    await rpc("loadPatches", { threadId: THREAD, target: { kind: "commit", sha: "abcdef1" }, files: [{ path: "big.txt", revision: "r" }], ignoreWhitespace: true });
    expect(git.calls.at(-1)!.input).toEqual({ keys: [JSON.stringify([ENV, { type: "commit", sha: "abcdef1" }, true, "big.txt", "r"])] });
  });

  it("says so when bb's Git plugin is turned off", async () => {
    const { view, git } = await setup();
    git.enabled = false;
    const result = (await view()) as unknown as { ok: false; message: string };
    expect(result).toEqual({ ok: false, message: expect.stringContaining("bb's Git plugin is turned off") });
  });

  it("marks and clears Viewed through bb's Git plugin, at the revision the tab showed", async () => {
    const { rpc, view, git } = await setup();
    await rpc("setViewed", { threadId: THREAD, target: { kind: "uncommitted" }, path: "src/a.ts", revision: "rev-src/a.ts", viewed: true });
    expect(git.calls.at(-1)).toEqual({ method: "markViewed", input: { environmentId: ENV, target: { type: "uncommitted" }, path: "src/a.ts", revision: "rev-src/a.ts" } });
    expect((await view()).files[0]!.viewed).toBe("yes");
    await rpc("setViewed", { threadId: THREAD, target: { kind: "uncommitted" }, path: "src/a.ts", revision: "rev-src/a.ts", viewed: false });
    expect((await view()).files[0]!.viewed).toBe("no");
  });

  it("keeps the revision of the file a comment was made on", async () => {
    const { rpc, view } = await setup();
    const { sessionId } = await view();
    const made = (await rpc("createThread", {
      sessionId,
      filePath: "src/a.ts",
      side: null,
      startLine: 0,
      endLine: 0,
      severity: null,
      anchorContent: null,
      body: "About this file",
      fileRevision: "rev-src/a.ts",
    })) as { thread: ReviewThread };
    expect(made.thread.fileRevision).toBe("rev-src/a.ts");
    expect((await view()).threads[0]!.fileRevision).toBe("rev-src/a.ts");
  });

  it("shows bb's Viewed marks, and which files changed since they were viewed", async () => {
    const { view, git } = await setup();
    git.viewed["src/a.ts"] = "rev-src/a.ts";
    git.viewed["big.txt"] = "rev-big-0";
    expect((await view()).files.map((file) => [file.path, file.viewed])).toEqual([
      ["src/a.ts", "yes"],
      ["package-lock.json", "no"],
      ["big.txt", "changed"],
    ]);
  });
});

describe("changing the workspace from the tab", () => {
  const suggestion = (code: string) => `Use three:\n\`\`\`suggestion\n${code}\n\`\`\``;

  it("applies a comment's suggestion to the lines as the view shows them, and resolves the thread", async () => {
    const { rpc, view, files, harness } = await setup({ files: { "/work/repo/src/a.ts": "const a = 1;\nconst b = 3;\n" } });
    const { sessionId } = await view();
    const made = ((await rpc("createThread", { sessionId, filePath: "src/a.ts", side: "new", startLine: 2, endLine: 2, severity: null, anchorContent: "const b = 3;", body: suggestion("const b = 4;") })) as { thread: ReviewThread }).thread;
    const applied = (await rpc("applySuggestion", { threadId: THREAD, reviewThreadId: made.id, commentId: made.comments[0]!.id, startLine: 2, endLine: 2, expected: "const b = 3;", code: "const b = 4;" })) as { thread: ReviewThread };
    expect(files["/work/repo/src/a.ts"]).toBe("const a = 1;\nconst b = 4;\n");
    expect(applied.thread.status).toBe("resolved");
    expect(harness.inspection.realtimeSignals.some((signal) => (signal.payload as { kind: string }).kind === "diff")).toBe(true);
  });

  it("refuses a suggestion the comment does not make, or lines that changed", async () => {
    const { rpc, view, files } = await setup({ files: { "/work/repo/src/a.ts": "const a = 1;\nconst b = 9;\n" } });
    const { sessionId } = await view();
    const made = ((await rpc("createThread", { sessionId, filePath: "src/a.ts", side: "new", startLine: 2, endLine: 2, severity: null, anchorContent: "const b = 3;", body: suggestion("const b = 4;") })) as { thread: ReviewThread }).thread;
    const ask = (code: string) => rpc("applySuggestion", { threadId: THREAD, reviewThreadId: made.id, commentId: made.comments[0]!.id, startLine: 2, endLine: 2, expected: "const b = 3;", code });
    await expect(ask("rm -rf")).rejects.toMatchObject({ code: "invalid" });
    await expect(ask("const b = 4;")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("changed since") });
    expect(files["/work/repo/src/a.ts"]).toBe("const a = 1;\nconst b = 9;\n");
  });

  it("reverts a hunk, or a whole file back to HEAD, only at the revision the tab showed", async () => {
    const { rpc, files, writes } = await setup({
      files: { "/work/repo/src/a.ts": "const a = 1;\nconst b = 3;\n" },
      headFiles: { "/work/repo/src/a.ts": "const a = 1;\nconst b = 2;\n" },
    });
    await expect(rpc("revertChanges", { threadId: THREAD, path: "src/a.ts", revision: "stale", hunks: [0] })).rejects.toMatchObject({ code: "conflict" });
    await rpc("revertChanges", { threadId: THREAD, path: "src/a.ts", revision: "rev-src/a.ts", hunks: [0] });
    expect(files["/work/repo/src/a.ts"]).toBe("const a = 1;\nconst b = 2;\n");
    files["/work/repo/src/a.ts"] = "changed again\n";
    await rpc("revertChanges", { threadId: THREAD, path: "src/a.ts", revision: "rev-src/a.ts", hunks: null });
    expect(files["/work/repo/src/a.ts"]).toBe("const a = 1;\nconst b = 2;\n");
    // A new file is removed.
    files["/work/repo/big.txt"] = "x";
    await rpc("revertChanges", { threadId: THREAD, path: "big.txt", revision: "rev-big-1", hunks: null });
    expect(files["/work/repo/big.txt"]).toBeUndefined();
    expect(writes).toEqual(["/work/repo/src/a.ts", "/work/repo/src/a.ts", "rm /work/repo/big.txt"]);
  });
});

describe("refusals", () => {
  it("answers a caller's mistake as bb's expected refusal, not a handler crash", async () => {
    const { rpc } = await setup();
    await expect(rpc("setStatus", { reviewThreadId: "nonexistent01", status: "resolved" })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining("nonexistent01") });
  });
});

describe("the Reviews page", () => {
  it("lists reviews with comment threads, each with the thread to open it in, and counts them", async () => {
    const { rpc, view, comment, harness } = await setup();
    const { sessionId } = await view();
    expect(await rpc("listReviews", {})).toEqual({ reviews: [] });
    const made = await comment(sessionId);
    await comment(sessionId, "And this?");
    await rpc("setStatus", { reviewThreadId: made.id, status: "resolved" });
    // The tab keeps state for the review, which names the thread it opens in.
    await rpc("saveViewState", { threadId: THREAD, sessionId, state: { drafts: {}, collapsed: {}, scroll: null, savedAt: 1 } });
    expect(((await rpc("listReviews", {})) as { reviews: unknown[] }).reviews).toEqual([
      expect.objectContaining({ sessionId, environmentId: ENV, target: { kind: "uncommitted" }, openCount: 1, totalCount: 2, threadId: THREAD, projectId: expect.any(String) }),
    ]);
    expect(await rpc("reviewCounts", {})).toEqual({ open: 1, total: 2 });
    expect(await rpc("reviewCounts", { environmentId: ENV })).toEqual({ open: 1, total: 2 });
    expect(await rpc("reviewCounts", { environmentId: "env_other" })).toEqual({ open: 0, total: 0 });
    expect(harness.inspection.realtimeSignals.some((event) => event.channel === "reviews")).toBe(true);
  });
});

describe("the tab's kept state", () => {
  const state = (drafts: Record<string, unknown> = {}) => ({
    drafts,
    collapsed: { "src/a.ts": true },
    scroll: { path: "src/a.ts", index: 0, offset: 40 },
    savedAt: 5,
  });

  it("keeps drafts, folds and the scroll place per thread and view, and drops drafts whose thread or comment is gone", async () => {
    const { rpc, view, comment } = await setup({ threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: ENV } } });
    const first = await view();
    expect(first.viewState).toBeNull();
    const kept = await comment(first.sessionId, "Keep me");
    const gone = await comment(first.sessionId, "Delete me");
    const saved = state({
      general: { body: "Half a thought", severity: "nit", range: null },
      "line:src/a.ts": { body: "On b", severity: null, range: { side: "new", startLine: 2, endLine: 2 } },
      [`reply:${kept.id}`]: { body: "Not sure", severity: null, range: null },
      [`reply:${gone.id}`]: { body: "Lost", severity: null, range: null },
      [`edit:${kept.comments[0]!.id}`]: { body: "Keep me, edited", severity: null, range: null },
    });
    expect(await rpc("saveViewState", { threadId: THREAD, sessionId: first.sessionId, state: saved })).toEqual({ ok: true });
    await rpc("deleteComment", { commentId: gone.comments[0]!.id });

    const { [`reply:${gone.id}`]: _dropped, ...expected } = saved.drafts;
    expect((await view()).viewState).toEqual({ ...saved, drafts: expected, expandedThreads: {} });
    // Another thread's tab and another view start empty.
    expect(((await rpc("getReview", { threadId: "thr_other", target: { kind: "uncommitted" } })) as { viewState: unknown }).viewState).toBeNull();
    expect((await view({ kind: "branch" })).viewState).toBeNull();
  });

  it("keeps the copy saved last when an older one arrives after it", async () => {
    const { rpc, view } = await setup();
    const { sessionId } = await view();
    const newer = { ...state({ general: { body: "Newer", severity: null, range: null } }), savedAt: 20 };
    const older = { ...state({ general: { body: "Older", severity: null, range: null } }), savedAt: 10 };
    await rpc("saveViewState", { threadId: THREAD, sessionId, state: newer });
    await rpc("saveViewState", { threadId: THREAD, sessionId, state: older });
    expect((await view()).viewState).toEqual({ ...newer, expandedThreads: {} });
  });

  it("refuses a state that is too big or for an unknown session", async () => {
    const { rpc, view } = await setup();
    const { sessionId } = await view();
    const drafts = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`file:f${index}`, { body: "x", severity: null, range: null }]));
    await expect(rpc("saveViewState", { threadId: THREAD, sessionId, state: state(drafts) })).rejects.toThrow();
    await expect(rpc("saveViewState", { threadId: THREAD, sessionId: "nope", state: state() })).rejects.toThrow();
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
    expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === `environment:${ENV}`).at(-1)).toEqual({ channel: `environment:${ENV}`, payload: { kind: "threads", sessionId } });
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
    // The workspace did not change since the first turn's end, so only the threads are re-read.
    expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === `environment:${ENV}`).at(-1)).toEqual({ channel: `environment:${ENV}`, payload: { kind: "threads", sessionId } });
  });

  it("tells the tabs to reload only when a turn ends with the workspace changed", async () => {
    const { harness, view, workspace } = await setup();
    await view();
    const diffSignals = () => harness.inspection.realtimeSignals.filter((signal) => (signal.payload as { kind: string }).kind === "diff").length;
    const idle = () => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: THREAD, environmentId: ENV }), lastAssistantText: "done" });
    // The tab's load recorded the state, so even the first turn end since the plugin loaded knows a
    // turn that changed nothing (an answer to a question, a notice read): no reload.
    await idle();
    await idle();
    expect(diffSignals()).toBe(0);
    workspace.extraFile = true;
    await idle();
    expect(diffSignals()).toBe(1);
    workspace.head = "def";
    await idle();
    expect(diffSignals()).toBe(2);
    await idle();
    expect(diffSignals()).toBe(2);
    expect(harness.inspection.logEntries.some((entry) => entry.level === "debug" && /ended; env_1 changed from \(head abc.*\) to \(head def/.test(entry.message))).toBe(true);
  });

  it("signals once for turns that end together, and ignores fields of bb's status it does not use", async () => {
    const { harness, view, workspace } = await setup({ statusExtra: () => ({ checkedAt: Date.now() + Math.random() }) });
    await view();
    const diffSignals = () => harness.inspection.realtimeSignals.filter((signal) => (signal.payload as { kind: string }).kind === "diff").length;
    const idle = (id: string) => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id, environmentId: ENV }), lastAssistantText: "done" });
    await idle(THREAD);
    expect(diffSignals()).toBe(0);
    workspace.extraFile = true;
    await Promise.all([idle(THREAD), idle("thr_reviewer")]);
    expect(diffSignals()).toBe(1);
  });
});

describe("AI runs", () => {
  type RunResult = { run: Run };
  const execution = { providerId: "claude-code", model: "big", reasoningLevel: "high" };
  const sessionState = async (rpc: (method: string, input?: unknown) => Promise<unknown>, sessionId: string) =>
    (await rpc("listThreads", { sessionId })) as { threads: ReviewThread[]; runs: Run[] };
  const tool = (harness: Awaited<ReturnType<typeof setup>>["harness"], name: string, input: unknown, threadId: string) =>
    harness.behavior.callAgentTool(name, input, { threadId, projectId: "proj_1" });
  const textOf = (result: unknown) =>
    typeof result === "string" ? result : (result as { content: { text: string }[] }).content.map((part) => part.text).join("");
  const isError = (result: unknown) => typeof result !== "string" && (result as { isError?: boolean }).isError === true;

  it("starts the pickers on the settings' provider and its default model", async () => {
    const { rpc } = await setup();
    expect(await rpc("runDefaults", { threadId: THREAD })).toEqual({
      execution: { providerId: "claude-code", model: "big", reasoningLevel: "high" },
      message: null,
      permissionMode: "auto",
    });
  });

  it("starts an AI review as a child of the thread under review, in its workspace, in Approve for me mode", async () => {
    const { harness, rpc, view } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: ["Security", "Tests"], instructions: "Check the auth path.", execution })) as RunResult;
    expect(run).toMatchObject({ kind: "review", focus: "Security, Tests", status: "running", threadId: "thr_run_1", providerId: "claude-code", model: "big" });
    const spawn = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(spawn).toMatchObject({
      projectId: "proj_1",
      title: "Review: Security, Tests",
      environment: { type: "reuse", environmentId: ENV },
      providerId: "claude-code",
      model: "big",
      reasoningLevel: "high",
      permissionMode: "auto",
      parentThreadId: THREAD,
      pluginMetadata: { diffReviewRunId: run.id },
    });
    expect(spawn.visibility).toBeUndefined();
    expect(spawn.prompt).toContain("- Focus: Security, Tests");
    expect(spawn.prompt).toContain("Check the auth path.");
    // Its final message, which bb posts to the parent, says it is a report.
    expect(spawn.prompt).toContain(`Start your final message with this line, exactly: "${REPORT_LINE}"`);
    expect((await view()).runs.map((row) => row.id)).toEqual([run.id]);
  });

  it("starts a summary that leaves its result as a comment on the whole diff, and is no reviewer", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startSummary", { sessionId, threadId: THREAD, execution })) as RunResult;
    expect(run).toMatchObject({ kind: "summary", status: "running", threadId: "thr_run_1" });
    const spawn = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(spawn).toMatchObject({ title: "Summary of the changes", parentThreadId: THREAD, permissionMode: "auto" });
    expect(spawn.prompt).toContain("diff_review_general_comment");
    expect(spawn.prompt).toContain(REPORT_LINE);
    await tool(harness, "diff_review_general_comment", { body: "**Overview**: b becomes 3." }, run.threadId!);
    expect((await sessionState(rpc, sessionId)).threads.map((row) => row.comments[0]!.body)).toEqual(["**Overview**: b becomes 3."]);
    // An @reviewer question starts a reviewer of its own: a summary is not the view's reviewer.
    await comment(sessionId, "@reviewer why?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2));
    expect((harness.inspection.sdk.callsTo("threads.spawn")[1]![0] as { prompt: string }).prompt).toContain("A question about a review thread");
  });

  it("starts an explanation of lines with the settings' agent, and lets it comment there", async () => {
    const { harness, rpc, view } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startExplain", { sessionId, threadId: THREAD, filePath: "src/a.ts", side: "new", startLine: 2, endLine: 2, code: "const b = 3;" })) as RunResult;
    expect(run).toMatchObject({ kind: "explain", focus: "src/a.ts:2", status: "running" });
    const spawn = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(spawn).toMatchObject({ title: "Explain a.ts:2", providerId: "claude-code" });
    expect(spawn.reasoningLevel).toBeUndefined();
    expect(spawn.prompt).toContain("# Explain line 2 of `src/a.ts` (the new side)");
    expect(spawn.prompt).toContain("const b = 3;");
    const ok = await tool(harness, "diff_review_comment", { file: "src/a.ts", startLine: 2, body: "It sets b." }, run.threadId!);
    expect(isError(ok)).toBe(false);
  });

  it("gives the tools only to run threads, and the skill to every thread", async () => {
    const { harness } = await setup();
    const runThread = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { diffReviewRunId: "0123456789ab" } }));
    expect(runThread.tools.map((entry) => entry.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(runThread.skills).toEqual(["diff-review"]);
    const other = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(other.tools).toEqual([]);
    expect(other.skills).toEqual(["diff-review"]);
  });

  it("lets a review run comment on lines shown in the diff, and says which are when they are not", async () => {
    const { harness, rpc, view } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    const ok = await tool(harness, "diff_review_comment", { file: "src/a.ts", startLine: 2, severity: "must-fix", body: "b must stay 2" }, run.threadId!);
    expect(textOf(ok)).toMatch(/^Added [0-9a-f]{12} on src\/a.ts:2 \(new side\)\.$/);
    const bad = await tool(harness, "diff_review_comment", { file: "src/a.ts", startLine: 9, body: "x" }, run.threadId!);
    expect(isError(bad)).toBe(true);
    expect(textOf(bad)).toContain("Lines shown there: 1-2.");
    const gone = await tool(harness, "diff_review_comment", { file: "nope.ts", startLine: 1, body: "x" }, run.threadId!);
    expect(textOf(gone)).toContain("nope.ts is not in the diff under review.");
    await tool(harness, "diff_review_general_comment", { body: "One must-fix." }, run.threadId!);

    const { threads } = await sessionState(rpc, sessionId);
    expect(threads.map((row) => [row.filePath, row.startLine, row.severity, row.anchorContent, row.comments[0]!.authorType])).toEqual([
      ["src/a.ts", 2, "must-fix", "const b = 3;", "agent"],
      ["__general__", 0, null, null, "agent"],
    ]);
    // The thread under review is not a review run: it answers, it does not comment.
    expect(isError(await tool(harness, "diff_review_comment", { file: "src/a.ts", startLine: 2, body: "x" }, THREAD))).toBe(true);
    // A review run may resolve any thread of its review, through the tool or the command.
    const general = threads[1]!;
    const resolved = await harness.behavior.runCli(["resolve", general.id, "Summary", "posted."], { threadId: run.threadId! });
    expect(resolved.exitCode).toBe(0);
  });

  it("closes a review run when its turn ends, listing files that changed while it ran", async () => {
    const { harness, rpc, view, workspace } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    workspace.extraFile = true;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: run.threadId!, environmentId: ENV }), lastAssistantText: "1 must-fix" });
    const [finished] = (await sessionState(rpc, sessionId)).runs;
    expect(finished).toMatchObject({ status: "done", summary: "1 must-fix", changedFiles: ["src/new.ts"] });
  });

  it("sends an @reviewer question to the view's reviewer as a follow-up turn, which answers with a review run's rights", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: run.threadId!, environmentId: ENV }), lastAssistantText: "1 must-fix" });
    expect((await sessionState(rpc, sessionId)).runs[0]!.status).toBe("done");

    const thread = await comment(sessionId, "@reviewer is this right?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    const send = harness.inspection.sdk.callsTo("threads.send")[0]![0] as { threadId: string; mode: string; input: { text: string }[] };
    expect(send).toMatchObject({ threadId: run.threadId, mode: "queue-if-active" });
    expect(send.input[0]!.text).toContain("The user asked you, the reviewer of this view");
    expect(send.input[0]!.text).toContain(`- Thread: \`${thread.id}\``);
    expect(send.input[0]!.text).toContain(REPORT_LINE);
    const state = await sessionState(rpc, sessionId);
    expect(state.runs).toMatchObject([{ id: run.id, status: "running" }]);
    expect(state.threads[0]!.delivery).toMatchObject({ state: "sent", threadId: run.threadId });

    // The follow-up turn still has a review run's rights: it answers, and may comment.
    expect(isError(await tool(harness, "diff_review_reply", { threadId: thread.id, text: "Yes: b is 3 on purpose." }, run.threadId!))).toBe(false);
    expect(isError(await tool(harness, "diff_review_general_comment", { body: "Also check c." }, run.threadId!))).toBe(false);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: run.threadId!, environmentId: ENV }), lastAssistantText: "Answered." });
    expect((await sessionState(rpc, sessionId)).runs).toMatchObject([{ id: run.id, status: "done", summary: "Answered." }]);

    // @agent means the same.
    await comment(sessionId, "@agent and this one?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2));
    expect((harness.inspection.sdk.callsTo("threads.send")[1]![0] as { threadId: string }).threadId).toBe(run.threadId);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("starts a reviewer for a view without one, which then takes the next questions", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const first = await comment(sessionId, "@agent why 3?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
    const spawn = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(spawn).toMatchObject({ providerId: "claude-code", permissionMode: "auto", parentThreadId: THREAD, title: "Reviewer: src/a.ts:2 (new side)" });
    // The settings' provider at its default model, as no model is set.
    expect(spawn.model).toBeUndefined();
    expect(spawn.prompt).toContain("You are the reviewer of a diff in Diff Review");
    expect(spawn.prompt).toContain(`- Thread: \`${first.id}\``);
    await vi.waitFor(async () => expect((await sessionState(rpc, sessionId)).threads[0]!.delivery).toMatchObject({ state: "sent", threadId: "thr_run_1" }));
    expect((await sessionState(rpc, sessionId)).runs).toMatchObject([{ kind: "review", threadId: "thr_run_1" }]);

    await comment(sessionId, "@reviewer and here?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    expect((harness.inspection.sdk.callsTo("threads.send")[0]![0] as { threadId: string }).threadId).toBe("thr_run_1");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);

    // Once closed, it is no longer the reviewer: the next question starts another.
    const [reviewer] = (await sessionState(rpc, sessionId)).runs;
    await rpc("closeRun", { runId: reviewer!.id });
    await comment(sessionId, "@reviewer again?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2));
  });

  it("starts a new reviewer when the reviewer's thread is gone", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    harness.sdk.stub("threads.send", async () => {
      throw new Error("thread is archived");
    });
    await comment(sessionId, "@reviewer still there?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2));
    await vi.waitFor(async () => expect((await sessionState(rpc, sessionId)).runs.map((run) => run.threadId)).toEqual(["thr_run_2"]));
  });

  it("starts nothing for provider names, which no longer start agents", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    await comment(sessionId, "@claude, @codex or @opencode: why?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("never sends one question twice: concurrent questions start one reviewer, and a thread already queued is not queued again", async () => {
    // The reviewer's latest turn started at 1, before any question: a question sent now waits behind it.
    const { harness, rpc, view, comment } = await setup({ turnStarts: [1] });
    const { sessionId } = await view();
    const a = await comment(sessionId, "Why?");
    const b = await comment(sessionId, "And this?");
    await Promise.all([
      rpc("addComment", { reviewThreadId: a.id, body: "@reviewer?" }),
      rpc("addComment", { reviewThreadId: b.id, body: "@agent?" }),
    ]);
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    // Asked again while its question is still queued: the queued turn reads the thread as it is then.
    await rpc("addComment", { reviewThreadId: b.id, body: "@agent, and also this?" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("keeps a reviewer running while a question is queued behind its turn", async () => {
    const { harness, rpc, view, comment, turnStarts } = await setup({ turnStarts: [1] });
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    await comment(sessionId, "@reviewer while you review?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    // The review's own turn ends; the question was queued after it started, so the next turn takes it.
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: run.threadId!, environmentId: ENV }), lastAssistantText: "Review done." });
    expect((await sessionState(rpc, sessionId)).runs[0]!.status).toBe("running");
    // The next turn ends without answering it: no reply, and the run is done.
    turnStarts.splice(0, turnStarts.length, Date.now() + 60_000);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: run.threadId!, environmentId: ENV }), lastAssistantText: "Nothing." });
    const state = await sessionState(rpc, sessionId);
    expect(state.runs[0]!.status).toBe("done");
    expect(state.threads[0]!.delivery!.state).toBe("no_reply");
  });

  it("does not ask the reviewer for a mention inside code", async () => {
    const { harness, view, comment } = await setup();
    const { sessionId } = await view();
    await comment(sessionId, "Rename `@reviewer` here");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("fixes in a new thread: the comments go there, and only that thread may answer them", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Use a constant");
    const result = (await rpc("fixInNewThread", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "Small please", execution })) as { run: Run; count: number };
    expect(result).toMatchObject({ count: 1, run: { kind: "fix", threadId: "thr_run_1", status: "running" } });
    const spawn = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as { prompt: string; title: string; parentThreadId?: string };
    expect(spawn.title).toBe("Review fixes: 1 comment");
    expect(spawn.parentThreadId).toBe(THREAD);
    expect(spawn.prompt).toContain(REPORT_LINE);
    expect(spawn.prompt).toContain(`### Thread \`${thread.id}\``);
    expect(spawn.prompt).toContain("Small please");
    const refused = await harness.behavior.runCli(["resolve", thread.id, "Fixed."], { threadId: THREAD });
    expect(refused.stderr).toContain("was not sent to this thread");
    const resolved = await tool(harness, "diff_review_resolve", { threadId: thread.id, text: "Fixed: added a constant." }, "thr_run_1");
    expect(isError(resolved)).toBe(false);
    expect((await sessionState(rpc, sessionId)).threads[0]!.status).toBe("resolved");
  });

  it("starts runs in Accept edits mode when the settings say so", async () => {
    const { harness, rpc, view } = await setup();
    await harness.behavior.setSettings({ aiPermissionMode: "accept-edits" });
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({ permissionMode: "accept-edits" });
    expect(((await rpc("runDefaults", { threadId: THREAD })) as { permissionMode: string }).permissionMode).toBe("accept-edits");
  });

  it("starts a run in full mode when its provider does not support the configured mode", async () => {
    const { harness, rpc, view } = await setup({ providerModes: { "acp-opencode": ["accept-edits", "full"], "claude-code": ["auto", "accept-edits", "full"] } });
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution: { ...execution, providerId: "acp-opencode" } });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({ providerId: "acp-opencode", permissionMode: "full" });
    // A provider that supports the configured mode keeps it.
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[1]![0]).toMatchObject({ providerId: "claude-code", permissionMode: "auto" });
  });

  it("starts a run without a parent when the tab's thread works in another workspace", async () => {
    const { harness, rpc, view } = await setup({ threads: { [THREAD]: { environmentId: ENV }, thr_elsewhere: { environmentId: "env_2" } } });
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: "thr_elsewhere", focuses: [], instructions: "", execution });
    expect((harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as { parentThreadId?: string }).parentThreadId).toBeUndefined();
  });

  it("tells a thread with run children that their completion notices are reports, and no other thread", async () => {
    const { harness, rpc, view } = await setup();
    const { sessionId } = await view();
    const instructions = harness.inspection.registrations.instructionProvider!;
    expect(instructions({ threadId: THREAD, projectId: "proj_1" })).toBeNull();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    expect(instructions({ threadId: THREAD, projectId: "proj_1" })).toContain("are status reports");
    expect(instructions({ threadId: "thr_run_1", projectId: "proj_1" })).toBeNull();
  });

  it("never starts a run from an agent's comment, so a run's report cannot set off another run", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Why?");
    await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" });
    await harness.behavior.runCli(["reply", thread.id, "Ask", "@reviewer", "about", "it."], { threadId: THREAD });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("shows a run whose thread could not start as failed, with the reason", async () => {
    const { rpc, view } = await setup({ spawnFails: true });
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    expect(run).toMatchObject({ status: "failed", threadId: null, summary: "Could not start the thread: provider not installed" });
  });

  it("closes a run by archiving its thread", async () => {
    const { harness, rpc, view } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    await rpc("closeRun", { runId: run.id });
    expect(harness.inspection.sdk.callsTo("threads.archive")[0]![0]).toMatchObject({ threadId: run.threadId });
    expect((await sessionState(rpc, sessionId)).runs).toEqual([]);
  });

  it("clears a review: every thread of the view goes, its runs close and their threads are archived, and the runs lose their rights", async () => {
    const { harness, rpc, view, comment } = await setup();
    const { sessionId } = await view();
    const other = await view({ kind: "branch" });
    const kept = await comment(other.sessionId, "Another view's comment");
    const { run: review } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    await tool(harness, "diff_review_general_comment", { body: "Looks fine." }, review.threadId!);
    const mine = await comment(sessionId, "Use a constant");
    await rpc("setStatus", { reviewThreadId: mine.id, status: "resolved" });
    const fix = await comment(sessionId, "Rename b");
    const { run: fixRun } = (await rpc("fixInNewThread", { sessionId, threadId: THREAD, reviewThreadIds: [fix.id], note: "", execution })) as { run: Run };

    expect(await rpc("clearReview", { sessionId })).toEqual({ deletedThreads: 3, closedRuns: 2 });
    expect(await sessionState(rpc, sessionId)).toEqual({ threads: [], runs: [] });
    expect(harness.inspection.sdk.callsTo("threads.archive").map((call) => (call[0] as { threadId: string }).threadId).sort()).toEqual([review.threadId, fixRun.threadId].sort());
    // Another view's review is not this one.
    expect((await sessionState(rpc, other.sessionId)).threads.map((row) => row.id)).toEqual([kept.id]);

    // A run still working when its thread is archived can no longer comment or answer.
    expect(isError(await tool(harness, "diff_review_general_comment", { body: "Late." }, review.threadId!))).toBe(true);
    expect(isError(await tool(harness, "diff_review_resolve", { threadId: fix.id, text: "Fixed." }, fixRun.threadId!))).toBe(true);
    expect((await sessionState(rpc, sessionId)).threads).toEqual([]);
    // The parent keeps the notice instructions: bb may still report the archived runs to it.
    expect(harness.inspection.registrations.instructionProvider!({ threadId: THREAD, projectId: "proj_1" })).toContain("are status reports");

    // The tab starts fresh: new comments and runs work as before.
    await comment(sessionId, "After the clear");
    expect((await sessionState(rpc, sessionId)).threads).toHaveLength(1);
  });

  it("drops a review run's comment that was in flight when Clear review closed the run", async () => {
    // Hold the author lookup, the last thing the comment awaits before it is stored.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { harness, rpc, view } = await setup({ holdThreadGet: (threadId) => (threadId === "thr_run_1" ? gate : Promise.resolve()) });
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    const late = tool(harness, "diff_review_general_comment", { body: "Late finding." }, run.threadId!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rpc("clearReview", { sessionId });
    release();
    expect(isError(await late)).toBe(true);
    expect((await sessionState(rpc, sessionId)).threads).toEqual([]);
  });

  it("archives a run's thread that bb started after the run was closed, and sends it nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { harness, rpc, view, comment } = await setup({ holdSpawn: () => gate });
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Rename b");
    const fixing = rpc("fixInNewThread", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "", execution });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await rpc("clearReview", { sessionId })).toEqual({ deletedThreads: 1, closedRuns: 1 });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    release();
    const { run } = (await fixing) as { run: Run };
    expect(run).toMatchObject({ status: "closed", threadId: "thr_run_1" });
    expect(harness.inspection.sdk.callsTo("threads.archive").map((call) => (call[0] as { threadId: string }).threadId)).toEqual(["thr_run_1"]);
    expect(await sessionState(rpc, sessionId)).toEqual({ threads: [], runs: [] });
  });

  // Review loop, pass 1 (findings numbered as in the review).

  it("1: tells the tabs to reload after an edit that keeps an on-demand file's line counts", async () => {
    const { harness, view, workspace } = await setup();
    await view();
    const diffSignals = () => harness.inspection.realtimeSignals.filter((signal) => (signal.payload as { kind: string }).kind === "diff").length;
    const idle = () => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: THREAD, environmentId: ENV }), lastAssistantText: "done" });
    await idle();
    expect(diffSignals()).toBe(0);
    // big.txt loads on demand; its patch changes, its kind and line counts do not.
    workspace.bigVersion = 2;
    await idle();
    expect(diffSignals()).toBe(1);
  });

  it("2: refuses an answer whose send moved to another thread while bb looked up the author, leaving every row as it was", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    const { harness, rpc, view, comment } = await setup({
      threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: ENV } },
      holdThreadGet: (threadId) => (armed && threadId === THREAD ? gate : Promise.resolve()),
    });
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Rename b");
    await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" });
    armed = true;
    const late = harness.behavior.runCli(["resolve", thread.id, "Done."], { threadId: THREAD });
    await new Promise((resolve) => setTimeout(resolve, 10));
    armed = false;
    await rpc("send", { sessionId, threadId: "thr_other", reviewThreadIds: [thread.id], note: "" });
    release();
    expect((await late).stderr).toContain("was not sent to this thread");
    const [row] = (await sessionState(rpc, sessionId)).threads;
    expect(row).toMatchObject({ status: "open", delivery: { state: "sent", threadId: "thr_other" } });
    expect(row!.comments).toHaveLength(1);
  });

  it("2 and 6: a closed run loses its rights from sends too, after Close and for an answer already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    const { harness, rpc, view, comment } = await setup({ holdThreadGet: (threadId) => (armed && threadId === "thr_run_1" ? gate : Promise.resolve()) });
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    const asked = await comment(sessionId, "@reviewer why?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    armed = true;
    const inFlight = tool(harness, "diff_review_reply", { threadId: asked.id, text: "Late." }, run.threadId!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    armed = false;
    await rpc("closeRun", { runId: run.id });
    release();
    expect(isError(await inFlight)).toBe(true);
    // After Close: the question sent to it is neither listed nor answerable.
    expect(textOf(await tool(harness, "diff_review_threads", {}, run.threadId!))).toBe("No open review threads for this thread.");
    expect(isError(await tool(harness, "diff_review_resolve", { threadId: asked.id, text: "Done." }, run.threadId!))).toBe(true);
    expect((await sessionState(rpc, sessionId)).threads[0]!.comments).toHaveLength(1);
    // The thread under review keeps the rights its sends give it.
    await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [asked.id], note: "" });
    expect(isError(await tool(harness, "diff_review_reply", { threadId: asked.id, text: "Here." }, THREAD))).toBe(false);
  });

  it("3: Clear review cancels starts still on their way, before and after their run is written", async () => {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    const { harness, rpc, view, comment } = await setup({ holdEnvironmentGet: () => (armed ? gate : Promise.resolve()) });
    const { sessionId } = await view();
    armed = true;
    // An AI review held on its first read of bb.
    const review = rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await rpc("clearReview", { sessionId })).toEqual({ deletedThreads: 0, closedRuns: 1 });
    release();
    expect(((await review) as RunResult).run.status).toBe("closed");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);

    // A question to a view without a reviewer, held the same way: no reviewer appears afterwards.
    gate = new Promise<void>((resolve) => (release = resolve));
    await comment(sessionId, "@reviewer why?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rpc("clearReview", { sessionId });
    release();
    armed = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(await sessionState(rpc, sessionId)).toEqual({ threads: [], runs: [] });
  });

  it("3: a question waiting on the reviewer's turn lookup sends nothing once the review is cleared", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    const { harness, rpc, view, comment } = await setup({ turnStarts: [1], holdEvents: () => (armed ? gate : Promise.resolve()) });
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    const asked = await comment(sessionId, "@reviewer why?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    armed = true;
    await rpc("addComment", { reviewThreadId: asked.id, body: "@reviewer again?" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rpc("clearReview", { sessionId });
    armed = false;
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(await sessionState(rpc, sessionId)).toEqual({ threads: [], runs: [] });
  });

  it("4: a fix run's thread can answer, and end its turn, before bb has answered its start", async () => {
    let early: { answered: boolean; listed: string } | null = null;
    const context: { harness?: Awaited<ReturnType<typeof setup>>["harness"] } = {};
    const { harness, rpc, view, comment } = await setup({
      duringSpawn: async (threadId) => {
        const h = context.harness!;
        const listed = textOf(await tool(h, "diff_review_threads", {}, threadId));
        const answered = !isError(await tool(h, "diff_review_resolve", { threadId: listed.slice(0, 12), text: "Fixed: a constant." }, threadId));
        await h.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, environmentId: ENV }), lastAssistantText: "Fixed." });
        early = { answered, listed };
      },
    });
    context.harness = harness;
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Use a constant");
    const { run } = (await rpc("fixInNewThread", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "", execution })) as { run: Run };
    expect(early).toMatchObject({ answered: true });
    expect(early!.listed.startsWith(thread.id)).toBe(true);
    expect(run).toMatchObject({ threadId: "thr_run_1", status: "done", summary: "Fixed." });
    expect((await sessionState(rpc, sessionId)).threads[0]).toMatchObject({ status: "resolved", delivery: { state: "answered", threadId: "thr_run_1" } });
  });

  it("4: a review run's thread can comment before bb has answered its start", async () => {
    const context: { harness?: Awaited<ReturnType<typeof setup>>["harness"]; result?: unknown } = {};
    const { harness, rpc, view } = await setup({
      duringSpawn: async (threadId) => {
        context.result = await tool(context.harness!, "diff_review_general_comment", { body: "Early." }, threadId);
      },
    });
    context.harness = harness;
    const { sessionId } = await view();
    await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution });
    expect(isError(context.result)).toBe(false);
    expect((await sessionState(rpc, sessionId)).threads.map((row) => row.comments[0]!.body)).toEqual(["Early."]);
  });

  it("4: a thread that only claims a run in its metadata, but was not started by the plugin, gains nothing", async () => {
    const { harness, rpc, view, comment } = await setup({ threads: { [THREAD]: { environmentId: ENV }, thr_intruder: { environmentId: ENV } } });
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Use a constant");
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ diffReviewRunId: "0123456789ab" }));
    expect(isError(await tool(harness, "diff_review_resolve", { threadId: thread.id, text: "Mine now." }, "thr_intruder"))).toBe(true);
    void rpc;
  });

  it("5: a question asked again after the reviewer's turn took the first gets a turn of its own, and the earlier answer does not count for it", async () => {
    const { harness, rpc, view, comment, turnStarts } = await setup({ turnStarts: [1] });
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const asked = await comment(sessionId, "@reviewer why 3?");
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1));
    // Still queued behind the review's own turn: asking again adds nothing.
    await rpc("addComment", { reviewThreadId: asked.id, body: "@reviewer (still why?)" });
    await pause();
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    // The turn that takes the question starts; a new question now needs a turn of its own.
    await pause();
    turnStarts.splice(0, turnStarts.length, Date.now());
    await pause();
    await rpc("addComment", { reviewThreadId: asked.id, body: "@reviewer and what about 4?" });
    await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2));
    // That turn answers the first question: the second stays waiting.
    await tool(harness, "diff_review_reply", { threadId: asked.id, text: "3 because of b." }, run.threadId!);
    expect((await sessionState(rpc, sessionId)).threads[0]!.delivery!.state).toBe("sent");
    // The next turn answers it.
    await pause();
    turnStarts.splice(0, turnStarts.length, Date.now());
    await tool(harness, "diff_review_reply", { threadId: asked.id, text: "4 would break c." }, run.threadId!);
    expect((await sessionState(rpc, sessionId)).threads[0]!.delivery!.state).toBe("answered");
  });

  it("7: a failed resend gives the thread back to the agent it was sent to before", async () => {
    const { harness, rpc, view, comment } = await setup({ threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: ENV } } });
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Rename b");
    await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" });
    harness.sdk.stub("threads.send", async (input: { threadId: string }) => {
      if (input.threadId === "thr_other") throw new Error("thread is archived");
      return { ok: true as const, delivery: "sent" as const };
    });
    await expect(rpc("send", { sessionId, threadId: "thr_other", reviewThreadIds: [thread.id], note: "" })).rejects.toThrow("thread is archived");
    expect((await sessionState(rpc, sessionId)).threads[0]!.delivery).toMatchObject({ state: "sent", threadId: THREAD });
    expect(isError(await tool(harness, "diff_review_reply", { threadId: thread.id, text: "On it." }, THREAD))).toBe(false);
  });

  describe("9: overlapping failed sends", () => {
    /** Sends to thr_a and thr_b wait until the test settles them; sends to THREAD succeed. */
    async function overlapping() {
      const settle: Record<string, { resolve: () => void; reject: (error: Error) => void }> = {};
      const context = await setup({ threads: { [THREAD]: { environmentId: ENV }, thr_a: { environmentId: ENV }, thr_b: { environmentId: ENV } } });
      const { harness, rpc, view, comment } = context;
      harness.sdk.stub("threads.send", (input: { threadId: string }) =>
        input.threadId === THREAD
          ? Promise.resolve({ ok: true as const, delivery: "sent" as const })
          : new Promise((resolve, reject) => (settle[input.threadId] = { resolve: () => resolve({ ok: true as const, delivery: "sent" as const }), reject })),
      );
      const { sessionId } = await view();
      const thread = await comment(sessionId, "Rename b");
      await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" });
      const toA = rpc("send", { sessionId, threadId: "thr_a", reviewThreadIds: [thread.id], note: "" });
      const toB = rpc("send", { sessionId, threadId: "thr_b", reviewThreadIds: [thread.id], note: "" });
      await vi.waitFor(() => expect(Object.keys(settle).sort()).toEqual(["thr_a", "thr_b"]));
      const delivery = async () => (await sessionState(rpc, sessionId)).threads[0]!.delivery;
      return { ...context, sessionId, thread, settle, toA, toB, delivery };
    }

    it("the earlier failing first, then the later: the thread goes back to its first, delivered send", async () => {
      const { harness, settle, toA, toB, thread, delivery } = await overlapping();
      settle.thr_a!.reject(new Error("a is archived"));
      await expect(toA).rejects.toThrow("a is archived");
      expect(await delivery()).toMatchObject({ state: "sent", threadId: "thr_b" });
      settle.thr_b!.reject(new Error("b is archived"));
      await expect(toB).rejects.toThrow("b is archived");
      expect(await delivery()).toMatchObject({ state: "sent", threadId: THREAD });
      expect(isError(await tool(harness, "diff_review_reply", { threadId: thread.id, text: "On it." }, THREAD))).toBe(false);
    });

    it("the later failing first, then the earlier: the same", async () => {
      const { harness, settle, toA, toB, thread, delivery } = await overlapping();
      settle.thr_b!.reject(new Error("b is archived"));
      await expect(toB).rejects.toThrow("b is archived");
      expect(await delivery()).toMatchObject({ state: "sent", threadId: "thr_a" });
      settle.thr_a!.reject(new Error("a is archived"));
      await expect(toA).rejects.toThrow("a is archived");
      expect(await delivery()).toMatchObject({ state: "sent", threadId: THREAD });
      expect(isError(await tool(harness, "diff_review_reply", { threadId: thread.id, text: "On it." }, THREAD))).toBe(false);
    });

    it("a later send that succeeds keeps the thread when an earlier one fails", async () => {
      const { settle, toA, toB, delivery } = await overlapping();
      settle.thr_b!.resolve();
      await toB;
      settle.thr_a!.reject(new Error("a is archived"));
      await expect(toA).rejects.toThrow("a is archived");
      expect(await delivery()).toMatchObject({ state: "sent", threadId: "thr_b" });
    });
  });

  describe("10: a fixer closed while it is being set up", () => {
    async function pendingFixer(opts: { sentBefore: boolean; sentMeanwhile?: boolean }) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let armed = false;
      const context = await setup({
        threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: ENV } },
        holdEnvironmentGet: () => (armed ? gate : Promise.resolve()),
      });
      const { harness, rpc, view, comment } = context;
      const { sessionId } = await view();
      const thread = await comment(sessionId, "Use a constant");
      if (opts.sentBefore) await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" });
      armed = true;
      const fixing = rpc("fixInNewThread", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "", execution });
      await vi.waitFor(async () => expect((await sessionState(rpc, sessionId)).runs).toHaveLength(1));
      armed = false;
      if (opts.sentMeanwhile === true) await rpc("send", { sessionId, threadId: "thr_other", reviewThreadIds: [thread.id], note: "" });
      const [run] = (await sessionState(rpc, sessionId)).runs;
      await rpc("closeRun", { runId: run!.id });
      release();
      const { run: closed } = (await fixing) as { run: Run };
      expect(closed.status).toBe("closed");
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      return { ...context, sessionId, thread, row: (await sessionState(rpc, sessionId)).threads[0]! };
    }

    it("gives the comment back to the thread it was sent to before", async () => {
      const { harness, thread, row } = await pendingFixer({ sentBefore: true });
      expect(row.delivery).toMatchObject({ state: "sent", threadId: THREAD });
      expect(isError(await tool(harness, "diff_review_reply", { threadId: thread.id, text: "On it." }, THREAD))).toBe(false);
    });

    it("leaves a comment never sent before unsent, so the send dialog offers it again", async () => {
      const { row } = await pendingFixer({ sentBefore: false });
      expect(row.delivery).toBeNull();
    });

    it("keeps a send made to another thread meanwhile", async () => {
      const { row } = await pendingFixer({ sentBefore: true, sentMeanwhile: true });
      expect(row.delivery).toMatchObject({ state: "sent", threadId: "thr_other" });
    });
  });

  it("8: a turn's end does not mark a send made while it was being closed out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    const { harness, rpc, view, comment, turnStarts } = await setup({
      threads: { [THREAD]: { environmentId: ENV }, thr_other: { environmentId: ENV } },
      holdEvents: (threadId) => (armed && threadId === THREAD ? gate : Promise.resolve()),
    });
    const { sessionId } = await view();
    const thread = await comment(sessionId, "Rename b");
    await rpc("send", { sessionId, threadId: THREAD, reviewThreadIds: [thread.id], note: "" });
    // THREAD's turn that took the send ends without answering; its close-out is held on bb.
    turnStarts.splice(0, turnStarts.length, Date.now() + 60_000);
    armed = true;
    const ended = harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: THREAD, environmentId: ENV }), lastAssistantText: "done" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    armed = false;
    await rpc("send", { sessionId, threadId: "thr_other", reviewThreadIds: [thread.id], note: "" });
    release();
    await ended;
    expect((await sessionState(rpc, sessionId)).threads[0]!.delivery).toMatchObject({ state: "sent", threadId: "thr_other" });
  });

  it("lets a review run comment through the command too, on the whole diff with --general", async () => {
    const { harness, rpc, view } = await setup();
    const { sessionId } = await view();
    const { run } = (await rpc("startReview", { sessionId, threadId: THREAD, focuses: [], instructions: "", execution })) as RunResult;
    const general = await harness.behavior.runCli(["comment", "--general", "No", "issues", "found."], { threadId: run.threadId! });
    expect(general).toMatchObject({ exitCode: 0 });
    const line = await harness.behavior.runCli(["comment", "src/a.ts", "--line", "1", "--severity", "nit", "Name", "it", "better."], { threadId: run.threadId! });
    expect(line.stdout).toContain("on src/a.ts:1 (new side)");
    expect((await sessionState(rpc, sessionId)).threads.map((row) => row.comments[0]!.body)).toEqual(["No issues found.", "Name it better."]);
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
      /^(vitest|vitest\/config|@testing-library\/react|esbuild|playwright-core)$/,
    ];
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
