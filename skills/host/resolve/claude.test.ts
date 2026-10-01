import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import { resolveClaudeSkills } from "./claude";

let root: string;
let claudeHome: string;

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    "utf8",
  );
}

async function writeManifest(plugins: unknown): Promise<void> {
  const pluginsDir = path.join(claudeHome, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }, null, 2),
    "utf8",
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bb-skills-claude-"));
  claudeHome = path.join(root, "claude-home");
});

describe("resolveClaudeSkills", () => {
  test("finds project and personal skills and labels their source", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Summarizes changes");
    await writeSkill(path.join(claudeHome, "skills"), "field-guide", "A field guide");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name).sort()).toEqual(["field-guide", "tidy-imports"]);
    const tidy = skills.find((skill) => skill.name === "tidy-imports");
    const guide = skills.find((skill) => skill.name === "field-guide");
    expect(tidy?.source.kind).toBe("project");
    expect(tidy?.source.label).toBe("Project");
    expect(guide?.source.kind).toBe("personal");
    expect(guide?.source.label).toBe("Personal");
  });

  test("reads every directory from the working directory up to the repository root", async () => {
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "app");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeSkill(path.join(repo, ".claude", "skills"), "release", "Cuts a release");
    await writeSkill(path.join(repo, "packages", ".claude", "skills"), "bump", "Bumps versions");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["bump", "release"]);
    expect(skills.every((skill) => skill.source.kind === "repo")).toBe(true);
    expect(skills.every((skill) => skill.source.label === "Repository")).toBe(true);
  });

  test("the working directory wins a name collision with the repository root", async () => {
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "app");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await writeSkill(path.join(cwd, ".claude", "skills"), "release", "Package version");
    await writeSkill(path.join(repo, ".claude", "skills"), "release", "Root version");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("Package version");
    expect(skills[0]?.source.kind).toBe("project");
  });

  test("does not climb above the working directory outside a repository", async () => {
    const cwd = path.join(root, "loose", "work");
    await mkdir(cwd, { recursive: true });
    await writeSkill(path.join(root, "loose", ".claude", "skills"), "stray", "Not in a repo");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toEqual([]);
  });

  test("reads a repository rooted at the claude home only once", async () => {
    // A dotfiles repo at $HOME puts ~/.claude/skills in both the repo walk and
    // the personal scope. The nearer scope wins; the skill is not listed twice.
    const home = path.join(root, "home");
    const cwd = path.join(home, "notes");
    await mkdir(path.join(home, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeSkill(path.join(home, ".claude", "skills"), "field-guide", "A field guide");

    const skills = await resolveClaudeSkills({ cwd, claudeHome: path.join(home, ".claude") });

    expect(skills.map((skill) => skill.name)).toEqual(["field-guide"]);
    expect(skills[0]?.source.kind).toBe("repo");
  });

  test("a project skill wins a name collision with a personal skill", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "diff-check", "Project version");
    await writeSkill(path.join(claudeHome, "skills"), "diff-check", "Personal version");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("Project version");
    expect(skills[0]?.source.kind).toBe("project");
  });

  test("names plugin skills plugin:skill and labels them with the plugin name", async () => {
    const cwd = path.join(root, "work");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "official", "toolkit", "6.3.0");
    await writeSkill(path.join(installPath, "skills"), "outline", "Turns ideas into designs");
    await writeManifest({
      "toolkit@official": [{ scope: "local", installPath, version: "6.3.0" }],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("toolkit:outline");
    expect(skills[0]?.source.kind).toBe("plugin");
    expect(skills[0]?.source.label).toBe("toolkit");
  });

  test("ignores cached plugin versions the manifest does not list", async () => {
    const cwd = path.join(root, "work");
    await mkdir(cwd, { recursive: true });
    const cache = path.join(claudeHome, "plugins", "cache", "official", "toolkit");
    const live = path.join(cache, "6.3.0");
    const stale = path.join(cache, "6.1.1");
    await writeSkill(path.join(live, "skills"), "outline", "Current");
    await writeSkill(path.join(stale, "skills"), "outline", "Outdated");
    await writeManifest({
      "toolkit@official": [{ scope: "local", installPath: live, version: "6.3.0" }],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("Current");
  });

  test("excludes a project-scoped plugin when the agent works elsewhere", async () => {
    const cwd = path.join(root, "other-project");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "market", "plugin-b", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "expert", "SwiftUI help");
    await writeManifest({
      "plugin-b@market": [
        { scope: "project", projectPath: path.join(root, "ios-app"), installPath, version: "1.0.0" },
      ],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toEqual([]);
  });

  test("includes a project-scoped plugin when the agent works inside its project", async () => {
    const projectPath = path.join(root, "ios-app");
    const cwd = path.join(projectPath, "Sources");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "market", "plugin-b", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "expert", "SwiftUI help");
    await writeManifest({
      "plugin-b@market": [{ scope: "project", projectPath, installPath, version: "1.0.0" }],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["plugin-b:expert"]);
  });

  /** A main checkout at `main` and a linked worktree of it at `worktree`, laid out as git does. */
  async function linkedWorktree(main: string, worktree: string): Promise<void> {
    const gitDir = path.join(main, ".git", "worktrees", "feature");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "commondir"), "../..\n", "utf8");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  }

  // Claude keys a project by its main checkout, and bb runs most threads in
  // worktrees kept somewhere else entirely.
  test("includes a project-scoped plugin inside a linked worktree of its project", async () => {
    const projectPath = path.join(root, "ios-app");
    const worktree = path.join(root, "worktrees", "ios-app-feature");
    await linkedWorktree(projectPath, worktree);
    const cwd = path.join(worktree, "Sources");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "market", "plugin-b", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "expert", "SwiftUI help");
    await writeManifest({
      "plugin-b@market": [{ scope: "project", projectPath, installPath, version: "1.0.0" }],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["plugin-b:expert"]);
  });

  test("maps a worktree to its own main checkout, not to any other project", async () => {
    const worktree = path.join(root, "worktrees", "web-feature");
    await linkedWorktree(path.join(root, "web"), worktree);
    const installPath = path.join(claudeHome, "plugins", "cache", "market", "plugin-b", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "expert", "SwiftUI help");
    await writeManifest({
      "plugin-b@market": [
        { scope: "project", projectPath: path.join(root, "ios-app"), installPath, version: "1.0.0" },
        { scope: "project", projectPath: path.join(root, "web", "packages", "api"), installPath, version: "1.0.0" },
      ],
    });

    const skills = await resolveClaudeSkills({ cwd: worktree, claudeHome });

    expect(skills).toEqual([]);
  });

  test("keeps project and personal skills when the manifest is missing", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Summarizes changes");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["tidy-imports"]);
  });

  test("keeps project and personal skills when the manifest is malformed", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Summarizes changes");
    const pluginsDir = path.join(claudeHome, "plugins");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(path.join(pluginsDir, "installed_plugins.json"), "{ not json", "utf8");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["tidy-imports"]);
  });

  test("sorts the whole result alphabetically across source groups", async () => {
    const cwd = path.join(root, "work");
    await writeSkill(path.join(cwd, ".claude", "skills"), "alpha", "First");
    await writeSkill(path.join(cwd, ".claude", "skills"), "zeta", "Last");
    await writeSkill(path.join(claudeHome, "skills"), "middle", "Middle");

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  test("excludes a local-scoped plugin that carries a projectPath when the agent works elsewhere", async () => {
    const cwd = path.join(root, "other-project");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "official", "widget-kit", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "widget-hooks", "Writes hooks");
    await writeManifest({
      "widget-kit@official": [
        { scope: "local", projectPath: path.join(root, "project-a"), installPath, version: "1.0.0" },
      ],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toEqual([]);
  });

  test("includes a local-scoped plugin when the agent works inside its projectPath", async () => {
    const projectPath = path.join(root, "project-a");
    const cwd = path.join(projectPath, "src");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "official", "widget-kit", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "widget-hooks", "Writes hooks");
    await writeManifest({
      "widget-kit@official": [{ scope: "local", projectPath, installPath, version: "1.0.0" }],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["widget-kit:widget-hooks"]);
  });

  test("includes an entry with no projectPath everywhere", async () => {
    const cwd = path.join(root, "anywhere");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "official", "swift-lsp", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "lsp", "Language server");
    await writeManifest({
      "swift-lsp@official": [{ scope: "local", installPath, version: "1.0.0" }],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills.map((skill) => skill.name)).toEqual(["swift-lsp:lsp"]);
  });

  test("rejects a prefix collision on projectPath", async () => {
    const cwd = path.join(root, "bar-baz");
    await mkdir(cwd, { recursive: true });
    const installPath = path.join(claudeHome, "plugins", "cache", "official", "thing", "1.0.0");
    await writeSkill(path.join(installPath, "skills"), "tool", "A tool");
    await writeManifest({
      "thing@official": [
        { scope: "project", projectPath: path.join(root, "bar"), installPath, version: "1.0.0" },
      ],
    });

    const skills = await resolveClaudeSkills({ cwd, claudeHome });

    expect(skills).toEqual([]);
  });
});
