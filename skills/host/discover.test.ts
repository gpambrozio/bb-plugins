import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import { defaultSkillRoots, discoverSkills, readDiscoveredSkill, type SkillRoots } from "./discover";

let root: string;
let roots: SkillRoots;

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    "utf8",
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bb-skills-discover-"));
  roots = {
    claudeHome: path.join(root, "claude-home"),
    codexHome: path.join(root, "codex-home"),
    agentsHome: path.join(root, "agents-home"),
    adminSkillsDir: path.join(root, "etc", "codex", "skills"),
    hermesHome: path.join(root, "hermes-home"),
  };
});

describe("discoverSkills", () => {
  test("scans Claude's directories for a claude-code thread", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");

    const result = await discoverSkills({ provider: "claude-code", cwd }, roots);

    expect(result.scanned).toBe(true);
    expect(result.skills.map((skill) => skill.name)).toEqual(["tidy-imports"]);
  });

  test("scans Codex's directories for a codex thread", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".agents", "skills"), "deploy", "Deploys the app");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");

    const result = await discoverSkills({ provider: "codex", cwd }, roots);

    expect(result.skills.map((skill) => skill.name)).toEqual(["deploy"]);
  });

  test("scans the Hermes home for an acp-hermes-agent thread, flat and in categories", async () => {
    const skillsDir = path.join(roots.hermesHome, "skills");
    await writeSkill(skillsDir, "field-guide", "A field guide");
    await writeSkill(path.join(skillsDir, "productivity"), "spreadsheets", "Spreadsheet files");

    const result = await discoverSkills({ provider: "acp-hermes-agent", cwd: root }, roots);

    expect(result.scanned).toBe(true);
    expect(result.skills.map((skill) => skill.name)).toEqual(["field-guide", "spreadsheets"]);
  });

  test("reports a provider with no documented directories as unscanned, not empty", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");

    const result = await discoverSkills({ provider: "pi", cwd }, roots);

    expect(result).toEqual({ scanned: false, skills: [] });
  });
});

describe("readDiscoveredSkill", () => {
  test("returns the body of a skill discovery found", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
    const { skills } = await discoverSkills({ provider: "claude-code", cwd }, roots);

    const result = await readDiscoveredSkill({ provider: "claude-code", cwd, skillId: skills[0]!.id }, roots);

    expect(result).toEqual({
      name: "tidy-imports",
      description: "Sorts imports",
      path: path.join(cwd, ".claude", "skills", "tidy-imports", "SKILL.md"),
      body: "Body for tidy-imports.\n",
    });
  });

  test("reads a Hermes skill inside a category", async () => {
    await writeSkill(path.join(roots.hermesHome, "skills", "research"), "papers", "Finds papers");
    const { skills } = await discoverSkills({ provider: "acp-hermes-agent", cwd: root }, roots);

    const result = await readDiscoveredSkill(
      { provider: "acp-hermes-agent", cwd: root, skillId: skills[0]!.id },
      roots,
    );

    expect(result.body).toBe("Body for papers.\n");
  });

  // The security boundary: an id is looked up in a fresh scan, so a crafted one
  // names nothing, even when it spells out a file that exists.
  describe("only reads what discovery produced", () => {
    test("refuses an id shaped like a path to a file outside every skill directory", async () => {
      const cwd = path.join(root, "work");
      await mkdir(cwd, { recursive: true });
      const secret = path.join(root, "secret");
      await writeSkill(secret, "notes", "Not a skill anyone installed");

      for (const skillId of [
        `project:${secret}:notes`,
        path.join(secret, "notes", "SKILL.md"),
        "project:/etc:passwd",
      ]) {
        await expect(readDiscoveredSkill({ provider: "claude-code", cwd, skillId }, roots)).rejects.toThrow(
          /not available/,
        );
      }
    });

    test("refuses another provider's skill in the same checkout", async () => {
      const cwd = path.join(root, "work");
      await writeSkill(path.join(cwd, ".agents", "skills"), "deploy", "Deploys the app");
      const { skills } = await discoverSkills({ provider: "codex", cwd }, roots);

      await expect(
        readDiscoveredSkill({ provider: "claude-code", cwd, skillId: skills[0]!.id }, roots),
      ).rejects.toThrow(/not available/);
    });

    test("refuses an id a provider with no scan could not have produced", async () => {
      const cwd = path.join(root, "work");
      await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
      const { skills } = await discoverSkills({ provider: "claude-code", cwd }, roots);

      await expect(readDiscoveredSkill({ provider: "pi", cwd, skillId: skills[0]!.id }, roots)).rejects.toThrow(
        /not available/,
      );
    });

    test("refuses a skill deleted since it was listed", async () => {
      const cwd = path.join(root, "work");
      await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
      const { skills } = await discoverSkills({ provider: "claude-code", cwd }, roots);
      await writeFile(path.join(cwd, ".claude", "skills", "tidy-imports", "SKILL.md"), "no frontmatter", "utf8");

      await expect(
        readDiscoveredSkill({ provider: "claude-code", cwd, skillId: skills[0]!.id }, roots),
      ).rejects.toThrow(/not available/);
    });
  });
});

describe("defaultSkillRoots", () => {
  test("honors CODEX_HOME", () => {
    expect(defaultSkillRoots({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv).codexHome).toBe("/custom/codex");
  });

  test("honors HERMES_HOME", () => {
    expect(defaultSkillRoots({ HERMES_HOME: "/custom/hermes" } as NodeJS.ProcessEnv).hermesHome).toBe(
      "/custom/hermes",
    );
  });

  test("falls back to the home directory's own folders", () => {
    const fallback = defaultSkillRoots({} as NodeJS.ProcessEnv);
    expect(fallback.codexHome).toBe(path.join(os.homedir(), ".codex"));
    expect(fallback.claudeHome).toBe(path.join(os.homedir(), ".claude"));
    expect(fallback.agentsHome).toBe(path.join(os.homedir(), ".agents"));
    expect(fallback.hermesHome).toBe(path.join(os.homedir(), ".hermes"));
    expect(fallback.adminSkillsDir).toBe(path.join(path.sep, "etc", "codex", "skills"));
  });
});
