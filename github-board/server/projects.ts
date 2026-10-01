/**
 * Which bb projects a card's repository belongs to.
 *
 * A card names the repository its work lives in (`<host>/<owner>/<name>`, see
 * `repositoryIdFor`). A bb project records its checkout's `origin` as
 * `gitRemoteUrl`, and that is matched first: it costs no subprocess and holds
 * for projects on every machine. Only a repository no project claims that way
 * is looked for in the other remotes — `git remote -v` — of checkouts on the
 * server's own machine, which is where a fork's `upstream` is found. The order
 * is load-bearing: a repository that is one project's origin and another's
 * upstream resolves to the project it is the origin of.
 *
 * The same repository is often a separate bb project per machine, so a match
 * is a list; `preferredProject` picks the one the send dialog opens on.
 */
import { normalizeRemoteUrl } from "../shared/remotes";

/** The fields of a bb project this file reads. */
export interface ProjectRecord {
  id: string;
  name: string;
  kind: string;
  gitRemoteUrl: string | null;
  sources: readonly { hostId: string; path: string }[];
}

export interface ProjectRef {
  id: string;
  name: string;
  /** Machines holding a checkout of it. */
  hostIds: string[];
}

export interface ProjectIndex {
  /** `<host>/<owner>/<name>` to every project it belongs to, in list order. */
  byRepositoryId: Map<string, ProjectRef[]>;
}

function refOf(project: ProjectRecord): ProjectRef {
  return {
    id: project.id,
    name: project.name,
    hostIds: [...new Set(project.sources.map((source) => source.hostId))],
  };
}

/**
 * `remotesOf(path)` answers the repository ids of every remote of the checkout
 * at `path` on the server's machine, or nothing for a path that is not a
 * checkout; it is only asked about sources on `localHostId`, the server's own
 * machine, because it cannot see another machine's disk.
 */
export async function buildProjectIndex(
  projects: readonly ProjectRecord[],
  localHostId: string | null,
  remotesOf: (path: string) => Promise<string[]>,
): Promise<ProjectIndex> {
  const standard = projects.filter((project) => project.kind !== "personal");
  const byRepositoryId = new Map<string, ProjectRef[]>();
  const add = (repositoryId: string, project: ProjectRecord) => {
    const list = byRepositoryId.get(repositoryId) ?? [];
    if (!list.some((entry) => entry.id === project.id)) list.push(refOf(project));
    byRepositoryId.set(repositoryId, list);
  };

  for (const project of standard) {
    const origin = project.gitRemoteUrl === null ? null : normalizeRemoteUrl(project.gitRemoteUrl);
    if (origin !== null) add(origin, project);
  }
  const claimedByOrigin = new Set(byRepositoryId.keys());

  if (localHostId !== null) {
    const scanned = await Promise.all(
      standard.flatMap((project) =>
        project.sources
          .filter((source) => source.hostId === localHostId)
          .map(async (source) => ({ project, remotes: await remotesOf(source.path) })),
      ),
    );
    for (const { project, remotes } of scanned) {
      for (const repositoryId of remotes) {
        if (!claimedByOrigin.has(repositoryId)) add(repositoryId, project);
      }
    }
  }

  return { byRepositoryId };
}

/** The candidate with a checkout on the server's machine, or else the first. */
export function preferredProject(
  candidates: readonly ProjectRef[],
  localHostId: string | null,
): ProjectRef | null {
  if (localHostId !== null) {
    const local = candidates.find((candidate) => candidate.hostIds.includes(localHostId));
    if (local !== undefined) return local;
  }
  return candidates[0] ?? null;
}
