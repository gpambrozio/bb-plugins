/**
 * What the RPC handlers do, with the state they share: the board, label,
 * detail, comment and image caches, the viewer's login, the project index, and
 * the branches updated from here. One instance per plugin load; a reload
 * starts clean.
 *
 * Everything outside — GitHub, the token, the login setting, bb's projects,
 * the clock — comes in through `BoardServiceDeps`, so the tests drive it with
 * fakes.
 */
import type {
  Board,
  BoardColumn,
  BoardItem,
  BranchStatus,
  ItemComment,
  ItemDetails,
  RepositoryLabel,
} from "../shared/board";
import { repositoryIdFor } from "../shared/launch";
import {
  fetchComments,
  fetchItemDetails,
  fetchRepositoryLabels,
  loadColumns,
  resolveViewerLogin,
  settleBranches,
  settleLabels,
  toggleLabel,
  updateBranch,
  type GitHubApi,
} from "./github";
import { fetchGitHubImage } from "./image";
import { preferredProject, type ProjectIndex, type ProjectRef } from "./projects";

export interface BoardServiceDeps {
  api: GitHubApi;
  /** The token for an image on github.com; aborted with the image fetch. */
  token(signal: AbortSignal): Promise<string>;
  /** The login setting, blank when the user has not pinned one. */
  configuredLogin(): Promise<string>;
  /** bb's projects matched to repositories; `force` rebuilds a cached index. */
  projectIndex(force: boolean): Promise<ProjectIndex>;
  /** The server's own machine, which the send dialog prefers a project on. */
  localHostId(): Promise<string | null>;
  now(): number;
}

/** The board, labels, bodies, comments and the token are all remembered this long. */
export const CACHE_TTL_MS = 5 * 60_000;

/** The viewer's login changes only with a `gh auth` switch; an hour is plenty. */
const LOGIN_TTL_MS = 60 * 60_000;

/** A handful of images, by URL, so scrolling back through a thread does not fetch one twice. */
const IMAGE_CACHE_ENTRIES = 24;

interface Stamped<T> {
  value: T;
  storedAt: number;
}

export type BoardService = ReturnType<typeof createBoardService>;

export function createBoardService(deps: BoardServiceDeps) {
  const fresh = <T>(entry: Stamped<T> | undefined | null): entry is Stamped<T> =>
    entry != null && deps.now() - entry.storedAt < CACHE_TTL_MS;

  let viewer: { login: string; storedAt: number } | null = null;
  let cachedBoard: (Stamped<{ columns: BoardColumn[]; fetchedAt: string }> & { key: string }) | null =
    null;
  const cachedLabels = new Map<string, Stamped<RepositoryLabel[]>>();
  const cachedDetails = new Map<string, Stamped<ItemDetails>>();
  const cachedComments = new Map<string, Stamped<{ comments: ItemComment[]; truncated: boolean }>>();
  const cachedImages = new Map<string, string>();
  let cachedToken: Stamped<string> | null = null;
  /** When each pull request's branch was last updated from here; see `settleBranches`. */
  const recentBranchUpdates = new Map<string, number>();
  /** The labels each item was last given from here; see `settleLabels`. */
  const recentLabels = new Map<string, { labels: string[]; at: number }>();

  /**
   * `@me` is never sent to a search: the login setting when there is one,
   * otherwise the account `gh` is signed in as.
   */
  async function resolveLogin(): Promise<string> {
    const configured = (await deps.configuredLogin()).trim();
    if (configured !== "" && configured !== "@me") return configured;
    if (viewer !== null && deps.now() - viewer.storedAt < LOGIN_TTL_MS) return viewer.login;
    const login = await resolveViewerLogin(deps.api);
    viewer = { login, storedAt: deps.now() };
    return login;
  }

  /**
   * A miss is retried against a freshly built index, so a project added moments
   * ago is found instead of being denied for the rest of the cache window.
   */
  async function projectsFor(repository: string, url: string): Promise<ProjectRef[]> {
    const repositoryId = repositoryIdFor(repository, url);
    if (repositoryId === null) return [];
    const cached = (await deps.projectIndex(false)).byRepositoryId.get(repositoryId);
    if (cached !== undefined) return cached;
    return (await deps.projectIndex(true)).byRepositoryId.get(repositoryId) ?? [];
  }

  /** `owner/name` to the project a card opens on, for the repositories on this board only. */
  async function repositoryProjects(columns: readonly BoardColumn[]): Promise<Record<string, string>> {
    const [index, localHostId] = await Promise.all([deps.projectIndex(false), deps.localHostId()]);
    const result: Record<string, string> = {};
    for (const column of columns) {
      for (const item of column.items) {
        if (item.repository === "" || result[item.repository] !== undefined) continue;
        const repositoryId = repositoryIdFor(item.repository, item.url);
        if (repositoryId === null) continue;
        const project = preferredProject(index.byRepositoryId.get(repositoryId) ?? [], localHostId);
        if (project !== null) result[item.repository] = project.id;
      }
    }
    return result;
  }

  /**
   * Keeps the cached board honest after an edit: without it, a label changed or
   * a branch updated now would be undone by the next cache hit.
   */
  function patchCachedItem(itemId: string, patch: Partial<BoardItem>): void {
    if (cachedBoard === null) return;
    cachedBoard = {
      ...cachedBoard,
      value: {
        ...cachedBoard.value,
        columns: cachedBoard.value.columns.map((column) => ({
          ...column,
          items: column.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
        })),
      },
    };
  }

  async function token(signal: AbortSignal): Promise<string> {
    if (fresh(cachedToken)) return cachedToken.value;
    const value = await deps.token(signal);
    cachedToken = { value, storedAt: deps.now() };
    return value;
  }

  return {
    async loadBoard({ limit, force }: { limit: number; force: boolean }): Promise<Board> {
      const login = await resolveLogin();
      const key = `${login}\u0000${limit}`;
      if (!force && fresh(cachedBoard) && cachedBoard.key === key) {
        const { columns, fetchedAt } = cachedBoard.value;
        return { login, columns, fetchedAt, repositoryProjects: await repositoryProjects(columns) };
      }

      // Settled after every request has returned, so an update that landed
      // while they ran wins over what they saw.
      const loaded = await loadColumns(deps.api, login, limit);
      const now = deps.now();
      const columns = settleLabels(settleBranches(loaded, recentBranchUpdates, now), recentLabels, now);
      const fetchedAt = new Date(deps.now()).toISOString();

      // A column that failed is not worth remembering: caching it would keep
      // the error on screen for the whole window though a retry might succeed.
      if (columns.every((column) => column.error === null)) {
        cachedBoard = { key, value: { columns, fetchedAt }, storedAt: deps.now() };
      }
      return { login, columns, fetchedAt, repositoryProjects: await repositoryProjects(columns) };
    },

    async loadItem({ id, force }: { id: string; force: boolean }): Promise<ItemDetails> {
      const hit = cachedDetails.get(id);
      if (!force && fresh(hit)) return hit.value;
      const value = await fetchItemDetails(deps.api, id);
      cachedDetails.set(id, { value, storedAt: deps.now() });
      return value;
    },

    async loadComments({
      id,
      force,
    }: {
      id: string;
      force: boolean;
    }): Promise<{ comments: ItemComment[]; truncated: boolean }> {
      const hit = cachedComments.get(id);
      if (!force && fresh(hit)) return hit.value;
      const value = await fetchComments(deps.api, id);
      cachedComments.set(id, { value, storedAt: deps.now() });
      return value;
    },

    async loadImage({ url }: { url: string }): Promise<{ dataUrl: string }> {
      const hit = cachedImages.get(url);
      if (hit !== undefined) return { dataUrl: hit };
      const dataUrl = await fetchGitHubImage(url, token);
      cachedImages.set(url, dataUrl);
      if (cachedImages.size > IMAGE_CACHE_ENTRIES) {
        const oldest = cachedImages.keys().next().value;
        if (oldest !== undefined) cachedImages.delete(oldest);
      }
      return { dataUrl };
    },

    async listLabels({ repository }: { repository: string }): Promise<{ labels: RepositoryLabel[] }> {
      const hit = cachedLabels.get(repository);
      if (fresh(hit)) return { labels: hit.value };
      const labels = await fetchRepositoryLabels(deps.api, repository);
      cachedLabels.set(repository, { value: labels, storedAt: deps.now() });
      return { labels };
    },

    async toggleLabel({
      itemId,
      labelId,
      add,
    }: {
      itemId: string;
      labelId: string;
      add: boolean;
    }): Promise<{ labels: string[] }> {
      const labels = await toggleLabel(deps.api, itemId, labelId, add);
      recentLabels.set(itemId, { labels, at: deps.now() });
      patchCachedItem(itemId, { labels });
      return { labels };
    },

    async updateBranch({ id }: { id: string }): Promise<{ updated: boolean; branch: BranchStatus }> {
      const result = await updateBranch(deps.api, id);
      if (result.updated) recentBranchUpdates.set(id, deps.now());
      patchCachedItem(id, { branch: result.branch });
      return result;
    },

    /** Every project the card's repository reaches, the preferred one first. */
    async projectsForCard({
      repository,
      url,
    }: {
      repository: string;
      url: string;
    }): Promise<{ project: ProjectRef | null; candidates: ProjectRef[] }> {
      const [candidates, localHostId] = await Promise.all([
        projectsFor(repository, url),
        deps.localHostId(),
      ]);
      const project = preferredProject(candidates, localHostId);
      return {
        project,
        candidates: project === null ? candidates : [project, ...candidates.filter((c) => c.id !== project.id)],
      };
    },
  };
}
