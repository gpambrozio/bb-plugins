import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLock, CLAIM_STALE_MS, lastConsolidatedAt, lockPath, lockState, markConsolidated, rollbackLock, takeClaim, LOCK_STALE_MS } from "./lock";
import { applyProposal, createProposal, describeProposal, discardProposal, finishProposal, pendingProposal, planApply, ProposalConflictError } from "./proposals";
import { decide } from "../guard/guard.mjs";
import { backup, containedPath, diffManifests, listBackups, manifest, markdownFiles, newestChange, pruneBackups, restoreBackup, stampOf, stampTime, UnsafePathError } from "./snapshot";
import { checkoutFolders, checkoutSlugs, listSessions, parseWorktreeFolder, sessionTitle, TITLE_WINDOW_BYTES } from "./transcripts";

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
  const quick = { settleMs: 0, sleep: async () => undefined };

  it("is free with no lock, and taking it writes the PID and answers 0", async () => {
    expect(lockState(memory, alive)).toEqual({ lastConsolidatedAt: 0, held: false, pid: null });
    expect(await acquireLock(memory, 4242, { isAlive: alive, ...quick })).toBe(0);
    expect(readFileSync(lockPath(memory), "utf8")).toBe("4242");
    expect(lockState(memory, alive)).toMatchObject({ held: true, pid: 4242 });
    expect(existsSync(`${lockPath(memory)}.claim`)).toBe(false);
  });

  it("refuses while a live holder has it under an hour old", async () => {
    expect(await acquireLock(memory, 1, { isAlive: alive, ...quick })).toBe(0);
    expect(await acquireLock(memory, 2, { isAlive: alive, ...quick })).toBeNull();
  });

  it("is stale after an hour, or when its holder died, and can be taken", async () => {
    await acquireLock(memory, 1, { isAlive: alive, ...quick });
    const old = Date.now() - LOCK_STALE_MS - 1000;
    setMtime(lockPath(memory), old);
    expect(lockState(memory, alive).held).toBe(false);
    expect(await acquireLock(memory, 2, { isAlive: alive, ...quick })).toBeCloseTo(old, -2);
    expect(await acquireLock(memory, 3, { isAlive: dead, ...quick })).not.toBeNull();
  });

  it("lets only one of two processes that both saw a stale lock take it", async () => {
    // Process A holds the claim while it checks and writes; process B, arriving then, is refused.
    const releaseA = takeClaim(memory);
    expect(releaseA).not.toBeNull();
    expect(await acquireLock(memory, 2, { isAlive: alive, ...quick })).toBeNull();
    releaseA?.();
    expect(await acquireLock(memory, 1, { isAlive: alive, ...quick })).toBe(0);
  });

  it("gives up when another writer replaced its PID while it settled, as a racing native dream does", async () => {
    const result = await acquireLock(memory, 1, {
      isAlive: alive,
      settleMs: 5,
      sleep: async () => writeFileSync(lockPath(memory), "999"),
    });
    expect(result).toBeNull();
    expect(readFileSync(lockPath(memory), "utf8")).toBe("999");
  });

  it("breaks a claim left by a crashed holder", async () => {
    writeFileSync(`${lockPath(memory)}.claim`, "");
    setMtime(`${lockPath(memory)}.claim`, Date.now() - CLAIM_STALE_MS - 1000);
    expect(await acquireLock(memory, 1, { isAlive: alive, ...quick })).toBe(0);
  });

  it("rolls the mtime back on failure, and removes a lock that did not exist", async () => {
    const prior = Date.UTC(2026, 10, 10, 3, 0, 0);
    await acquireLock(memory, 7, { isAlive: alive, ...quick });
    expect(markConsolidated(memory, prior, 7)).toBe(true);
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);
    const before = await acquireLock(memory, 7, { isAlive: dead, ...quick });
    expect(before).toBeCloseTo(prior, -1);
    expect(lastConsolidatedAt(memory)).toBeGreaterThan(prior);
    expect(rollbackLock(memory, before as number, 7)).toBe(true);
    expect(lastConsolidatedAt(memory)).toBeCloseTo(prior, -1);
    expect(readFileSync(lockPath(memory), "utf8")).toBe("");

    rmSync(lockPath(memory));
    expect(await acquireLock(memory, 7, { isAlive: alive, ...quick })).toBe(0);
    rollbackLock(memory, 0, 7);
    expect(existsSync(lockPath(memory))).toBe(false);
  });

  it("never rolls back or marks a lock another process has taken since", async () => {
    await acquireLock(memory, 7, { isAlive: alive, ...quick });
    writeFileSync(lockPath(memory), "8");
    const mtime = lastConsolidatedAt(memory);
    expect(rollbackLock(memory, 0, 7)).toBe(false);
    expect(markConsolidated(memory, 1, 7)).toBe(false);
    expect(readFileSync(lockPath(memory), "utf8")).toBe("8");
    expect(lastConsolidatedAt(memory)).toBe(mtime);
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
    await acquireLock(memory, 1, { isAlive: () => true, settleMs: 0 });
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

describe("the proposal view", () => {
  it("lists each file the dream would add, change or delete, with both texts, and writes nothing", () => {
    const proposals = path.join(root, "proposals");
    write(path.join(memory, "stale.md"), "old note\n");
    const proposal = createProposal(memory, proposals, "20261117T010500000Z");
    write(path.join(proposal.memoryDir, "build.md"), "builds with ninja\n");
    write(path.join(proposal.memoryDir, "MEMORY.md"), "- [Build](build.md) — ninja\n");
    write(path.join(proposal.memoryDir, "ci.md"), "ci nightly\n");
    rmSync(path.join(proposal.memoryDir, "stale.md"));
    const ready = finishProposal(proposal, true, "Consolidated.");
    const before = manifest(memory);

    const view = describeProposal(ready, memory);
    expect(view).toMatchObject({ stamp: "20261117T010500000Z", summary: "Consolidated.", changes: { added: ["ci.md"], changed: ["MEMORY.md", "build.md"], deleted: ["stale.md"] } });
    expect(view.files).toEqual([
      { path: "MEMORY.md", kind: "changed", current: "- [Build](build.md) — make\n", proposed: "- [Build](build.md) — ninja\n", baseChanged: false, truncated: false },
      { path: "build.md", kind: "changed", current: "builds with make\n", proposed: "builds with ninja\n", baseChanged: false, truncated: false },
      { path: "ci.md", kind: "added", current: null, proposed: "ci nightly\n", baseChanged: false, truncated: false },
      { path: "stale.md", kind: "deleted", current: "old note\n", proposed: null, baseChanged: false, truncated: false },
    ]);
    expect(manifest(memory)).toEqual(before);
    expect(pendingProposal(proposals)?.stamp).toBe("20261117T010500000Z");
  });

  it("says which files changed in the memory since the dry run, and reads nothing through a link", () => {
    const proposal = createProposal(memory, path.join(root, "proposals"), "20261117T010500000Z");
    write(path.join(proposal.memoryDir, "build.md"), "builds with ninja\n");
    write(path.join(proposal.memoryDir, "MEMORY.md"), "- index\n");
    const ready = finishProposal(proposal, true, null);
    write(path.join(memory, "build.md"), "a session edited this\n");
    write(path.join(root, "outside.md"), "secret\n");
    rmSync(path.join(memory, "MEMORY.md"));
    symlinkSync(path.join(root, "outside.md"), path.join(memory, "MEMORY.md"));
    const view = describeProposal(ready, memory);
    expect(view.files.find((file) => file.path === "build.md")).toMatchObject({ baseChanged: true, current: "a session edited this\n" });
    expect(view.files.find((file) => file.path === "MEMORY.md")).toMatchObject({ baseChanged: true, current: null });
  });
});

describe("symlinks and protected folders", () => {
  const proposals = () => path.join(root, "proposals");

  it("never lets a dry run write the real memory through a dangling link", () => {
    symlinkSync(path.join(memory, "not-created.md"), path.join(memory, "dangling.md"));
    const proposal = createProposal(memory, proposals(), "20261117T010500000Z");
    // The copy holds regular files only: the link is not copied, so nothing in it leads back.
    expect(existsSync(path.join(proposal.memoryDir, "dangling.md"))).toBe(false);
    expect(() => lstatSync(path.join(proposal.memoryDir, "dangling.md"))).toThrow();
    // And the guard refuses a dangling link wherever it is, instead of following it.
    const copyLink = path.join(proposal.memoryDir, "link.md");
    symlinkSync(path.join(memory, "also-not-created.md"), copyLink);
    expect(decide({ tool_name: "Write", tool_input: { file_path: copyLink }, cwd: "/" }, { memoryDir: realpathSync(proposal.memoryDir) }).decision).toBe("deny");
    expect(existsSync(path.join(memory, "not-created.md"))).toBe(false);
    expect(existsSync(path.join(memory, "also-not-created.md"))).toBe(false);
  });

  it("refuses to apply through a folder that became a link out of the memory", () => {
    const proposal = createProposal(memory, proposals(), "20261117T010500000Z");
    write(path.join(proposal.memoryDir, "topic", "new.md"), "new\n");
    const ready = finishProposal(proposal, true, null);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(memory, "topic"));
    const plan = planApply(ready, memory);
    expect(() => applyProposal(ready, memory, plan)).toThrow(UnsafePathError);
    expect(existsSync(path.join(outside, "new.md"))).toBe(false);
  });

  it("refuses to restore through a link out of the memory", async () => {
    const backups = path.join(root, "backups");
    write(path.join(memory, "topic", "kept.md"), "kept\n");
    const archive = await backup(memory, backups, stampOf(Date.now()));
    rmSync(path.join(memory, "topic"), { recursive: true });
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    write(path.join(outside, "kept.md"), "someone else's file\n");
    symlinkSync(outside, path.join(memory, "topic"));
    await expect(restoreBackup(archive, memory)).rejects.toThrow(UnsafePathError);
    expect(readFileSync(path.join(outside, "kept.md"), "utf8")).toBe("someone else's file\n");
  });

  it("treats protected folders without regard to case, in the guard and in the file walk alike", () => {
    write(path.join(memory, "agents", "a.md"), "protected\n");
    write(path.join(memory, "Topic", "AGENTS", "b.md"), "protected too\n");
    for (const spelling of ["AGENTS", "Agents", "agents"]) {
      expect(decide({ tool_name: "Write", tool_input: { file_path: path.join(memory, spelling, "a.md") }, cwd: "/" }, { memoryDir: memory }).decision).toBe("deny");
    }
    expect(markdownFiles(memory)).toEqual(["MEMORY.md", "build.md"]);
    expect(() => containedPath(memory, "AGENTS/a.md")).toThrow(UnsafePathError);
    expect(() => containedPath(memory, ".GIT/x.md")).toThrow(UnsafePathError);
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

  it("finds a title at either end of a large transcript without reading the middle", async () => {
    const file = path.join(root, "big.jsonl");
    const filler = `${JSON.stringify({ type: "assistant", text: "x".repeat(1000) })}\n`;
    const middle = filler.repeat(Math.ceil((3 * TITLE_WINDOW_BYTES) / filler.length));
    const early = `${JSON.stringify({ type: "ai-title", aiTitle: "Early title" })}\n`;
    const hidden = `${JSON.stringify({ type: "custom-title", customTitle: "In the middle" })}\n`;
    const late = `${JSON.stringify({ type: "ai-title", aiTitle: "Late title" })}\n`;
    write(file, early + middle + hidden + middle + late);
    expect(await sessionTitle(file)).toBe("Late title");
  });
});
