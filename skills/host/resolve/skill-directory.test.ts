import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import { MAX_SKILL_BYTES, readBoundedText } from "./read-bounded";
import { mainCheckoutOf } from "./repo-root";
import { readSkillsFromDirectory } from "./skill-directory";

let root: string;

function skillMd(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: A skill called ${name}\n---\n\nBody for ${name}.\n${extra}`;
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), skillMd(name), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bb-skills-bounded-"));
});

// A workspace can plant any of these; discovery runs whenever a composer's
// count loads, so each must be skipped promptly, not read. Without the bounded
// reader the device never ends and the FIFO never opens — the test times out.
describe("discovery skips a SKILL.md it cannot safely read", () => {
  test("a symlink to an endless device", async () => {
    const dir = path.join(root, "skills");
    await writeSkill(dir, "kept");
    await mkdir(path.join(dir, "endless"), { recursive: true });
    await symlink("/dev/zero", path.join(dir, "endless", "SKILL.md"));

    const skills = await readSkillsFromDirectory(dir, "project", "Project");

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  }, 5_000);

  test.skipIf(process.platform === "win32")("a FIFO no one writes to", async () => {
    const dir = path.join(root, "skills");
    await writeSkill(dir, "kept");
    await mkdir(path.join(dir, "blocked"), { recursive: true });
    execFileSync("mkfifo", [path.join(dir, "blocked", "SKILL.md")]);

    const skills = await readSkillsFromDirectory(dir, "project", "Project");

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  }, 5_000);

  test("a directory named SKILL.md", async () => {
    const dir = path.join(root, "skills");
    await mkdir(path.join(dir, "odd", "SKILL.md"), { recursive: true });

    expect(await readSkillsFromDirectory(dir, "project", "Project")).toEqual([]);
  });

  test("a file larger than the cap, however valid its frontmatter", async () => {
    const dir = path.join(root, "skills");
    await mkdir(path.join(dir, "huge"), { recursive: true });
    await writeFile(path.join(dir, "huge", "SKILL.md"), skillMd("huge", "x".repeat(MAX_SKILL_BYTES)), "utf8");

    expect(await readSkillsFromDirectory(dir, "project", "Project")).toEqual([]);
  });

  test("still follows a symlinked skill folder and a symlinked SKILL.md", async () => {
    const store = path.join(root, "store");
    await writeSkill(store, "linked-folder");
    await writeSkill(store, "linked-file");
    const dir = path.join(root, "skills");
    await mkdir(path.join(dir, "linked-file"), { recursive: true });
    await symlink(path.join(store, "linked-folder"), path.join(dir, "linked-folder"));
    await symlink(path.join(store, "linked-file", "SKILL.md"), path.join(dir, "linked-file", "SKILL.md"));

    const skills = await readSkillsFromDirectory(dir, "project", "Project");

    expect(skills.map((skill) => [skill.name, skill.body])).toEqual([
      ["linked-file", "Body for linked-file.\n"],
      ["linked-folder", "Body for linked-folder.\n"],
    ]);
  });
});

describe("readBoundedText", () => {
  test("reads a file at the cap and refuses one byte over it", async () => {
    const file = path.join(root, "file.txt");
    await writeFile(file, "a".repeat(100), "utf8");

    expect(await readBoundedText(file, 100)).toBe("a".repeat(100));
    expect(await readBoundedText(file, 99)).toBeNull();
  });

  test("answers null for a missing file", async () => {
    expect(await readBoundedText(path.join(root, "missing"), 100)).toBeNull();
  });
});

describe("mainCheckoutOf with a planted .git", () => {
  test.skipIf(process.platform === "win32")("does not block on a .git that is a FIFO", async () => {
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("mkfifo", [path.join(repo, ".git")]);

    expect(await mainCheckoutOf(repo)).toBeNull();
  }, 5_000);

  test("does not read a .git linked to an endless device", async () => {
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    await symlink("/dev/zero", path.join(repo, ".git"));

    expect(await mainCheckoutOf(repo)).toBeNull();
  }, 5_000);
});
