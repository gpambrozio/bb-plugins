import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS } from "../shared/gate";
import type { ProjectInput } from "../shared/types";
import { manifestLine } from "../server/prompt";
import { createDreams } from "./dreams";
import { resolveMemory } from "./memory";
import { insideBbData } from "./workspace-root";
import { lastConsolidatedAt, lockPath } from "./lock";
import { projectSlug } from "./slug";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let root: string;
let home: string;
let checkout: string;
let memory: string;
let projects: string;
let clock: number;

function write(file: string, content: string, mtimeMs?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function session(folder: string, id: string, ageMs: number, title = `Session ${id}`): string {
  const file = path.join(projects, folder, `${id}.jsonl`);
  write(file, `${JSON.stringify({ type: "user", message: "hi" })}\n${JSON.stringify({ type: "ai-title", aiTitle: title })}\n`, clock - ageMs);
  return file;
}

const worktreeFolder = "-x--bb-plugins-environment-git-worktree-host-data-worktrees-thr-abc123-1-app";

function project(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return { projectId: "proj_app", name: "app", checkout, enabled: true, worktreeFolders: [worktreeFolder], ...overrides };
}

function dreams(overrides: Partial<Parameters<typeof createDreams>[0]> = {}) {
  return createDreams({
    // As bb lays it out: the plugin's host data inside bb's data folder, workspaces outside it.
    dataDir: path.join(root, "bbdata", "plugins", "dream", "host-data"),
    workspacesRoot: path.join(root, "cache", "bb-dream", "workspaces"),
    home,
    env: {},
    managedDirs: [path.join(root, "managed")],
    platform: process.platform,
    pid: process.pid,
    nodePath: process.execPath,
    electron: false,
    guardSource: "// guard\n",
    now: () => clock,
    lockSettle: { settleMs: 0, sleep: async () => undefined },
    ...overrides,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-host-")));
  home = path.join(root, "home");
  checkout = path.join(root, "repos", "app");
  projects = path.join(home, ".claude", "projects");
  memory = path.join(projects, projectSlug(checkout), "memory");
  clock = Date.now();
  mkdirSync(path.join(checkout, ".git"), { recursive: true });
  write(path.join(checkout, "CLAUDE.md"), "# rules\n");
  write(path.join(memory, "MEMORY.md"), "- [Build](build.md) — make\n", clock - 10 * DAY);
  write(path.join(memory, "build.md"), "builds with make\n", clock - 10 * DAY);
  utimesSync(memory, (clock - 10 * DAY) / 1000, (clock - 10 * DAY) / 1000);
  session(projectSlug(checkout), "c1", 3 * DAY);
  session(projectSlug(checkout), "c2", 2 * DAY);
  session(`${projectSlug(checkout)}--claude-worktrees-fix`, "w1", 2 * DAY);
  session(worktreeFolder, "b1", DAY);
  session(worktreeFolder, "b2", 5 * HOUR);
  session("-some-other-repo", "o1", HOUR);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("status", () => {
  it("gathers the checkout, Claude Code worktree and bb worktree folders, and says the project is due", () => {
    const [status] = dreams().status([project()], DEFAULT_THRESHOLDS);
    expect(status).toMatchObject({
      folders: 3,
      sessions: 5,
      inPlace: false,
      pendingProposal: null,
      memory: { dir: memory, source: "default", files: 2, indexLines: 1 },
      gate: { due: true, code: "due", sessionsSince: 5, lastDreamAt: null },
    });
  });

  it("lists the bb worktree folders for the server to map", () => {
    expect(dreams().scan().worktreeFolders).toEqual([{ name: worktreeFolder, threadId: "thr_abc123", repoSlug: "app" }]);
  });

  it("says when the checkout is not on this machine", () => {
    const [status] = dreams().status([project({ checkout: path.join(root, "missing") })], DEFAULT_THRESHOLDS);
    expect(status.gate.code).toBe("no-checkout");
  });
});

describe("a project's dreams", () => {
  const prepare = (host: ReturnType<typeof dreams>, runId: string, manual = false, mode: "dream" | "dry-run" | null = null) =>
    host.prepare({ runId, project: project(), mode, manual, thresholds: DEFAULT_THRESHOLDS, backupsToKeep: 20 });

  it("dry-runs first, then dreams in place once the proposal is applied", async () => {
    const host = dreams();
    const first = await prepare(host, "run1");
    if (!first.ok) throw new Error(first.reason);
    expect(first.mode).toBe("dry-run");
    expect(first.targetDir).not.toBe(memory);
    expect(first.sessionCount).toBe(5);
    expect(first.sessions.map((entry) => entry.title)).toEqual(["Session b2", "Session b1", "Session c2", "Session w1", "Session c1"]);
    expect(manifestLine(first.sessions[0])).toMatch(/^- \d{4}-\d\d-\d\d \d\d:\d\d · Session b2 · \d+ B · .*b2\.jsonl$/);
    expect(first.instructionFiles).toEqual([path.join(checkout, "CLAUDE.md")]);
    expect(readFileSync(lockPath(memory), "utf8")).toBe(String(process.pid));

    const settings = JSON.parse(readFileSync(path.join(first.workspace, ".claude", "settings.json"), "utf8"));
    expect(settings.autoMemoryDirectory).toBe(path.join(first.workspace, "startup-memory"));
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "*", hooks: [expect.objectContaining({ type: "command", onFailure: "block", timeout: 30 })] },
      { matcher: "Write", hooks: [expect.objectContaining({ type: "command", onFailure: "block", command: expect.stringContaining("--canary-fail") })] },
    ]);
    expect(JSON.parse(readFileSync(path.join(first.workspace, "policy.json"), "utf8"))).toEqual({
      memoryDir: path.join(first.workspace, "startup-memory"),
      logPath: expect.stringMatching(/runs\/run1\.log$/),
      canary: first.canary,
    });
    expect(first.canary).toBe(path.join(first.workspace, ".dream-canary.md"));

    // The dream edits the copy, and its own session lands in the workspace's folder.
    write(path.join(first.targetDir, "build.md"), "builds with ninja\n");
    session(projectSlug(first.workspace), "dream-session", 0);
    const finished = await host.finish({ runId: "run1", ok: true, summary: "Updated build.", threadId: "thr_dream1" });
    expect(finished).toMatchObject({ mode: "dry-run", changes: { changed: ["build.md"] } });
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("builds with make\n");
    expect(existsSync(lockPath(memory))).toBe(false);

    const [waiting] = host.status([project()], DEFAULT_THRESHOLDS);
    expect(waiting.gate.code).toBe("proposal-pending");
    expect((await prepare(host, "blocked")).ok).toBe(false);

    const applied = await host.apply(project(), undefined, 20);
    expect(applied.changes.changed).toEqual(["build.md"]);
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("builds with ninja\n");
    expect(lastConsolidatedAt(memory)).toBeCloseTo(clock, -1);

    clock += 4 * DAY;
    session(projectSlug(checkout), "c3", 2 * DAY);
    session(projectSlug(checkout), "c4", DAY + HOUR);
    session(projectSlug(checkout), "c5", DAY);
    session(projectSlug(checkout), "c6", 3 * HOUR);
    session(projectSlug(checkout), "c7", 2 * HOUR);
    const [due] = host.status([project()], DEFAULT_THRESHOLDS);
    expect(due).toMatchObject({ inPlace: true, gate: { due: true, sessionsSince: 5 } });

    const second = await prepare(host, "run2");
    if (!second.ok) throw new Error(second.reason);
    expect(second).toMatchObject({ mode: "dream", targetDir: memory });
    expect(second.backup).not.toBeNull();
    write(path.join(memory, "ci.md"), "ci runs nightly\n");
    const done = await host.finish({ runId: "run2", ok: true, summary: "Added ci.", threadId: "thr_dream2" });
    expect(done.changes.added).toEqual(["ci.md"]);
    expect(lastConsolidatedAt(memory)).toBeCloseTo(clock, -1);
  });

  it("puts the workspace outside bb's data folder, which refuses thread workspaces inside it", async () => {
    const run = await prepare(dreams(), "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    expect(run.workspace).toBe(path.join(root, "cache", "bb-dream", "workspaces", "proj_app"));
    expect(insideBbData(path.join(root, "bbdata"), run.workspace)).toBe(false);
  });

  it("refuses rather than spawn a workspace bb would refuse, symlinked spellings included", async () => {
    const inside = await prepare(dreams({ workspacesRoot: path.join(root, "bbdata", "plugins", "dream", "host-data", "workspaces") }), "run1", true, "dream");
    expect(inside).toMatchObject({ ok: false, code: "no-workspace" });
    mkdirSync(path.join(root, "bbdata", "plugins"), { recursive: true });
    symlinkSync(path.join(root, "bbdata"), path.join(root, "alias"));
    const aliased = await prepare(dreams({ workspacesRoot: path.join(root, "alias", "plugins", "dream", "host-data", "workspaces") }), "run2", true, "dream");
    expect(aliased).toMatchObject({ ok: false, code: "no-workspace" });
    expect(existsSync(lockPath(memory))).toBe(false);
  });

  it("starts the session on an empty memory folder, with the guard unarmed", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    const settings = JSON.parse(readFileSync(path.join(run.workspace, ".claude", "settings.json"), "utf8"));
    const startup = path.join(run.workspace, "startup-memory");
    expect(settings.autoMemoryDirectory).toBe(startup);
    expect(readdirSync(startup)).toEqual([]);
    expect(JSON.stringify(settings)).not.toContain("MEMORY.md");
    const policy = () => JSON.parse(readFileSync(path.join(run.workspace, "policy.json"), "utf8")) as { memoryDir: string; logPath: string };
    expect(policy().memoryDir).toBe(startup);
    expect(run.targetDir).toBe(memory);
  });

  it("proves the guard only when it logged the canary Write and the file does not exist, then arms it", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    const policyFile = path.join(run.workspace, "policy.json");
    const { logPath } = JSON.parse(readFileSync(policyFile, "utf8")) as { logPath: string };
    write(logPath, `${JSON.stringify({ tool: "Write", decision: "allow", canary: true })}\n`);
    expect(await host.checkCanary("run1")).toEqual({ ok: true, reason: expect.any(String) });
    expect(JSON.parse(readFileSync(policyFile, "utf8")).memoryDir).toBe(memory);
    expect((await host.checkCanary("nope")).ok).toBe(false);
  });

  it("starts only when the session's effective memory is its empty folder", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    expect(resolveMemory({ checkout: run.workspace, home, env: {}, managedDirs: [path.join(root, "managed")] }).dir).toBe(path.join(run.workspace, "startup-memory"));
  });

  it("refuses when an environment or managed memory override would beat the empty folder", async () => {
    const env = await prepare(dreams({ env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memory } }), "run1", true, "dream");
    expect(env).toMatchObject({ ok: false, code: "no-guard", reason: expect.stringContaining("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE") });
    expect(existsSync(lockPath(memory))).toBe(false);

    write(path.join(root, "managed", "managed-settings.json"), JSON.stringify({ autoMemoryDirectory: memory }));
    const managed = await prepare(dreams(), "run2", true, "dream");
    expect(managed).toMatchObject({ ok: false, code: "no-guard", reason: expect.stringContaining("policySettings") });
    expect(existsSync(lockPath(memory))).toBe(false);
  });

  it("never answers a pass with the policy unarmed, even after arming failed once", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    const policyFile = path.join(run.workspace, "policy.json");
    const policy = readFileSync(policyFile, "utf8");
    const { logPath } = JSON.parse(policy) as { logPath: string };
    write(logPath, `${JSON.stringify({ tool: "Write", decision: "allow", canary: true })}\n`);
    // The policy cannot be replaced: arming fails, and no verdict is stored.
    rmSync(policyFile);
    await expect(host.checkCanary("run1")).rejects.toThrow();
    write(policyFile, policy);
    expect(await host.checkCanary("run1")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(policyFile, "utf8")).memoryDir).toBe(memory);
    // A repeat of the stored pass arms again, should the policy have been put back meanwhile.
    write(policyFile, policy);
    expect(await dreams().checkCanary("run1")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(policyFile, "utf8")).memoryDir).toBe(memory);
  });

  it("keeps a failed check failed: asking again, after a reload or from a second copy, never passes", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    const policyFile = path.join(run.workspace, "policy.json");
    const { logPath, memoryDir: startup } = JSON.parse(readFileSync(policyFile, "utf8")) as { logPath: string; memoryDir: string };
    write(logPath, `${JSON.stringify({ tool: "Write", decision: "allow", canary: true })}\n`);
    write(run.canary, "canary");
    const first = await host.checkCanary("run1");
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining("onFailure") });
    expect(existsSync(run.canary)).toBe(true);
    rmSync(run.canary);
    expect(await dreams().checkCanary("run1")).toEqual(first);
    expect(await host.checkCanary("run1")).toEqual(first);
    expect(JSON.parse(readFileSync(policyFile, "utf8")).memoryDir).toBe(startup);
  });

  it("fails the check when the guard never saw the Write, or saw it and the file was written", async () => {
    const hooksOff = dreams();
    const run = await prepare(hooksOff, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    write(run.canary, "canary");
    expect(await hooksOff.checkCanary("run1")).toMatchObject({ ok: false, reason: expect.stringContaining("hooks did not run") });
    await hooksOff.finish({ runId: "run1", ok: false, summary: null, threadId: null });
    expect(existsSync(run.canary)).toBe(false);
  });

  it("lets a replacement host worker roll back the lock the previous worker took", async () => {
    const prior = clock - 5 * DAY;
    write(lockPath(memory), "", prior);
    utimesSync(memory, (clock - 10 * DAY) / 1000, (clock - 10 * DAY) / 1000);
    const run = await prepare(dreams({ pid: 11111, isAlive: () => false }), "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    expect(readFileSync(lockPath(memory), "utf8")).toBe("11111");
    const replacement = dreams({ pid: 22222, isAlive: () => false });
    const ended = await replacement.finish({ runId: "run1", ok: false, summary: null, threadId: null });
    expect(ended.warning).toBeNull();
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);
    expect(replacement.status([project()], DEFAULT_THRESHOLDS)[0].gate.code).not.toBe("too-soon");
  });

  it("says so when the lock could not be rolled back because another process took it", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    writeFileSync(lockPath(memory), "99999");
    const ended = await host.finish({ runId: "run1", ok: false, summary: null, threadId: null });
    expect(ended.warning).toContain("could not be set back");
  });

  it("refuses to start when a setting or variable would switch the guard off", async () => {
    write(path.join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
    expect(await prepare(dreams(), "run1", true)).toMatchObject({ ok: false, code: "no-guard", reason: expect.stringContaining("disableAllHooks") });
    rmSync(path.join(home, ".claude", "settings.json"));

    write(path.join(root, "managed", "managed-settings.json"), JSON.stringify({ allowManagedHooksOnly: true }));
    expect(await prepare(dreams(), "run2", true)).toMatchObject({ ok: false, code: "no-guard", reason: expect.stringContaining("allowManagedHooksOnly") });
    rmSync(path.join(root, "managed", "managed-settings.json"));

    expect(await prepare(dreams({ env: { CLAUDE_CODE_PERSONAL_HOOKS_OFF: "1" } }), "run3", true)).toMatchObject({ ok: false, code: "no-guard" });
    expect(await prepare(dreams({ env: { CLAUDE_CODE_SIMPLE: "1" } }), "run4", true)).toMatchObject({ ok: false, code: "no-guard" });
    expect(existsSync(lockPath(memory))).toBe(false);
  });

  it("answers a repeated finish with what it recorded, and an unknown run as not found", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    write(path.join(memory, "ci.md"), "ci\n");
    const first = await host.finish({ runId: "run1", ok: true, summary: null, threadId: null });
    const again = await host.finish({ runId: "run1", ok: true, summary: null, threadId: null });
    expect(first).toMatchObject({ found: true, changes: { added: ["ci.md"] } });
    expect(again).toEqual(first);
    expect(await host.finish({ runId: "never", ok: false, summary: null, threadId: null })).toMatchObject({ found: false });
  });

  it("never counts a dream thread's worktree folder or sessions", async () => {
    const host = dreams();
    const first = await prepare(host, "run1", true, "dream");
    if (!first.ok) throw new Error(first.reason);
    await host.finish({ runId: "run1", ok: true, summary: null, threadId: "thr_abc123" });
    const [status] = host.status([project()], { ...DEFAULT_THRESHOLDS, minHours: 0 });
    expect(status.folders).toBe(2);
    expect(status.sessions).toBe(3);
  });

  it("rolls the lock back when a dream fails, and keeps its backup to restore", async () => {
    const host = dreams();
    const prior = clock - 5 * DAY;
    write(lockPath(memory), "", prior);
    utimesSync(memory, (clock - 10 * DAY) / 1000, (clock - 10 * DAY) / 1000);
    const run = await prepare(host, "run1", false, "dream");
    if (!run.ok) throw new Error(run.reason);
    write(path.join(memory, "build.md"), "half-written\n");
    const failed = await host.finish({ runId: "run1", ok: false, summary: null, threadId: null });
    expect(failed.changes.changed).toEqual(["build.md"]);
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);

    const restored = await host.restore(project(), run.backup ?? undefined, 20);
    expect(restored.changes.changed).toEqual(["build.md"]);
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("builds with make\n");
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);
    expect(host.backups(project()).backups.map((entry) => entry.stamp)).toContain(restored.backup);
  });

  it("lets its own finished dream's lock go, so a restore right after a dream works", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dream");
    if (!run.ok) throw new Error(run.reason);
    write(path.join(memory, "build.md"), "a bad rewrite\n");
    await host.finish({ runId: "run1", ok: true, summary: null, threadId: null });
    expect(readFileSync(lockPath(memory), "utf8")).toBe(String(process.pid));
    expect(host.status([project()], DEFAULT_THRESHOLDS)[0].gate.code).not.toBe("locked");
    await host.restore(project(), undefined, 20);
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("builds with make\n");
  });

  it("refuses while the lock is held, and when the memory folder has no files", async () => {
    const host = dreams();
    write(lockPath(memory), "1", clock - 60_000);
    const locked = await prepare(host, "run1", true);
    expect(locked).toMatchObject({ ok: false, code: "locked" });
    rmSync(memory, { recursive: true, force: true });
    expect(await prepare(host, "run2", true)).toMatchObject({ ok: false, code: "no-memory" });
  });

  it("does not dream on its own when the project is not due", async () => {
    const host = dreams();
    write(lockPath(memory), "", clock - HOUR * 2);
    expect(await prepare(host, "run1")).toMatchObject({ ok: false, code: "too-soon" });
  });

  it("shows a waiting dry run's changes, and refuses when there is none", async () => {
    const host = dreams();
    const run = await prepare(host, "run1", true, "dry-run");
    if (!run.ok) throw new Error(run.reason);
    expect(() => host.proposalDiff(project(), undefined)).toThrow(/no dry run waiting/);
    write(path.join(run.targetDir, "build.md"), "builds with ninja\n");
    await host.finish({ runId: "run1", ok: true, summary: "Fixed the build tool.", threadId: null });
    expect(host.proposalDiff(project(), undefined)).toMatchObject({ stamp: run.proposal, files: [{ path: "build.md", kind: "changed", proposed: "builds with ninja\n" }] });
  });

  it("never counts a dry run as a dream: not one that proposes nothing, not a discarded one", async () => {
    const host = dreams();
    const gate = () => host.status([project()], DEFAULT_THRESHOLDS)[0].gate;
    const before = gate();
    expect(before).toMatchObject({ due: true, lastDreamAt: null, sessionsSince: 5 });

    // A dry run that proposes nothing.
    const quiet = await prepare(host, "run1");
    if (!quiet.ok) throw new Error(quiet.reason);
    await host.finish({ runId: "run1", ok: true, summary: "Already tight.", threadId: null });
    expect(lastConsolidatedAt(memory)).toBe(0);
    expect(host.status([project()], DEFAULT_THRESHOLDS)[0].pendingProposal).toBeNull();
    expect(gate()).toMatchObject({ due: true, lastDreamAt: null, baselineAt: before.baselineAt, sessionsSince: 5 });

    // A dry run that proposes changes, then is discarded.
    clock += HOUR;
    const busy = await prepare(host, "run2");
    if (!busy.ok) throw new Error(busy.reason);
    write(path.join(busy.targetDir, "new.md"), "new\n");
    await host.finish({ runId: "run2", ok: true, summary: null, threadId: null });
    const discarded = await host.discard(project(), undefined);
    expect(discarded.stamp).toBe(busy.proposal);
    expect(lastConsolidatedAt(memory)).toBe(0);
    expect(existsSync(path.join(memory, "new.md"))).toBe(false);
    expect(gate()).toMatchObject({ lastDreamAt: null, baselineAt: before.baselineAt, sessionsSince: 5 });

    // The next dry run is given every session since the last real dream, as the first one was.
    const again = await prepare(host, "run3");
    if (!again.ok) throw new Error(again.reason);
    expect(again.sessionCount).toBe(5);
  });

  it("keeps an earlier real dream as the baseline through dry runs, and moves it only on apply", async () => {
    const prior = clock - 5 * DAY;
    write(lockPath(memory), "", prior);
    utimesSync(memory, (clock - 10 * DAY) / 1000, (clock - 10 * DAY) / 1000);
    const host = dreams();
    const proposed = await prepare(host, "run1", true, "dry-run");
    if (!proposed.ok) throw new Error(proposed.reason);
    write(path.join(proposed.targetDir, "build.md"), "builds with ninja\n");
    await host.finish({ runId: "run1", ok: true, summary: null, threadId: null });
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);
    await host.discard(project(), undefined);
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);

    const applied = await prepare(host, "run2", true, "dry-run");
    if (!applied.ok) throw new Error(applied.reason);
    write(path.join(applied.targetDir, "build.md"), "builds with ninja\n");
    await host.finish({ runId: "run2", ok: true, summary: null, threadId: null });
    await host.apply(project(), undefined, 20);
    expect(lastConsolidatedAt(memory)).toBeCloseTo(clock, -1);
  });

  it("does not take the lock's own coming and going for a change to the memory", async () => {
    const host = dreams();
    const baseline = host.status([project()], DEFAULT_THRESHOLDS)[0].gate.baselineAt;
    clock += HOUR;
    const run = await prepare(host, "run1", true, "dry-run");
    if (!run.ok) throw new Error(run.reason);
    await host.finish({ runId: "run1", ok: false, summary: null, threadId: null });
    // The lock was written and removed in the memory folder; the folder's own mtime moved with it.
    expect(statSync(memory).mtimeMs).toBeGreaterThan(baseline as number);
    expect(host.status([project()], DEFAULT_THRESHOLDS)[0].gate).toMatchObject({ baselineAt: baseline, code: "due" });
  });
});
