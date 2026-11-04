import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { discoverSkills, readDiscoveredSkill, type SkillRoots } from "../host/discover";
import { SkillListSchema } from "../shared/skills";
import type { ReportedCommand } from "./reported";
import {
  listSkills,
  newThreadWorkspaceFrom,
  readSkill,
  workspaceFrom,
  type BbSkill,
  type ProjectCheckouts,
  type SkillsPorts,
  type ThreadWorkspace,
} from "./skills";

const THREAD = { threadId: "thr_example" };

let root: string;
let roots: SkillRoots;
let cwd: string;

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    "utf8",
  );
}

function bbSkill(overrides: Partial<BbSkill> & { name: string }): BbSkill {
  return {
    id: `skill_${overrides.name}`,
    description: `Description for ${overrides.name}`,
    scope: "plugin",
    provider: null,
    pluginId: "example-plugin",
    filePath: `/opt/bb/plugins/example-plugin/skills/${overrides.name}/SKILL.md`,
    ...overrides,
  };
}

function command(name: string, source: ReportedCommand["source"] = "skill"): ReportedCommand {
  return { name, description: `Description for ${name}`, argumentHint: null, source, origin: "builtin" };
}

/**
 * Real discovery against temp-dir homes, behind the same ports `server.ts`
 * binds to the host entry; bb's own skills and the reported list are fakes.
 */
function portsFor(options: {
  provider?: string;
  bb?: BbSkill[];
  contents?: Record<string, string>;
  commands?: () => Promise<ReportedCommand[]>;
  workspace?: () => Promise<ThreadWorkspace>;
}) {
  const workspace: ThreadWorkspace = {
    provider: options.provider ?? "claude-code",
    projectId: "proj_example",
    environmentId: "env_example",
    hostId: "host_example",
    cwd,
  };
  const bbSkillContent = vi.fn(async (_workspace: ThreadWorkspace, id: string) => {
    const content = options.contents?.[id];
    if (content === undefined) throw new Error(`no content for ${id}`);
    return content;
  });
  const ports: SkillsPorts = {
    workspaceOf: options.workspace ?? (async () => workspace),
    discover: (ws) => discoverSkills(ws, roots),
    readDiscovered: (ws, skillId) => readDiscoveredSkill({ ...ws, skillId }, roots),
    bbSkills: async () => options.bb ?? [],
    bbSkillContent,
    commands: options.commands ?? (async () => []),
  };
  return { ports, bbSkillContent };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bb-skills-server-"));
  cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  roots = {
    claudeHome: path.join(root, "claude-home"),
    codexHome: path.join(root, "codex-home"),
    agentsHome: path.join(root, "agents-home"),
    adminSkillsDir: path.join(root, "etc", "codex", "skills"),
    hermesHome: path.join(root, "hermes-home"),
  };
});

describe("listSkills", () => {
  test("lists the provider's skills with the thread's provider and directory", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");

    const result = await listSkills(portsFor({}).ports, THREAD);

    expect(result.provider).toBe("claude-code");
    expect(result.scanned).toBe(true);
    expect(result.cwd).toBe(cwd);
    expect(result.skills.map((skill) => skill.name)).toEqual(["tidy-imports"]);
    expect(() => SkillListSchema.parse(result)).not.toThrow();
  });

  test("adds the skills bb injects, under their own source", async () => {
    const { ports } = portsFor({
      bb: [
        bbSkill({ name: "plugin-guide" }),
        bbSkill({ name: "house-style", scope: "bb-user", pluginId: null, filePath: "/home/me/.bb/skills/house-style/SKILL.md" }),
        bbSkill({ name: "repo-rules", scope: "bb-project", pluginId: null, filePath: `${cwd}/.bb/skills/repo-rules/SKILL.md` }),
      ],
    });

    const result = await listSkills(ports, THREAD);

    expect(result.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ["house-style", { kind: "bb", label: "bb personal", dir: "/home/me/.bb/skills" }],
      ["plugin-guide", { kind: "bb", label: "bb plugin · example-plugin", dir: "/opt/bb/plugins/example-plugin/skills" }],
      ["repo-rules", { kind: "bb", label: "bb project", dir: `${cwd}/.bb/skills` }],
    ]);
    expect(result.skills.every((skill) => skill.id.startsWith("bb:"))).toBe(true);
  });

  // bb's list also holds every provider's own roots; discovery reads the one
  // provider whose thread this is, so those rows would list another provider's
  // skills as this agent's.
  test("leaves out the provider roots bb's list also carries", async () => {
    const { ports } = portsFor({
      bb: [
        bbSkill({ name: "codex-only", scope: "provider-user", provider: "codex", pluginId: null }),
        bbSkill({ name: "codex-plugin", scope: "plugin", provider: "codex" }),
        bbSkill({ name: "shared", scope: "shared-user", provider: null, pluginId: null }),
      ],
    });

    const result = await listSkills(ports, THREAD);

    expect(result.skills).toEqual([]);
  });

  test("adds the thread's own provider's plugin skills bb found, as plugin sources", async () => {
    const pluginSkill = bbSkill({
      name: "slides:deck",
      provider: "codex",
      pluginId: "slides",
      filePath: "/home/me/.codex/plugins/cache/slides/skills/deck/SKILL.md",
    });
    const { ports, bbSkillContent } = portsFor({
      provider: "codex",
      bb: [pluginSkill, bbSkill({ name: "plugin-guide" })],
      contents: { [pluginSkill.id]: "---\nname: deck\ndescription: Decks\n---\nMake a deck.\n" },
    });

    const result = await listSkills(ports, THREAD);

    expect(result.skills.map((skill) => [skill.name, skill.source.kind, skill.source.label])).toEqual([
      ["plugin-guide", "bb", "bb plugin · example-plugin"],
      ["slides:deck", "plugin", "slides"],
    ]);
    const document = await readSkill(ports, THREAD, result.skills[1]!.id);
    expect(bbSkillContent).toHaveBeenCalledWith(expect.anything(), pluginSkill.id);
    expect(document.body).toBe("Make a deck.\n");
  });

  test("ranks a provider plugin's copy above bb's when the two share a name", async () => {
    const { ports } = portsFor({
      provider: "codex",
      bb: [bbSkill({ name: "shared-name" }), bbSkill({ name: "shared-name", id: "skill_codex", provider: "codex", pluginId: "slides" })],
    });

    const result = await listSkills(ports, THREAD);

    expect(result.skills.map((skill) => skill.source.kind)).toEqual(["plugin"]);
  });

  test("keeps the provider's copy when bb injects a skill of the same name", async () => {
    await writeSkill(path.join(roots.claudeHome, "skills"), "plugin-guide", "The personal copy");
    const { ports } = portsFor({ bb: [bbSkill({ name: "plugin-guide" })] });

    const result = await listSkills(ports, THREAD);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.source.kind).toBe("personal");
    expect(result.skills[0]!.description).toBe("The personal copy");
  });

  test("lists bb's skills and the reported list for a provider discovery does not scan", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
    const { ports } = portsFor({
      provider: "pi",
      bb: [bbSkill({ name: "plugin-guide" })],
      commands: async () => [command("plugin-guide"), command("explain"), command("clear", "command")],
    });

    const result = await listSkills(ports, THREAD);

    expect(result.scanned).toBe(false);
    expect(result.skills.map((skill) => skill.name)).toEqual(["plugin-guide"]);
    expect(result.reported).toEqual({
      error: null,
      skills: [{ name: "explain", description: "Description for explain", argumentHint: "", origin: "builtin" }],
      commands: [{ name: "clear", description: "Description for clear", argumentHint: "", origin: "builtin" }],
    });
  });

  test("leaves out of the reported list every name discovery or bb already listed", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
    const { ports } = portsFor({
      bb: [bbSkill({ name: "plugin-guide" })],
      commands: async () => [command("tidy-imports"), command("plugin-guide"), command("charts")],
    });

    const result = await listSkills(ports, THREAD);

    expect(result.reported.skills.map((entry) => entry.name)).toEqual(["charts"]);
  });

  test("keeps the discovered list when the reported list cannot be had", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
    const { ports } = portsFor({
      commands: async () => {
        throw new Error("provider is not available");
      },
    });

    const result = await listSkills(ports, THREAD);

    expect(result.skills.map((skill) => skill.name)).toEqual(["tidy-imports"]);
    expect(result.reported).toEqual({ error: "provider is not available", skills: [], commands: [] });
  });

  test("fails with the reason when the thread has nowhere to look", async () => {
    const { ports } = portsFor({
      workspace: async () => {
        throw new Error("This thread has no environment yet.");
      },
    });

    await expect(listSkills(ports, THREAD)).rejects.toThrow("This thread has no environment yet.");
  });
});

describe("readSkill", () => {
  test("reads a discovered skill through the host", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
    const { ports } = portsFor({});
    const listed = await listSkills(ports, THREAD);

    const result = await readSkill(ports, THREAD, listed.skills[0]!.id);

    expect(result.body).toBe("Body for tidy-imports.\n");
  });

  test("reads one of bb's skills through bb, without its frontmatter", async () => {
    const skill = bbSkill({ name: "plugin-guide" });
    const { ports, bbSkillContent } = portsFor({
      bb: [skill],
      contents: { [skill.id]: "---\nname: plugin-guide\ndescription: Guides\n---\n\n# Guide\n" },
    });
    const listed = await listSkills(ports, THREAD);

    const result = await readSkill(ports, THREAD, listed.skills[0]!.id);

    expect(bbSkillContent).toHaveBeenCalledWith(expect.anything(), skill.id);
    expect(result).toEqual({
      name: "plugin-guide",
      description: "Description for plugin-guide",
      path: skill.filePath,
      body: "# Guide\n",
    });
  });

  // The security boundary: `read` takes an id discovery produced for this
  // thread, never a path, on either side of the bb/host split.
  describe("only reads what discovery produced", () => {
    test("refuses a bb id bb's list no longer has", async () => {
      const { ports, bbSkillContent } = portsFor({ bb: [], contents: { skill_gone: "---\n---\n" } });

      await expect(readSkill(ports, THREAD, "bb:skill_gone")).rejects.toThrow(/not available/);
      expect(bbSkillContent).not.toHaveBeenCalled();
    });

    test("refuses a bb id for a provider root bb's list carries but this thread does not load", async () => {
      const foreign = bbSkill({ name: "codex-only", scope: "provider-user", provider: "codex", pluginId: null });
      const { ports, bbSkillContent } = portsFor({ bb: [foreign], contents: { [foreign.id]: "---\n---\n" } });

      await expect(readSkill(ports, THREAD, `bb:${foreign.id}`)).rejects.toThrow(/not available/);
      expect(bbSkillContent).not.toHaveBeenCalled();
    });

    test("refuses a path, and an id naming a file no scan produced", async () => {
      const secret = path.join(root, "secret");
      await writeSkill(secret, "notes", "Not a skill anyone installed");
      const { ports } = portsFor({});

      for (const skillId of [path.join(secret, "notes", "SKILL.md"), `project:${secret}:notes`, "bb:"]) {
        await expect(readSkill(ports, THREAD, skillId)).rejects.toThrow(/not available/);
      }
    });
  });
});

describe("workspaceFrom", () => {
  const thread = { providerId: "codex", projectId: "proj_example", environmentId: "env_example" };
  const environment = { id: "env_example", hostId: "host_example", path: "/work/example", status: "ready" };

  test("takes the provider from the thread and the machine and directory from its environment", () => {
    expect(workspaceFrom(thread, environment)).toEqual({
      provider: "codex",
      projectId: "proj_example",
      environmentId: "env_example",
      hostId: "host_example",
      cwd: "/work/example",
    });
  });

  test("says why there is nowhere to look", () => {
    expect(() => workspaceFrom({ ...thread, environmentId: null }, null)).toThrow("This thread has no environment yet.");
    expect(() => workspaceFrom(thread, { ...environment, path: null, status: "provisioning" })).toThrow(
      "This thread's environment is not ready yet.",
    );
    expect(() => workspaceFrom(thread, { ...environment, path: null, status: "destroyed" })).toThrow(
      "This thread's environment has been removed, so there is nothing to scan.",
    );
  });
});

describe("newThreadWorkspaceFrom", () => {
  const subject = { projectId: "proj_example", providerId: "codex", hostId: null, environmentId: null };
  const project: ProjectCheckouts = {
    id: "proj_example",
    kind: "standard",
    sources: [
      { hostId: "host_laptop", path: "/laptop/example", isDefault: false },
      { hostId: "host_mini", path: "/mini/example", isDefault: true },
      { hostId: "host_mini", path: "/mini/example-2", isDefault: false },
    ],
  };
  const environment = { id: "env_example", projectId: "proj_example", hostId: "host_laptop", path: "/work/tree", status: "ready" };

  test("takes the provider from the selection and the project's default checkout when no machine is selected", () => {
    expect(newThreadWorkspaceFrom(subject, project, null)).toEqual({
      provider: "codex",
      projectId: "proj_example",
      environmentId: null,
      hostId: "host_mini",
      cwd: "/mini/example",
    });
  });

  test("takes the project's checkout on the selected machine", () => {
    expect(newThreadWorkspaceFrom({ ...subject, hostId: "host_laptop" }, project, null)).toMatchObject({
      hostId: "host_laptop",
      cwd: "/laptop/example",
      environmentId: null,
    });
    expect(newThreadWorkspaceFrom({ ...subject, hostId: "host_mini" }, project, null)).toMatchObject({ cwd: "/mini/example" });
  });

  test("takes an environment it would reuse, when that is this project's and still there", () => {
    expect(newThreadWorkspaceFrom({ ...subject, environmentId: "env_example" }, project, environment)).toEqual({
      provider: "codex",
      projectId: "proj_example",
      environmentId: "env_example",
      hostId: "host_laptop",
      cwd: "/work/tree",
    });
  });

  // A selection that still names the previous project's environment, or one
  // that is gone, falls back to the checkout.
  test("passes over another project's environment and one with nowhere to look", () => {
    const withEnvironment = { ...subject, environmentId: "env_example" };
    for (const other of [
      { ...environment, projectId: "proj_other" },
      { ...environment, path: null, status: "destroyed" },
      { ...environment, path: null, status: "provisioning" },
    ]) {
      expect(newThreadWorkspaceFrom(withEnvironment, project, other)).toMatchObject({ environmentId: null, cwd: "/mini/example" });
    }
  });

  test("says why there is nowhere to look", () => {
    expect(() => newThreadWorkspaceFrom(subject, { id: "proj_personal", kind: "personal", sources: [] }, null)).toThrow(
      "A thread outside a project has no checkout to scan. Choose a project to see its skills.",
    );
    expect(() => newThreadWorkspaceFrom({ ...subject, hostId: "host_elsewhere" }, project, null)).toThrow(
      "This project has no checkout on the selected machine.",
    );
    expect(() => newThreadWorkspaceFrom(subject, { ...project, sources: [] }, null)).toThrow("This project has no checkout to scan.");
  });
});

describe("a new thread's skills", () => {
  const newThread = { projectId: "proj_example", providerId: "claude-code", hostId: "host_example", environmentId: null };

  test("are listed and read from the workspace the subject resolves to", async () => {
    await writeSkill(path.join(cwd, ".claude", "skills"), "tidy-imports", "Sorts imports");
    const asked: unknown[] = [];
    const { ports } = portsFor({
      workspace: async () => ({ provider: "claude-code", projectId: "proj_example", environmentId: null, hostId: "host_example", cwd }),
    });
    const workspaceOf = ports.workspaceOf;
    ports.workspaceOf = (subject) => {
      asked.push(subject);
      return workspaceOf(subject);
    };

    const listed = await listSkills(ports, { newThread });
    const document = await readSkill(ports, { newThread }, listed.skills[0]!.id);

    expect(listed.skills.map((skill) => skill.name)).toEqual(["tidy-imports"]);
    expect(document.body).toBe("Body for tidy-imports.\n");
    expect(asked).toEqual([{ newThread }, { newThread }]);
  });
});
