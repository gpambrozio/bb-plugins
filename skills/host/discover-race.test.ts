/**
 * The replacement race on `read`: discovery validates a `SKILL.md`, and a
 * workspace process swaps it for a symlink to an unrelated file before the
 * body is read. `read` must return the bytes discovery validated, so the swap
 * changes nothing. The swap is made deterministic by doing it the moment the
 * first read of that file finishes, through whichever fs call reads it.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

const swap = vi.hoisted(() => ({ target: "", run: null as null | (() => Promise<void>) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  async function afterFirstRead(file: unknown): Promise<void> {
    if (String(file) !== swap.target || swap.run === null) return;
    const run = swap.run;
    swap.run = null;
    await run();
  }
  return {
    ...fs,
    readFile: (async (file: Parameters<typeof fs.readFile>[0], options?: Parameters<typeof fs.readFile>[1]) => {
      const result = await fs.readFile(file, options);
      await afterFirstRead(file);
      return result;
    }) as typeof fs.readFile,
    open: (async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
      const handle = await (fs.open as (...args: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(
        file,
        ...rest,
      );
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await afterFirstRead(file);
      };
      return handle;
    }) as typeof fs.open,
  };
});

const { discoverSkills, readDiscoveredSkill } = await import("./discover");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bb-skills-race-"));
});

test("read serves the bytes discovery validated, not a file swapped in after", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const roots = {
    claudeHome: path.join(root, "claude-home"),
    codexHome: path.join(root, "codex-home"),
    agentsHome: path.join(root, "agents-home"),
    adminSkillsDir: path.join(root, "admin"),
    hermesHome: path.join(root, "hermes-home"),
  };
  const cwd = path.join(root, "work");
  const skillFile = path.join(cwd, ".claude", "skills", "tidy-imports", "SKILL.md");
  await mkdir(path.dirname(skillFile), { recursive: true });
  await writeFile(skillFile, "---\nname: tidy-imports\ndescription: Sorts imports\n---\n\nThe real body.\n", "utf8");
  const secret = path.join(root, "secret.txt");
  await writeFile(secret, "PRIVATE CONTENT\n", "utf8");

  const { skills } = await discoverSkills({ provider: "claude-code", cwd }, roots);
  const skillId = skills[0]!.id;

  // Armed for `read`'s own scan: the moment it has read the file, the
  // workspace replaces it with a symlink to the secret.
  swap.target = skillFile;
  swap.run = async () => {
    await fs.rm(skillFile);
    await fs.symlink(secret, skillFile);
  };

  const document = await readDiscoveredSkill({ provider: "claude-code", cwd, skillId }, roots);

  expect(swap.run).toBeNull(); // the swap happened
  expect(document.body).toBe("The real body.\n");
  expect(document.body).not.toContain("PRIVATE");
});
