import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { createRunGit, type RunGit } from "./git";
import { currentRevision, revert } from "./revert";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).trim();
}

/** A repository with `a.txt` and `b.txt` committed, and `link` pointing at `a.txt`. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "diff-review-revert-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  writeFileSync(join(root, "b.txt"), "bee\n");
  symlinkSync("a.txt", join(root, "link"));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  return root;
}

const run = createRunGit();

describe("reverting on the host", () => {
  it("computes the revision bb's Git plugin lists: modes and blobs, the working copy hashed as git does", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    expect(await currentRevision(run, root, "a.txt")).toBe(`100644:${git(root, "rev-parse", "HEAD:a.txt")}:100644:${git(root, "hash-object", "a.txt")}`);
    writeFileSync(join(root, "new.txt"), "fresh\n");
    expect(await currentRevision(run, root, "new.txt")).toBe(`000000:${"0".repeat(40)}:100644:${git(root, "hash-object", "new.txt")}`);
  });

  it("puts a whole file back, removes a new one and restores a deleted one, at the reviewed revision", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "changed\n");
    await revert(run, { root, path: "a.txt", revision: await currentRevision(run, root, "a.txt"), hunks: null, patch: null });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
    writeFileSync(join(root, "new.txt"), "fresh\n");
    await revert(run, { root, path: "new.txt", revision: await currentRevision(run, root, "new.txt"), hunks: null, patch: null });
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    unlinkSync(join(root, "b.txt"));
    await revert(run, { root, path: "b.txt", revision: await currentRevision(run, root, "b.txt"), hunks: null, patch: null });
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("bee\n");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("refuses a symlink whose target changed, and writes neither file", async () => {
    const root = repo();
    unlinkSync(join(root, "link"));
    symlinkSync("b.txt", join(root, "link"));
    const revision = await currentRevision(run, root, "link");
    expect(revision).toContain(":120000:");
    await expect(revert(run, { root, path: "link", revision, hunks: null, patch: null })).rejects.toThrow("symlink");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("bee\n");
    expect(readlinkSync(join(root, "link"))).toBe("b.txt");
  });

  it("refuses when the file changed after the tab's revision, and keeps the new edit", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    writeFileSync(join(root, "a.txt"), "NEW UNREVIEWED EDIT\n");
    await expect(revert(run, { root, path: "a.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("NEW UNREVIEWED EDIT\n");
  });

  it("refuses when the file is saved while the committed version is being read, and keeps that save", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    // An editor saves during the `git cat-file` the revert awaits.
    const racing: RunGit = async (where, args, options) => {
      if (args[0] === "cat-file") writeFileSync(join(root, "a.txt"), "NEW UNREVIEWED EDIT\n");
      return run(where, args, options);
    };
    await expect(revert(racing, { root, path: "a.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("NEW UNREVIEWED EDIT\n");
  });

  it("does not delete a new file that was edited after the review", async () => {
    const root = repo();
    writeFileSync(join(root, "new.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "new.txt");
    writeFileSync(join(root, "new.txt"), "more work\n");
    await expect(revert(run, { root, path: "new.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("more work\n");
  });

  it("reverts picked hunks of the reviewed version only", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    const patch = git(root, "diff", "HEAD", "--", "a.txt") + "\n";
    await revert(run, { root, path: "a.txt", revision: await currentRevision(run, root, "a.txt"), hunks: [0], patch });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("refuses a staged file saved again after git's diff read it, keeping that save", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    git(root, "add", "a.txt");
    const revision = await currentRevision(run, root, "a.txt");
    // git reports the staged blob; an editor saves right after that read.
    const racing: RunGit = async (where, args, options) => {
      const result = await run(where, args, options);
      if (args[0] === "diff" && args.includes("--raw")) writeFileSync(join(root, "a.txt"), "NEW UNREVIEWED EDIT\n");
      return result;
    };
    await expect(revert(racing, { root, path: "a.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("NEW UNREVIEWED EDIT\n");
  });

  it("hashes the working file as bb does, its attributes applied, so a CRLF-normalized file reverts", async () => {
    const root = repo();
    writeFileSync(join(root, ".gitattributes"), "a.txt text eol=crlf\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-q", "-m", "attributes");
    writeFileSync(join(root, "a.txt"), "one\r\nTWO\r\n");
    const revision = await currentRevision(run, root, "a.txt");
    // bb's Git plugin runs `git hash-object -- a.txt`, which normalizes CRLF to LF.
    expect(revision).toBe(`100644:${git(root, "rev-parse", "HEAD:a.txt")}:100644:${git(root, "hash-object", "a.txt")}`);
    await revert(run, { root, path: "a.txt", revision, hunks: null, patch: null });
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe("");
  });

  it("never writes through a symlinked folder, leaving the folder it points at untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-review-revert-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "a.txt"), "inside\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    const outside = mkdtempSync(join(tmpdir(), "diff-review-outside-"));
    roots.push(outside);
    rmSync(join(root, "dir"), { recursive: true });
    symlinkSync(outside, join(root, "dir"));
    // git now reports dir/a.txt deleted.
    const revision = await currentRevision(run, root, "dir/a.txt");
    await expect(revert(run, { root, path: "dir/a.txt", revision, hunks: null, patch: null })).rejects.toThrow("symlinked folder");
    expect(readdirSync(outside)).toEqual([]);
  });

  /** A folder outside the checkout holding `a.txt` with the reviewed bytes, so only the folder checks stand in the way. */
  function outsideWith(content: string): string {
    const outside = mkdtempSync(join(tmpdir(), "diff-review-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "a.txt"), content);
    return outside;
  }

  it("writes nothing outside when the checkout itself is swapped for a link during the git read", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    const outside = outsideWith("reviewed\n");
    const real = realpathSync(root);
    const aside = `${real}-aside`;
    roots.push(aside);
    const swapping: RunGit = async (where, args, options) => {
      const result = await run(where, args, options);
      if (args[0] === "cat-file") {
        renameSync(real, aside);
        symlinkSync(outside, real);
      }
      return result;
    };
    const temporaries: string[] = [];
    await expect(
      revert(swapping, { root, path: "a.txt", revision, hunks: null, patch: null }, { temporaryName: (target) => (temporaries.push(target), join(dirname(target), ".probe.tmp")) }),
    ).rejects.toThrow("moved or was replaced");
    expect(readdirSync(outside)).toEqual(["a.txt"]);
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("reviewed\n");
    expect(temporaries).toEqual([]);
    expect(readFileSync(join(aside, "a.txt"), "utf8")).toBe("reviewed\n");
  });

  it("makes no temporary file, and writes nothing, through a folder swapped for a link during the git read", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-review-revert-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "a.txt"), "committed\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "dir", "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "dir/a.txt");
    const outside = outsideWith("reviewed\n");
    const swapping: RunGit = async (where, args, options) => {
      const result = await run(where, args, options);
      if (args[0] === "cat-file") {
        renameSync(join(root, "dir"), join(root, "dir-aside"));
        symlinkSync(outside, join(root, "dir"));
      }
      return result;
    };
    // Where a temporary file would have gone, as its folder resolves: never outside the checkout.
    const temporaries: string[] = [];
    await expect(
      revert(swapping, { root, path: "dir/a.txt", revision, hunks: null, patch: null }, { temporaryName: (target) => (temporaries.push(realpathSync(dirname(target))), join(dirname(target), ".probe.tmp")) }),
    ).rejects.toThrow("symlinked folder");
    expect(temporaries).toEqual([]);
    expect(readdirSync(outside)).toEqual(["a.txt"]);
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("reviewed\n");
  });

  it("puts back a deleted file whose folder was deleted too", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-review-revert-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "dir", "deeper"), { recursive: true });
    writeFileSync(join(root, "dir", "deeper", "a.txt"), "committed\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    rmSync(join(root, "dir"), { recursive: true });
    const revision = await currentRevision(run, root, "dir/deeper/a.txt");
    await revert(run, { root, path: "dir/deeper/a.txt", revision, hunks: null, patch: null });
    expect(readFileSync(join(root, "dir", "deeper", "a.txt"), "utf8")).toBe("committed\n");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("does not write through a file or link already at the temporary file's name", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    const victim = join(mkdtempSync(join(tmpdir(), "diff-review-victim-")), "victim.txt");
    roots.push(dirname(victim));
    writeFileSync(victim, "precious\n");
    const planted = join(root, ".planted.tmp");
    symlinkSync(victim, planted);
    await expect(revert(run, { root, path: "a.txt", revision, hunks: null, patch: null }, { temporaryName: () => planted })).rejects.toThrow("temporary file");
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("reviewed\n");
    expect(readlinkSync(planted)).toBe(victim);
  });

  /**
   * Runs Revert in a child process whose files may not grow past `limitBytes` (`ulimit -f`), so the
   * kernel itself takes a short write and then refuses the rest.
   */
  async function revertUnderLimit(root: string, path: string, revision: string, limitBytes: number): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "diff-review-limit-"));
    roots.push(dir);
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { createRunGit } from ${JSON.stringify(join(__dirname, "git.ts"))};
import { revert } from ${JSON.stringify(join(__dirname, "revert.ts"))};
const [root, path, revision] = process.argv.slice(2);
revert(createRunGit(), { root, path, revision, hunks: null, patch: null }).then(() => console.log("reverted"), (error) => console.log("refused: " + error.message));
`,
    );
    const bundle = join(dir, "entry.mjs");
    buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
    const blocks = Math.floor(limitBytes / 512);
    return execFileSync("sh", ["-c", `ulimit -f ${blocks} && exec "$0" "$@"`, process.execPath, bundle, root, path, revision], { encoding: "utf8" }).trim();
  }

  const big = (fill: string) => `${fill.repeat(63)}\n`.repeat(256);

  it("leaves the reviewed file as it is when the disk takes only part of its new content", async () => {
    const root = repo();
    writeFileSync(join(root, "big.txt"), big("c"));
    git(root, "add", "big.txt");
    git(root, "commit", "-q", "-m", "big");
    writeFileSync(join(root, "big.txt"), big("w"));
    const revision = await currentRevision(run, root, "big.txt");
    const answer = await revertUnderLimit(root, "big.txt", revision, 4096);
    expect(answer).toMatch(/^refused: Could not write big\.txt/);
    expect(readFileSync(join(root, "big.txt"), "utf8")).toBe(big("w"));
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves a deleted file deleted, with no partial file, when the disk takes only part of it", async () => {
    const root = repo();
    writeFileSync(join(root, "big.txt"), big("c"));
    git(root, "add", "big.txt");
    git(root, "commit", "-q", "-m", "big");
    unlinkSync(join(root, "big.txt"));
    const revision = await currentRevision(run, root, "big.txt");
    expect(await revertUnderLimit(root, "big.txt", revision, 4096)).toMatch(/^refused: Could not write big\.txt/);
    expect(existsSync(join(root, "big.txt"))).toBe(false);
  });

  it("writes on after a short write, and refuses, keeping the file, when a later write fails", async () => {
    const root = repo();
    writeFileSync(join(root, "big.txt"), big("c"));
    git(root, "add", "big.txt");
    git(root, "commit", "-q", "-m", "big");
    writeFileSync(join(root, "big.txt"), big("w"));
    // Each write takes at most 1000 bytes.
    const short = (fd: number, bytes: Buffer, offset: number, length: number) => writeSync(fd, bytes, offset, Math.min(length, 1000));
    await revert(run, { root, path: "big.txt", revision: await currentRevision(run, root, "big.txt"), hunks: null, patch: null }, { write: short });
    expect(readFileSync(join(root, "big.txt"), "utf8")).toBe(big("c"));

    writeFileSync(join(root, "big.txt"), big("w"));
    let calls = 0;
    const failing = (fd: number, bytes: Buffer, offset: number, length: number) => {
      if (++calls > 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return writeSync(fd, bytes, offset, Math.min(length, 1000));
    };
    await expect(revert(run, { root, path: "big.txt", revision: await currentRevision(run, root, "big.txt"), hunks: null, patch: null }, { write: failing })).rejects.toThrow("ENOSPC");
    expect(readFileSync(join(root, "big.txt"), "utf8")).toBe(big("w"));
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a path outside the workspace", async () => {
    const root = repo();
    await expect(revert(run, { root, path: "../x", revision: "r", hunks: null, patch: null })).rejects.toThrow("not a file of this workspace");
  });
});
