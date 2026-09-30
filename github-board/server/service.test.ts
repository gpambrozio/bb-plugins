/**
 * The board service's own rules — what it caches, for how long, and what an
 * edit does to the cache — against a fake GitHub that answers every search
 * with nothing unless told otherwise.
 */
import { describe, expect, it } from "vitest";

import { CHECKS_QUERY, UPDATE_BRANCH_MUTATION, type GitHubApi, type GraphQLVariables } from "./github";
import { createBoardService, CACHE_TTL_MS, type BoardServiceDeps } from "./service";

interface Request {
  query: string;
  variables: GraphQLVariables;
}

const EMPTY_SEARCH = { mine: { nodes: [] }, owned: { nodes: [] }, assigned: { nodes: [] } };

function pullRequest(id: string) {
  return {
    id,
    number: 7,
    title: "PR",
    url: "https://github.com/o/r/pull/7",
    updatedAt: "2026-09-01T00:00:00Z",
    isDraft: false,
    headRefOid: "sha",
    repository: { nameWithOwner: "o/r" },
  };
}

function setup(options: { route?: (request: Request) => unknown; login?: string } = {}) {
  const requests: Request[] = [];
  let clock = 1_000_000;
  const api: GitHubApi = {
    graphql: async (query, variables = {}) => {
      requests.push({ query, variables });
      const routed = options.route?.({ query, variables });
      if (routed !== undefined) return routed;
      if (query.includes("viewer")) return { viewer: { login: "octocat" } };
      if (query.includes("search(")) return EMPTY_SEARCH;
      return {};
    },
    warn: () => {},
  };
  const deps: BoardServiceDeps = {
    api,
    token: async () => "token",
    configuredLogin: async () => options.login ?? "",
    projectIndex: async () => ({
      byRepositoryId: new Map([["github.com/o/r", [{ id: "proj", name: "r", hostIds: ["local"] }]]]),
    }),
    localHostId: async () => "local",
    now: () => clock,
  };
  return {
    service: createBoardService(deps),
    requests,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const searches = (requests: Request[]) => requests.filter((request) => request.query.includes("search("));

describe("loadBoard", () => {
  it("resolves the login from gh when none is set, and uses the setting when it is", async () => {
    const unset = setup();
    expect((await unset.service.loadBoard({ limit: 30, force: false })).login).toBe("octocat");
    const pinned = setup({ login: "hubot" });
    expect((await pinned.service.loadBoard({ limit: 30, force: false })).login).toBe("hubot");
    expect(pinned.requests.some((request) => request.query.includes("viewer"))).toBe(false);
    expect(searches(pinned.requests)[0]?.variables.mine).toContain("author:hubot");
  });

  it("serves a board from cache for five minutes, and refetches on force or after", async () => {
    const { service, requests, advance } = setup();
    await service.loadBoard({ limit: 30, force: false });
    await service.loadBoard({ limit: 30, force: false });
    expect(searches(requests)).toHaveLength(3);
    await service.loadBoard({ limit: 30, force: true });
    expect(searches(requests)).toHaveLength(6);
    advance(CACHE_TTL_MS);
    await service.loadBoard({ limit: 30, force: false });
    expect(searches(requests)).toHaveLength(9);
  });

  it("does not cache a board with a failed column", async () => {
    let failing = true;
    const { service, requests } = setup({
      route: (request) => {
        if (failing && request.query.includes("type: DISCUSSION")) throw new Error("no scope");
        return undefined;
      },
    });
    const first = await service.loadBoard({ limit: 30, force: false });
    expect(first.columns.find((column) => column.id === "discussions")?.error).toBe("no scope");
    failing = false;
    await service.loadBoard({ limit: 30, force: false });
    expect(searches(requests)).toHaveLength(6);
  });

  it("names the project each repository on the board opens on", async () => {
    const { service } = setup({
      route: (request) =>
        request.query.includes("... on PullRequest {") && request.query.includes("search(")
          ? { mine: { nodes: [pullRequest("P1")] }, owned: { nodes: [] }, assigned: { nodes: [] } }
          : undefined,
    });
    const board = await service.loadBoard({ limit: 30, force: false });
    expect(board.repositoryProjects).toEqual({ "o/r": "proj" });
  });
});

describe("edits", () => {
  it("patches the cached board with the labels GitHub answered", async () => {
    const { service } = setup({
      route: (request) => {
        if (request.query.includes("... on PullRequest {") && request.query.includes("search(")) {
          return { mine: { nodes: [pullRequest("P1")] }, owned: { nodes: [] }, assigned: { nodes: [] } };
        }
        if (request.query.includes("addLabelsToLabelable")) {
          return { addLabelsToLabelable: { labelable: { labels: { nodes: [{ name: "bug" }] } } } };
        }
        return undefined;
      },
    });
    await service.loadBoard({ limit: 30, force: false });
    await service.toggleLabel({ itemId: "P1", labelId: "L", add: true });
    const cached = await service.loadBoard({ limit: 30, force: false });
    expect(cached.columns.find((column) => column.id === "open-prs")?.items[0]?.labels).toEqual(["bug"]);
  });

  it("keeps an updated branch up to date over a refresh that still sees it behind", async () => {
    const behind = { mergeable: "MERGEABLE", viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: 3 } } };
    const { service, advance } = setup({
      route: (request) => {
        if (request.query.includes("... on PullRequest {") && request.query.includes("search(")) {
          return { mine: { nodes: [pullRequest("P1")] }, owned: { nodes: [] }, assigned: { nodes: [] } };
        }
        if (request.query === CHECKS_QUERY) return { nodes: [] };
        if (request.query.includes("compare(headRef:")) return { pr0: behind };
        if (request.query.includes("headRefOid")) return { node: { headRefOid: "sha" } };
        if (request.query === UPDATE_BRANCH_MUTATION) return {};
        return undefined;
      },
    });
    const branchOf = async (force: boolean) =>
      (await service.loadBoard({ limit: 30, force })).columns.find((c) => c.id === "open-prs")?.items[0]?.branch;
    expect((await branchOf(false))?.behindBy).toBe(3);
    expect((await service.updateBranch({ id: "P1" })).updated).toBe(true);
    expect((await branchOf(true))?.behindBy).toBe(0);
    advance(2 * 60_000);
    expect((await branchOf(true))?.behindBy).toBe(3);
  });
});

describe("projectsForCard", () => {
  it("answers the preferred project first, and none for an unmatched repository", async () => {
    const { service } = setup();
    const matched = await service.projectsForCard({ repository: "o/r", url: "https://github.com/o/r/issues/1" });
    expect(matched.project?.id).toBe("proj");
    const unmatched = await service.projectsForCard({ repository: "x/y", url: "https://github.com/x/y/issues/1" });
    expect(unmatched).toEqual({ project: null, candidates: [] });
  });
});
