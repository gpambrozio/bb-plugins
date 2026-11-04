/**
 * The two RPCs, written against small ports so the tests can drive them with
 * fakes: `server.ts` binds the ports to `bb.sdk` and the host entry.
 *
 * Neither call takes a path or a directory from the app. A thread id is
 * resolved here to the thread's provider and environment; a new thread's
 * project, machine and environment ids to the checkout it would start from;
 * a skill id is looked up in what discovery produced for that subject, and
 * nothing else is ever read.
 */
import { parseFrontmatter } from "../shared/frontmatter";
import {
  dedupeByName,
  type NewThreadSubject,
  type ReportedSkills,
  type SkillDocument,
  type SkillEntry,
  type SkillList,
  type SkillSource,
  type SkillSubject,
  SOURCE_KINDS,
} from "../shared/skills";
import { selectReported, type ReportedCommand } from "./reported";

/**
 * Where a thread runs, as the server resolved it. A new thread that would not
 * reuse an environment has none yet (`environmentId: null`), and runs from
 * its project's checkout on `hostId`.
 */
export interface ThreadWorkspace {
  provider: string;
  projectId: string;
  environmentId: string | null;
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

/** A project as `bb.sdk.projects.get` describes it, as far as a new thread needs. */
export interface ProjectCheckouts {
  id: string;
  kind: string;
  sources: ReadonlyArray<{ hostId: string; path: string; isDefault: boolean }>;
}

/**
 * Where a new thread would start, from what the new-thread composer has
 * selected — or why there is nowhere to look, in words the browser shows as
 * they are.
 *
 * - An environment it would reuse is that environment, if it is this
 *   project's and still there. One left over from the project selected before
 *   is not, and is passed over.
 * - Otherwise it is the project's checkout on the selected machine (its
 *   default one there), or the project's default checkout when no machine is
 *   selected. A new worktree is made from that checkout, so its skills are the
 *   ones the thread starts with.
 */
export function newThreadWorkspaceFrom(
  subject: NewThreadSubject,
  project: ProjectCheckouts,
  environment: { id: string; projectId: string; hostId: string; path: string | null; status: string } | null,
): ThreadWorkspace {
  const base = { provider: subject.providerId, projectId: project.id };
  if (project.kind === "personal") {
    throw new Error("A thread outside a project has no checkout to scan. Choose a project to see its skills.");
  }
  if (
    environment !== null &&
    environment.projectId === project.id &&
    environment.status !== "destroyed" &&
    environment.path !== null
  ) {
    return { ...base, environmentId: environment.id, hostId: environment.hostId, cwd: environment.path };
  }
  const candidates =
    subject.hostId === null ? project.sources : project.sources.filter((source) => source.hostId === subject.hostId);
  const source = candidates.find((candidate) => candidate.isDefault) ?? candidates[0];
  if (source === undefined) {
    throw new Error(
      subject.hostId === null
        ? "This project has no checkout to scan."
        : "This project has no checkout on the selected machine.",
    );
  }
  return { ...base, environmentId: null, hostId: source.hostId, cwd: source.path };
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
  /** Throws a message fit for the browser when the subject has nowhere to look. */
  workspaceOf(subject: SkillSubject): Promise<ThreadWorkspace>;
  discover(workspace: ThreadWorkspace): Promise<{ scanned: boolean; skills: SkillEntry[] }>;
  readDiscovered(workspace: ThreadWorkspace, skillId: string): Promise<SkillDocument>;
  bbSkills(scope: BbSkillScope): Promise<BbSkill[]>;
  bbSkillContent(scope: BbSkillScope, bbSkillId: string): Promise<string>;
  commands(workspace: ThreadWorkspace): Promise<ReportedCommand[]>;
  /** bb's primary host, where bb's skill calls land when they name no environment. */
  primaryHostId(): Promise<string | null>;
}

/** What `bb.sdk.skills.list` and `getContent` take: a project, and an environment or none. */
export interface BbSkillScope {
  projectId: string;
  environmentId: string | null;
}

/**
 * How bb's skill list is asked for a workspace, and which of its rows belong
 * to it. bb's skill calls take an environment or none, never a machine; with
 * none, bb scans the project's checkout on its primary host.
 *
 * - A workspace with an environment (every thread's, and a new thread that
 *   would reuse one) names it, and every row is that environment's.
 * - A new thread's checkout on the primary host names none, and gets the same
 *   checkout.
 * - A new thread's checkout on any other machine cannot be named. Asking with
 *   none would scan the primary host's checkout, so only the rows bb's server
 *   owns — the same for a thread on any machine — are kept (`serverOwnedOnly`),
 *   and none of the primary host's own.
 */
export interface BbSkillRoute {
  scope: BbSkillScope;
  serverOwnedOnly: boolean;
}

export function bbSkillRouteFor(workspace: ThreadWorkspace, primaryHostId: string | null): BbSkillRoute {
  const scope = { projectId: workspace.projectId, environmentId: workspace.environmentId };
  return { scope, serverOwnedOnly: workspace.environmentId === null && workspace.hostId !== primaryHostId };
}

async function bbSkillRoute(ports: SkillsPorts, workspace: ThreadWorkspace): Promise<BbSkillRoute> {
  // A thread always has an environment, so it never asks for the primary host.
  const primaryHostId = workspace.environmentId === null ? await ports.primaryHostId() : null;
  return bbSkillRouteFor(workspace, primaryHostId);
}

/**
 * bb's plugins' skills, read from bb's server whatever the machine. Other
 * scopes (`bb-user`, `bb-builtin`) can come from a host's scan as well as from
 * the server, and nothing in a row tells the two apart, so they are not
 * counted as the server's.
 */
function isServerOwned(skill: BbSkill): boolean {
  return skill.scope === "plugin" && skill.provider === null && skill.pluginId !== null;
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

async function bbEntries(ports: SkillsPorts, workspace: ThreadWorkspace, route: BbSkillRoute): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  for (const skill of await ports.bbSkills(route.scope)) {
    if (route.serverOwnedOnly && !isServerOwned(skill)) continue;
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

/**
 * bb's rows for the list. When they come from another machine than the
 * workspace's (`serverOwnedOnly`), that machine being out of reach must not
 * lose the rest of the list, so the failure travels with the list instead;
 * otherwise it fails the list, as discovery's would.
 */
async function loadBbEntries(
  ports: SkillsPorts,
  workspace: ThreadWorkspace,
): Promise<{ entries: SkillEntry[]; error: string | null }> {
  const route = await bbSkillRoute(ports, workspace);
  if (!route.serverOwnedOnly) return { entries: await bbEntries(ports, workspace, route), error: null };
  try {
    return { entries: await bbEntries(ports, workspace, route), error: null };
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listSkills(ports: SkillsPorts, subject: SkillSubject): Promise<SkillList> {
  const workspace = await ports.workspaceOf(subject);
  const [discovery, bb] = await Promise.all([ports.discover(workspace), loadBbEntries(ports, workspace)]);
  // Discovery's scopes come first, so a name both define is listed once, under
  // the copy the provider's own search path finds.
  const skills = dedupeByName([...discovery.skills, ...bb.entries]).sort((a, b) => a.name.localeCompare(b.name));
  return {
    provider: workspace.provider,
    scanned: discovery.scanned,
    cwd: workspace.cwd,
    skills,
    bbError: bb.error,
    reported: await loadReported(ports, workspace, skills),
  };
}

/**
 * Takes a skill id, never a path, and reads only what discovery produced for
 * this subject: an id taken from bb's skill list must be one this subject gets
 * from it again, and any other id is looked up by the host entry in a fresh
 * scan.
 */
export async function readSkill(ports: SkillsPorts, subject: SkillSubject, skillId: string): Promise<SkillDocument> {
  const workspace = await ports.workspaceOf(subject);
  if (!skillId.startsWith(BB_ID_PREFIX)) return ports.readDiscovered(workspace, skillId);

  const route = await bbSkillRoute(ports, workspace);
  const entry = (await bbEntries(ports, workspace, route)).find((candidate) => candidate.id === skillId);
  if (entry === undefined) throw new Error(`Skill not available: ${skillId}`);
  const content = await ports.bbSkillContent(route.scope, skillId.slice(BB_ID_PREFIX.length));
  return { name: entry.name, description: entry.description, path: entry.path, body: parseFrontmatter(content).body };
}
