/**
 * The whole server against the SDK's fake host, for where a new thread's
 * skills come from when the project has a checkout on two machines: `mini`,
 * bb's primary host, and `laptop`. Each machine's host entry and bb's skill
 * list answer with skills only that machine has, so a row that reaches the
 * wrong machine's list shows by name. Nothing here talks to a running bb.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import type { SkillDocument, SkillEntry, SkillList } from "./shared/skills";

const PROJECT = {
  id: "proj_example",
  kind: "standard",
  name: "example",
  gitRemoteUrl: null,
  createdAt: 0,
  updatedAt: 0,
  sources: [
    { id: "src_mini", projectId: "proj_example", type: "local_path", hostId: "mini", path: "/mini/example", isDefault: true, createdAt: 0, updatedAt: 0 },
    { id: "src_laptop", projectId: "proj_example", type: "local_path", hostId: "laptop", path: "/laptop/example", isDefault: false, createdAt: 0, updatedAt: 0 },
  ],
};

/** An environment of the project on the laptop, for a new thread that would reuse it. */
const LAPTOP_ENVIRONMENT = { id: "env_laptop", projectId: "proj_example", hostId: "laptop", path: "/laptop/tree", status: "ready" };

function discovered(name: string, dir: string): SkillEntry {
  return {
    id: `project:${dir}:${name}`,
    name,
    description: `Description for ${name}`,
    source: { kind: "project", label: "Project", dir },
    path: `${dir}/${name}/SKILL.md`,
    userInvocable: true,
    status: "discovered",
  };
}

function bbRow(name: string, scope: string, filePath: string, pluginId: string | null = null) {
  return { id: `skill_${name}`, name, description: `Description for ${name}`, scope, provider: null, pluginId, filePath, manageable: false, registrySkillId: null };
}

/** bb's own plugin skill: the server's, the same on every machine. */
const PLUGIN_ROW = bbRow("plugin-guide", "plugin", "/server/plugins/guide/skills/plugin-guide/SKILL.md", "guide");

/**
 * bb's skill list, as bb 0.48.1 answers it: with no environment it scans the
 * project's checkout on the primary host.
 */
function bbSkillRows(environmentId: string | null) {
  if (environmentId === null) return [PLUGIN_ROW, bbRow("mini-only", "bb-project", "/mini/example/.bb/skills/mini-only/SKILL.md")];
  if (environmentId === "env_laptop") return [PLUGIN_ROW, bbRow("laptop-tree-only", "bb-project", "/laptop/tree/.bb/skills/laptop-tree-only/SKILL.md")];
  throw new Error(`no environment ${environmentId}`);
}

function start(options: { primaryOffline?: boolean } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "skills",
    sdk: {
      system: { config: async () => ({ primaryHostId: "mini" }) as never },
      projects: {
        get: async () => PROJECT as never,
        commands: async () => ({ commands: [] }) as never,
      },
      environments: { get: async () => LAPTOP_ENVIRONMENT as never },
      skills: {
        list: async (args) => {
          if (options.primaryOffline && args.environmentId === null) throw new Error("Host mini is offline.");
          return { skills: bbSkillRows(args.environmentId) } as never;
        },
        getContent: async (args) => ({ content: `---\n---\nBody of ${args.skillId}\n`, revision: "r" }) as never,
      },
    },
    experimental_callHostRpc: ({ method, input, hostId }) => {
      const { cwd, skillId } = input as { cwd: string; skillId?: string };
      const skill = discovered(`${hostId}-skill`, `${cwd}/.claude/skills`);
      if (method === "discover") return { scanned: true, skills: [skill] };
      if (method === "read" && skillId === skill.id) {
        return { name: skill.name, description: skill.description, path: skill.path, body: `Body on ${hostId}\n` } satisfies SkillDocument;
      }
      throw new Error(`Skill not available: ${skillId}`);
    },
  });
  return { bb, harness, ready: plugin(bb) };
}

const onMachine = (hostId: string | null, environmentId: string | null = null) => ({
  newThread: { projectId: "proj_example", providerId: "claude-code", hostId, environmentId },
});

async function list(server: ReturnType<typeof start>, input: unknown): Promise<SkillList> {
  await server.ready;
  return (await server.harness.callRpc("list", input)) as SkillList;
}

describe("a new thread's skills, on the machine it would run on", () => {
  it("lists the laptop's checkout and bb's plugins' skills, and none of the primary host's own", async () => {
    const server = start();
    const result = await list(server, onMachine("laptop"));

    expect(result.cwd).toBe("/laptop/example");
    expect(result.skills.map((skill) => skill.name)).toEqual(["laptop-skill", "plugin-guide"]);
    expect(result.bbError).toBeNull();
    expect(server.harness.sdk.callsTo("projects.commands")).toEqual([
      [expect.objectContaining({ projectId: "proj_example", hostId: "laptop", provider: "claude-code" })],
    ]);
  });

  it("reads on the laptop, and refuses the primary host's row", async () => {
    const server = start();
    await server.ready;
    const laptopSkill = `project:/laptop/example/.claude/skills:laptop-skill`;

    const local = (await server.harness.callRpc("read", { ...onMachine("laptop"), skillId: laptopSkill })) as SkillDocument;
    expect(local.body).toBe("Body on laptop\n");
    const pluginSkill = (await server.harness.callRpc("read", { ...onMachine("laptop"), skillId: "bb:skill_plugin-guide" })) as SkillDocument;
    expect(pluginSkill.body).toBe("Body of skill_plugin-guide\n");
    await expect(server.harness.callRpc("read", { ...onMachine("laptop"), skillId: "bb:skill_mini-only" })).rejects.toThrow(
      /not available/,
    );
    expect(server.harness.sdk.callsTo("skills.getContent")).toEqual([
      [expect.objectContaining({ projectId: "proj_example", environmentId: null, skillId: "skill_plugin-guide" })],
    ]);
  });

  it("lists the primary host's checkout with all of bb's rows for it", async () => {
    const server = start();
    const result = await list(server, onMachine("mini"));

    expect(result.cwd).toBe("/mini/example");
    expect(result.skills.map((skill) => skill.name)).toEqual(["mini-only", "mini-skill", "plugin-guide"]);
  });

  it("names the environment a new thread would reuse to bb, and lists every row of it", async () => {
    const server = start();
    const result = await list(server, onMachine(null, "env_laptop"));

    expect(result.cwd).toBe("/laptop/tree");
    expect(result.skills.map((skill) => skill.name)).toEqual(["laptop-skill", "laptop-tree-only", "plugin-guide"]);
    expect(server.harness.sdk.callsTo("skills.list")).toEqual([[expect.objectContaining({ environmentId: "env_laptop" })]]);
  });

  it("keeps the laptop's list when the primary host is out of reach, and says why bb's skills are missing", async () => {
    const server = start({ primaryOffline: true });
    const result = await list(server, onMachine("laptop"));

    expect(result.skills.map((skill) => skill.name)).toEqual(["laptop-skill"]);
    expect(result.bbError).toBe("Host mini is offline.");
  });
});
