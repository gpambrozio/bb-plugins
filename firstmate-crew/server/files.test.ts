import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileChangedError, cleanRelative, readTextFile, replaceTextIfUnchanged } from "./files";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-files-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "data", "fix-login"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "# First mate\n");
  await writeFile(join(dir, "data", "backlog.md"), "## In flight\n");
  await writeFile(join(dir, "data", "fix-login", "brief.md"), "brief");
  return dir;
}

describe("cleanRelative", () => {
  it("normalizes paths inside the home and refuses the rest", () => {
    expect(cleanRelative("")).toBe("");
    expect(cleanRelative("./data//backlog.md")).toBe("data/backlog.md");
    expect(cleanRelative("data/fix-login/../backlog.md")).toBe("data/backlog.md");
    expect(() => cleanRelative("../outside")).toThrow(/outside the home/);
    expect(() => cleanRelative("data/../../x")).toThrow(/outside the home/);
    expect(() => cleanRelative("/etc/passwd")).toThrow(/not a path inside/);
  });
});

describe("readTextFile", () => {
  it("reads text and flags a binary file instead of sending it", async () => {
    const dir = await home();
    expect(await readTextFile(dir, "data/backlog.md")).toMatchObject({ content: "## In flight\n", binary: false });
    await writeFile(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(await readTextFile(dir, "image.png")).toMatchObject({ content: null, binary: true });
  });

  it("refuses a symlink that leads outside the home", async () => {
    const dir = await home();
    const outside = await mkdtemp(join(tmpdir(), "firstmate-outside-"));
    tempDirs.push(outside);
    await writeFile(join(outside, "secret.txt"), "no");
    await symlink(outside, join(dir, "escape"));
    await expect(readTextFile(dir, "escape/secret.txt")).rejects.toThrow(/outside the home/);
  });
});

describe("replaceTextIfUnchanged", () => {
  it("replaces a file that still reads as expected", async () => {
    const dir = await home();
    await replaceTextIfUnchanged(dir, "data/backlog.md", "## In flight\n", "mine");
    expect(await readFile(join(dir, "data", "backlog.md"), "utf8")).toBe("mine");
  });

  it("refuses other contents even with the same modification time", async () => {
    const dir = await home();
    const path = join(dir, "data", "backlog.md");
    const { mtime } = await stat(path);
    await writeFile(path, "theirs\n");
    await utimes(path, mtime, mtime);
    await expect(replaceTextIfUnchanged(dir, "data/backlog.md", "## In flight\n", "mine")).rejects.toBeInstanceOf(
      FileChangedError,
    );
    expect(await readFile(path, "utf8")).toBe("theirs\n");
  });

  it("refuses when the file is rewritten or deleted while the replacement is staged", async () => {
    const dir = await home();
    const path = join(dir, "data", "backlog.md");
    await expect(
      replaceTextIfUnchanged(dir, "data/backlog.md", "## In flight\n", "mine", {
        afterStaging: () => writeFile(path, "theirs\n"),
      }),
    ).rejects.toBeInstanceOf(FileChangedError);
    expect(await readFile(path, "utf8")).toBe("theirs\n");

    await expect(
      replaceTextIfUnchanged(dir, "data/backlog.md", "theirs\n", "mine", { afterStaging: () => rm(path) }),
    ).rejects.toBeInstanceOf(FileChangedError);
    expect((await readdir(join(dir, "data"))).sort()).toEqual(["fix-login"]);
  });

  it("keeps the replaced file's mode", async () => {
    const dir = await home();
    const path = join(dir, "data", "backlog.md");
    await chmod(path, 0o640);
    await replaceTextIfUnchanged(dir, "data/backlog.md", "## In flight\n", "mine");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it("lets only one of two replacements of the same version through", async () => {
    const dir = await home();
    const contents = ["first", "second"];
    const results = await Promise.allSettled(
      contents.map((content) => replaceTextIfUnchanged(dir, "data/backlog.md", "## In flight\n", content)),
    );
    const winners = contents.filter((_, index) => results[index]?.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(await readFile(join(dir, "data", "backlog.md"), "utf8")).toBe(winners[0]);
    expect((await readdir(join(dir, "data"))).sort()).toEqual(["backlog.md", "fix-login"]);
  });

  it("refuses a path outside the home", async () => {
    const dir = await home();
    await expect(replaceTextIfUnchanged(dir, "../escape.md", "", "x")).rejects.toThrow(/outside the home/);
  });
});
