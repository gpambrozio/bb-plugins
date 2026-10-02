/**
 * The two RPCs, written against small ports so the tests can drive them with
 * fakes: `server.ts` binds the ports to `bb.sdk` and the host entry.
 *
 * Neither call takes a path, a provider or a directory from the app. A thread
 * id is resolved here to the thread's provider and environment; a skill id is
 * looked up in what discovery produced for that thread, and nothing else is
 * ever read.
 */
import { parseFrontmatter } from "../shared/frontmatter";
import {
  dedupeByName,
  type ReportedSkills,
  type SkillDocument,
  type SkillEntry,
  type SkillList,
  type SkillSource,
  SOURCE_KINDS,
} from "../shared/skills";
import { selectReported, type ReportedCommand } from "./reported";

/** Where a thread runs, as the server resolved it. */
export interface ThreadWorkspace {
  provider: string;
  projectId: string;
  environmentId: string;
  hostId: string;
  cwd: string;
}

/**
 * Where a thread runs, from the thread and its environment — or why there is
 * nowhere to look, in words the browser shows as they are.
 */
export function workspaceFrom(
  thread: { providerId: string; projectId: string; environmentId: string | null },
  environment: { id: string; hostId: string; path: string | null; status: string } | null,
): ThreadWorkspace {
  if (thread.environmentId === null || environment === null) throw new Error("This thread has no environment yet.");
  if (environment.status === "destroyed") {
    throw new Error("This thread's environment has been removed, so there is nothing to scan.");
  }
  if (environment.path === null) throw new Error("This thread's environment is not ready yet.");
  return {
    provider: thread.providerId,
    projectId: thread.projectId,
    environmentId: environment.id,
    hostId: environment.hostId,
    cwd: environment.path,
  };
}

/** One of bb's own skills, as `bb.sdk.skills.list` describes it. */
export interface BbSkill {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  provider: string | null;
  pluginId: string | null;
  filePath: string;
}

export interface SkillsPorts {
  /** Throws a message fit for the browser when the thread has nowhere to look. */
  workspaceOf(threadId: string): Promise<ThreadWorkspace>;
  discover(workspace: ThreadWorkspace): Promise<{ scanned: boolean; skills: SkillEntry[] }>;
  readDiscovered(workspace: ThreadWorkspace, skillId: string): Promise<SkillDocument>;
  bbSkills(workspace: ThreadWorkspace): Promise<BbSkill[]>;
  bbSkillContent(workspace: ThreadWorkspace, bbSkillId: string): Promise<string>;
  commands(workspace: ThreadWorkspace): Promise<ReportedCommand[]>;
}

/** Marks an id taken from bb's skill list; its content is read through bb. */
const BB_ID_PREFIX = "bb:";

/** bb's own scopes: skills bb injects into every thread, whatever its provider. */
const BB_SCOPES = new Set(["bb-builtin", "bb-user", "bb-project"]);

/**
 * What bb's skill list contributes for a thread on `provider`, as a source, or
 * null for a row this thread does not get from bb's list:
 *
 * - bb's own skills — its plugins' (scope `plugin` with no provider),
 *   `~/.bb/skills` and the workspace's `.bb/skills` — which bb injects into
 *   every thread;
 * - the thread's own provider's plugin skills (scope `plugin` with that
 *   provider), which bb finds where no resolver here looks: Codex's plugins
 *   under `~/.codex/plugins`.
 *
 * The rest of bb's list is every provider's own roots (`provider-*`,
 * `shared-*`) for every provider; discovery reads those for the one provider
 * whose thread this is, in its order.
 */
function sourceFor(skill: BbSkill, provider: string): Pick<SkillSource, "kind" | "label"> | null {
  if (skill.scope === "plugin" && skill.provider === provider) {
    return { kind: "plugin", label: skill.pluginId ?? "Plugins" };
  }
  if (skill.provider !== null) return null;
  if (skill.scope === "plugin") return { kind: "bb", label: skill.pluginId === null ? "bb plugins" : `bb plugin · ${skill.pluginId}` };
  if (!BB_SCOPES.has(skill.scope)) return null;
  if (skill.scope === "bb-project") return { kind: "bb", label: "bb project" };
  if (skill.scope === "bb-user") return { kind: "bb", label: "bb personal" };
  return { kind: "bb", label: "bb built-in" };
}

/** `…/<skills dir>/<skill>/SKILL.md` → `…/<skills dir>`, whichever separator the host uses. */
function skillsDirOf(filePath: string): string {
  const separator = filePath.includes("/") ? "/" : "\\";
  return filePath.split(separator).slice(0, -2).join(separator);
}

async function bbEntries(ports: SkillsPorts, workspace: ThreadWorkspace): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  for (const skill of await ports.bbSkills(workspace)) {
    const source = sourceFor(skill, workspace.provider);
    if (source === null) continue;
    entries.push({
      id: `${BB_ID_PREFIX}${skill.id}`,
      name: skill.name,
      description: skill.description ?? "",
      source: { ...source, dir: skillsDirOf(skill.filePath) },
      path: skill.filePath,
      userInvocable: true,
      status: "discovered",
    });
  }
  // The provider's plugins rank above what bb injects, as in the browser.
  return entries.sort((a, b) => SOURCE_KINDS.indexOf(a.source.kind) - SOURCE_KINDS.indexOf(b.source.kind));
}

/**
 * Asks bb's provider what the thread can run. A failure here never fails the
 * whole list: discovery already succeeded, and losing it because the provider
 * could not answer would be worse than a missing section. The error travels
 * with the section so the browser can say why it is empty.
 */
async function loadReported(
  ports: SkillsPorts,
  workspace: ThreadWorkspace,
  discovered: SkillEntry[],
): Promise<ReportedSkills> {
  try {
    const commands = await ports.commands(workspace);
    return { error: null, ...selectReported(commands, discovered.map((entry) => entry.name)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), skills: [], commands: [] };
  }
}

export async function listSkills(ports: SkillsPorts, threadId: string): Promise<SkillList> {
  const workspace = await ports.workspaceOf(threadId);
  const [discovery, bb] = await Promise.all([ports.discover(workspace), bbEntries(ports, workspace)]);
  // Discovery's scopes come first, so a name both define is listed once, under
  // the copy the provider's own search path finds.
  const skills = dedupeByName([...discovery.skills, ...bb]).sort((a, b) => a.name.localeCompare(b.name));
  return {
    provider: workspace.provider,
    scanned: discovery.scanned,
    cwd: workspace.cwd,
    skills,
    reported: await loadReported(ports, workspace, skills),
  };
}

/**
 * Takes a skill id, never a path, and reads only what discovery produced for
 * this thread: an id taken from bb's skill list must be one this thread gets
 * from it again, and any other id is looked up by the host entry in a fresh
 * scan.
 */
export async function readSkill(ports: SkillsPorts, threadId: string, skillId: string): Promise<SkillDocument> {
  const workspace = await ports.workspaceOf(threadId);
  if (!skillId.startsWith(BB_ID_PREFIX)) return ports.readDiscovered(workspace, skillId);

  const entry = (await bbEntries(ports, workspace)).find((candidate) => candidate.id === skillId);
  if (entry === undefined) throw new Error(`Skill not available: ${skillId}`);
  const content = await ports.bbSkillContent(workspace, skillId.slice(BB_ID_PREFIX.length));
  return { name: entry.name, description: entry.description, path: entry.path, body: parseFrontmatter(content).body };
}
