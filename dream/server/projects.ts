/**
 * Which bb projects the dream machine has, and which of its bb worktree transcript folders belong to
 * each. Everything comes from bb: a project's checkout is its source on the dream machine, and a
 * worktree folder's project is its thread's (`bb.sdk.threads.get`, the API behind
 * `bb thread show --json`; archived threads keep their project). When bb no longer knows the thread,
 * the folder's trailing repository name decides, but only when exactly one project's checkout folder
 * has that name.
 */
import { projectSlug } from "../host/slug";

export interface BbProjectRow {
  id: string;
  name: string;
  kind?: string;
  sources: ReadonlyArray<{ hostId: string | null; path: string | null; isDefault?: boolean }>;
}

export interface Checkout {
  projectId: string;
  name: string;
  checkout: string;
}

/** Each standard project's checkout on `hostId`: its default source there, else its first. */
export function checkoutsOn(projects: readonly BbProjectRow[], hostId: string): Checkout[] {
  const result: Checkout[] = [];
  for (const project of projects) {
    if (project.kind === "personal") continue;
    const here = project.sources.filter((source) => source.hostId === hostId && typeof source.path === "string" && source.path.length > 0);
    const chosen = here.find((source) => source.isDefault) ?? here[0];
    if (chosen?.path) result.push({ projectId: project.id, name: project.name, checkout: chosen.path });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** What bb says a thread's project is: its id, null when bb has no such thread, undefined when it could not say. */
export type ThreadProjectLookup = (threadId: string) => Promise<string | null | undefined>;

export interface FolderMapping {
  byProject: Map<string, string[]>;
  /** Thread ids bb answered for, to cache: a project id, or null for a thread that is gone. */
  learned: Record<string, string | null>;
}

const LOOKUP_BATCH = 10;

/**
 * Maps worktree folders to projects. `known` is the cache from earlier sweeps; a thread's project
 * never changes, so a cached answer is final.
 */
export async function mapWorktreeFolders(
  folders: ReadonlyArray<{ name: string; threadId: string; repoSlug: string }>,
  checkouts: readonly Checkout[],
  known: Readonly<Record<string, string | null>>,
  lookup: ThreadProjectLookup,
): Promise<FolderMapping> {
  const learned: Record<string, string | null> = {};
  const unknown = [...new Set(folders.map((folder) => folder.threadId).filter((threadId) => !(threadId in known)))];
  for (let index = 0; index < unknown.length; index += LOOKUP_BATCH) {
    const batch = unknown.slice(index, index + LOOKUP_BATCH);
    const answers = await Promise.all(batch.map((threadId) => lookup(threadId)));
    batch.forEach((threadId, position) => {
      const answer = answers[position];
      if (answer !== undefined) learned[threadId] = answer;
    });
  }

  const ids = new Set(checkouts.map((checkout) => checkout.projectId));
  const byRepo = new Map<string, string[]>();
  for (const checkout of checkouts) {
    const slug = projectSlug(checkout.checkout.split(/[\\/]/).filter(Boolean).pop() ?? "");
    byRepo.set(slug, [...(byRepo.get(slug) ?? []), checkout.projectId]);
  }

  const byProject = new Map<string, string[]>();
  for (const folder of folders) {
    const answer = folder.threadId in learned ? learned[folder.threadId] : known[folder.threadId];
    let projectId: string | null = null;
    if (typeof answer === "string") projectId = ids.has(answer) ? answer : null;
    else if (answer === null) {
      const candidates = byRepo.get(folder.repoSlug) ?? [];
      projectId = candidates.length === 1 ? candidates[0] : null;
    }
    if (projectId !== null) byProject.set(projectId, [...(byProject.get(projectId) ?? []), folder.name]);
  }
  return { byProject, learned };
}

/** Finds a project by id, or by name ignoring case; an ambiguous name is an error naming the ids. */
export function findCheckout(checkouts: readonly Checkout[], query: string): Checkout {
  const wanted = query.trim();
  const byId = checkouts.find((checkout) => checkout.projectId === wanted);
  if (byId) return byId;
  const byName = checkouts.filter((checkout) => checkout.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`More than one project is called "${wanted}": ${byName.map((checkout) => checkout.projectId).join(", ")}. Pass its id.`);
  }
  throw new Error(`No project "${wanted}" has a checkout on the dream machine. \`bb dream status\` lists them.`);
}
