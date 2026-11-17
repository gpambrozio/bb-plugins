import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLock, lastConsolidatedAt, lockPath, lockState, markConsolidated, rollbackLock, LOCK_STALE_MS } from "./lock";
import { applyProposal, createProposal, discardProposal, finishProposal, pendingProposal, planApply, ProposalConflictError } from "./proposals";
import { backup, diffManifests, listBackups, manifest, newestChange, pruneBackups, restoreBackup, stampOf, stampTime } from "./snapshot";
import { checkoutFolders, checkoutSlugs, listSessions, parseWorktreeFolder, sessionTitle } from "./transcripts";

let root: string;
let memory: string;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function setMtime(file: string, ms: number): void {
  utimesSync(file, ms / 1000, ms / 1000);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-files-")));
  memory = path.join(root, "memory");
  write(path.join(memory, "MEMORY.md"), "- [Build](build.md) — make\n");
  write(path.join(memory, "build.md"), "builds with make\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the consolidate lock", () => {
  const alive = () => true;
  const dead = () => false;

  it("is free with no lock, and taking it writes the PID and answers 0", () => {
    expect(lockState(memory, alive)).toEqual({ lastConsolidatedAt: 0, held: false, pid: null });
    expect(acquireLock(memory, 4242, alive)).toBe(0);
    expect(readFileSync(lockPath(memory), "utf8")).toBe("4242");
    expect(lockState(memory, alive)).toMatchObject({ held: true, pid: 4242 });
  });

  it("refuses while a live holder has it under an hour old", () => {
    expect(acquireLock(memory, 1, alive)).toBe(0);
    expect(acquireLock(memory, 2, alive)).toBeNull();
  });

  it("is stale after an hour, or when its holder died, and can be taken", () => {
    acquireLock(memory, 1, alive);
    const old = Date.now() - LOCK_STALE_MS - 1000;
    setMtime(lockPath(memory), old);
    expect(lockState(memory, alive).held).toBe(false);
    expect(acquireLock(memory, 2, alive)).toBeCloseTo(old, -2);
    expect(acquireLock(memory, 3, dead)).not.toBeNull();
  });

  it("rolls the mtime back on failure, and removes a lock that did not exist", () => {
    const prior = Date.UTC(2026, 10, 10, 3, 0, 0);
    markConsolidated(memory, prior);
    expect(lastConsolidatedAt(memory)).toBe(prior);
    const before = acquireLock(memory, 7, alive);
    expect(before).toBe(prior);
    expect(lastConsolidatedAt(memory)).toBeGreaterThan(prior);
    rollbackLock(memory, before as number);
    expect(lastConsolidatedAt(memory)).toBe(prior);
    expect(readFileSync(lockPath(memory), "utf8")).toBe("");

    rmSync(lockPath(memory));
    expect(acquireLock(memory, 7, alive)).toBe(0);
    rollbackLock(memory, 0);
    expect(existsSync(lockPath(memory))).toBe(false);
  });
});

describe("backups", () => {
  it("names backups by time and reads the name back", () => {
    const ms = Date.UTC(2026, 10, 17, 1, 5, 0, 12);
    expect(stampOf(ms)).toBe("20261117T010500012Z");
    expect(stampTime(stampOf(ms))).toBe(ms);
    expect(stampTime("nope")).toBeNull();
  });

  it("keeps the newest backups and deletes the rest", async () => {
    const backups = path.join(root, "backups");
    for (let index = 0; index < 5; index++) await backup(memory, backups, stampOf(Date.UTC(2026, 10, 10 + index)));
    expect(listBackups(backups)).toHaveLength(5);
    expect(pruneBackups(backups, 3)).toEqual([stampOf(Date.UTC(2026, 10, 11)), stampOf(Date.UTC(2026, 10, 10))]);
    expect(listBackups(backups).map((entry) => entry.stamp)).toEqual([12, 11, 10].map((day) => stampOf(Date.UTC(2026, 10, 2 + day))));
  });

  it("restores the .md files of a backup and leaves other files alone", async () => {
    const backups = path.join(root, "backups");
    write(path.join(memory, "notes.txt"), "not memory");
    write(path.join(memory, ".git", "HEAD"), "ref");
    acquireLock(memory, 1, () => true);
    const archive = await backup(memory, backups, stampOf(Date.now()));
    const before = manifest(memory);

    write(path.join(memory, "build.md"), "builds with ninja\n");
    write(path.join(memory, "new.md"), "new\n");
    rmSync(path.join(memory, "MEMORY.md"));
    rmSync(path.join(memory, "notes.txt"));

    const changes = await restoreBackup(archive, memory);
    expect(changes).toEqual({ added: ["MEMORY.md"], changed: ["build.md"], deleted: ["new.md"] });
    expect(manifest(memory)).toEqual(before);
    expect(existsSync(path.join(memory, "notes.txt"))).toBe(false);
    expect(readFileSync(path.join(memory, ".git", "HEAD"), "utf8")).toBe("ref");
  });

  it("says what changed between two manifests", () => {
    expect(diffManifests({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" })).toEqual({ added: ["d"], changed: ["b"], deleted: ["c"] });
  });

  it("reports the newest change of the folder and its .md files", () => {
    const ms = Date.UTC(2026, 10, 1);
    setMtime(path.join(memory, "MEMORY.md"), ms);
    setMtime(path.join(memory, "build.md"), ms + 1000);
    setMtime(memory, ms);
    expect(newestChange(memory)).toBe(ms + 1000);
    expect(newestChange(path.join(root, "missing"))).toBeNull();
  });
});

describe("dry-run proposals", () => {
  const proposals = () => path.join(root, "proposals");

  it("works on a copy and applies only what the dream changed", () => {
    write(path.join(memory, ".consolidate-lock"), "1");
    const proposal = createProposal(memory, proposals(), "20261117T010500000Z");
    expect(existsSync(path.join(proposal.memoryDir, ".consolidate-lock"))).toBe(false);
    write(path.join(proposal.memoryDir, "build.md"), "builds with ninja\n");
    write(path.join(proposal.memoryDir, "ci.md"), "ci runs nightly\n");
    const ready = finishProposal(proposal, true, "Updated build, added ci.");
    expect(ready.changes).toEqual({ added: ["ci.md"], changed: ["build.md"], deleted: [] });
    expect(pendingProposal(proposals())?.stamp).toBe("20261117T010500000Z");
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("builds with make\n");

    // A session adds a memory meanwhile; applying keeps it.
    write(path.join(memory, "fresh.md"), "fresh\n");
    const plan = planApply(ready, memory);
    applyProposal(ready, memory, plan);
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("builds with ninja\n");
    expect(readFileSync(path.join(memory, "ci.md"), "utf8")).toBe("ci runs nightly\n");
    expect(existsSync(path.join(memory, "fresh.md"))).toBe(true);
    expect(pendingProposal(proposals())).toBeNull();
  });

  it("refuses to apply over a file that changed since the dry run", () => {
    const proposal = createProposal(memory, proposals(), "20261117T010500000Z");
    rmSync(path.join(proposal.memoryDir, "build.md"));
    const ready = finishProposal(proposal, true, null);
    write(path.join(memory, "build.md"), "a session edited this\n");
    expect(() => planApply(ready, memory)).toThrow(ProposalConflictError);
    expect(readFileSync(path.join(memory, "build.md"), "utf8")).toBe("a session edited this\n");
  });

  it("stops waiting once discarded, and a failed dry run never waits", () => {
    const first = finishProposal(createProposal(memory, proposals(), "20261117T010500000Z"), false, null);
    expect(first.status).toBe("failed");
    expect(pendingProposal(proposals())).toBeNull();
    const second = finishProposal(createProposal(memory, proposals(), "20261118T010500000Z"), true, null);
    discardProposal(second);
    expect(pendingProposal(proposals())).toBeNull();
    expect(() => planApply({ ...second, status: "discarded" }, memory)).toThrow(/discarded/);
  });
});

describe("transcript folders", () => {
  it("reads the thread id and repository from a bb worktree folder", () => {
    expect(parseWorktreeFolder("-Users-me--bb-plugins-environment-git-worktree-host-data-worktrees-thr-298qbrpuqf-1-bb-plugins")).toEqual({
      name: "-Users-me--bb-plugins-environment-git-worktree-host-data-worktrees-thr-298qbrpuqf-1-bb-plugins",
      threadId: "thr_298qbrpuqf",
      repoSlug: "bb-plugins",
    });
    expect(parseWorktreeFolder("-data-bb-plugins-environment-git-worktree-host-data-worktrees-thr-abc-12-my-app")?.repoSlug).toBe("my-app");
    expect(parseWorktreeFolder("-Users-me-repositories-bb-plugins")).toBeNull();
  });

  it("finds a checkout's own folder and its Claude Code worktrees", () => {
    const slugs = checkoutSlugs("/Users/me/repos/app", "/Volumes/data/repos/app");
    expect(slugs).toEqual(["-Users-me-repos-app", "-Volumes-data-repos-app"]);
    const folders = ["-Users-me-repos-app", "-Users-me-repos-app--claude-worktrees-fix", "-Users-me-repos-app2", "-Volumes-data-repos-app", "-Users-me-repos-application"];
    expect(checkoutFolders(folders, slugs)).toEqual(["-Users-me-repos-app", "-Users-me-repos-app--claude-worktrees-fix", "-Volumes-data-repos-app"]);
  });

  it("lists top-level sessions only, and reads a session's title without its contents", async () => {
    const projects = path.join(root, "projects");
    const folder = "-x-app";
    const lines = [
      JSON.stringify({ type: "user", message: { content: "a long prompt" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Fix the build" }),
      JSON.stringify({ type: "custom-title", sessionId: "s1", customTitle: "Build fix, by hand" }),
      '{"type":"ai-title","aiTitle":"cut sho',
    ];
    write(path.join(projects, folder, "s1.jsonl"), `${lines.join("\n")}\n`);
    write(path.join(projects, folder, "s2.jsonl"), `${JSON.stringify({ type: "ai-title", aiTitle: "Only AI" })}\n`);
    write(path.join(projects, folder, "s1", "subagents", "agent.jsonl"), "{}\n");
    const sessions = listSessions(projects, folder);
    expect(sessions.map((session) => session.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(sessions[0].size).toBe(statSync(sessions[0].path).size);
    expect(await sessionTitle(path.join(projects, folder, "s1.jsonl"))).toBe("Build fix, by hand");
    expect(await sessionTitle(path.join(projects, folder, "s2.jsonl"))).toBe("Only AI");
    expect(listSessions(projects, "missing")).toEqual([]);
  });
});
