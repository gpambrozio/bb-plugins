/**
 * The board's queries against a fake `GitHubApi` that answers by what each
 * document asks for and records every request, so the invariants the board
 * depends on — how many requests a refresh costs, which failures blank what —
 * are pinned without a network.
 */
import { describe, expect, it } from "vitest";

import type { BoardItem } from "../shared/board";
import {
  BRANCH_UPDATE_SETTLE_MS,
  CHECKS_QUERY,
  UPDATED_BRANCH,
  UPDATE_BRANCH_MUTATION,
  fetchComments,
  fetchItemDetails,
  foldChecks,
  loadColumns,
  mergeItems,
  multiSearchQuery,
  resolveViewerLogin,
  settleBranches,
  splitRepository,
  toggleLabel,
  updateBranch,
  type GitHubApi,
  type GraphQLVariables,
} from "./github";

interface Request {
  query: string;
  variables: GraphQLVariables;
}

type Route = (request: Request) => unknown;

function fakeApi(route: Route): GitHubApi & { requests: Request[]; warnings: string[] } {
  const requests: Request[] = [];
  const warnings: string[] = [];
  return {
    requests,
    warnings,
    graphql: async (query, variables = {}) => {
      const request = { query, variables };
      requests.push(request);
      return route(request);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
}

const isIssueSearch = (r: Request) => r.query.includes("... on Issue {") && r.query.includes("search(");
const isPullSearch = (r: Request) => r.query.includes("... on PullRequest {") && r.query.includes("search(");
const isDiscussionSearch = (r: Request) => r.query.includes("type: DISCUSSION");
const isChecks = (r: Request) => r.query === CHECKS_QUERY;
const isBranchStatus = (r: Request) => r.query.includes("compare(headRef:");

function issueNode(id: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    title: `Title ${id}`,
    url: `https://github.com/o/r/issues/${id}`,
    updatedAt,
    author: { login: "someone" },
    comments: { totalCount: 2 },
    labels: { nodes: [{ name: "bug" }] },
    repository: { nameWithOwner: "o/r", isArchived: false },
    ...extra,
  };
}

function pullNode(id: string, updatedAt: string, isDraft: boolean) {
  return {
    ...issueNode(id, updatedAt),
    isDraft,
    headRefOid: `sha-${id}`,
    closingIssuesReferences: { nodes: [{ id: "I1", number: 1, repository: { nameWithOwner: "o/r" } }] },
  };
}

/** A GitHub that has one issue, one draft and one open pull request, and one discussion. */
function happyRoute(overrides: Partial<Record<"checks" | "branch" | "discussions", Route>> = {}): Route {
  return (request) => {
    if (isIssueSearch(request)) {
      return {
        mine: { nodes: [issueNode("I1", "2026-09-01T00:00:00Z")] },
        owned: { nodes: [issueNode("I1", "2026-09-01T00:00:00Z")] },
        assigned: { nodes: [] },
      };
    }
    if (isPullSearch(request)) {
      return {
        mine: { nodes: [pullNode("P1", "2026-09-03T00:00:00Z", true)] },
        owned: { nodes: [pullNode("P2", "2026-09-02T00:00:00Z", false), {}] },
        assigned: { nodes: [] },
      };
    }
    if (isDiscussionSearch(request)) {
      if (overrides.discussions) return overrides.discussions(request);
      return {
        mine: { nodes: [issueNode("D1", "2026-09-01T00:00:00Z", { category: { name: "Ideas" } })] },
        owned: {
          nodes: [
            issueNode("D2", "2026-09-05T00:00:00Z", {
              repository: { nameWithOwner: "o/old", isArchived: true },
            }),
          ],
        },
      };
    }
    if (isChecks(request)) {
      if (overrides.checks) return overrides.checks(request);
      return {
        nodes: [
          {
            id: "P2",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      };
    }
    if (isBranchStatus(request)) {
      if (overrides.branch) return overrides.branch(request);
      return {
        pr0: { mergeable: "MERGEABLE", viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: 1 } } },
        pr1: { mergeable: "CONFLICTING", viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: 4 } } },
      };
    }
    throw new Error(`unexpected request: ${request.query.slice(0, 60)}`);
  };
}

describe("loadColumns", () => {
  it("costs three searches, a checks request and a branch-status request", async () => {
    const api = fakeApi(happyRoute());
    await loadColumns(api, "octocat", 30);
    expect(api.requests.filter(isIssueSearch)).toHaveLength(1);
    expect(api.requests.filter(isPullSearch)).toHaveLength(1);
    expect(api.requests.filter(isDiscussionSearch)).toHaveLength(1);
    expect(api.requests.filter(isChecks)).toHaveLength(1);
    expect(api.requests.filter(isBranchStatus)).toHaveLength(1);
    expect(api.requests).toHaveLength(5);
  });

  it("aliases author, user and assignee into one search, with the concrete login", async () => {
    const api = fakeApi(happyRoute());
    await loadColumns(api, "octocat", 30);
    const issues = api.requests.find(isIssueSearch);
    expect(issues?.query).toContain("labels(first: 100)");
    expect(api.requests.find(isPullSearch)?.query).toContain("labels(first: 100)");
    expect(issues?.variables).toMatchObject({
      mine: expect.stringContaining("author:octocat"),
      owned: expect.stringContaining("user:octocat"),
      assigned: expect.stringContaining("assignee:octocat"),
      limit: 30,
    });
    expect(String(issues?.variables.mine)).toContain("archived:false");
    const discussions = api.requests.find(isDiscussionSearch);
    expect(Object.keys(discussions?.variables ?? {}).sort()).toEqual(["limit", "mine", "owned"]);
  });

  it("dedupes, splits drafts from open pull requests and attaches pills", async () => {
    const api = fakeApi(happyRoute());
    const columns = await loadColumns(api, "octocat", 30);
    expect(columns.map((column) => column.id)).toEqual(["issues", "draft-prs", "open-prs", "discussions"]);
    const [issues, drafts, open, discussions] = columns;
    expect(issues?.items.map((item) => item.id)).toEqual(["I1"]);
    expect(drafts?.items.map((item) => item.id)).toEqual(["P1"]);
    expect(open?.items.map((item) => item.id)).toEqual(["P2"]);
    // Checks are asked for the open pull request only; drafts carry none.
    expect(api.requests.find(isChecks)?.variables).toEqual({ ids: ["P2"] });
    expect(drafts?.items[0]?.checks).toBeNull();
    expect(open?.items[0]?.checks).toEqual({ passed: 1, failed: 0, pending: 0 });
    // Branch status covers drafts and open alike, compared by head SHA.
    expect(api.requests.find(isBranchStatus)?.variables).toEqual({
      id0: "P1",
      head0: "sha-P1",
      id1: "P2",
      head1: "sha-P2",
    });
    expect(drafts?.items[0]?.branch).toEqual({ behindBy: 1, canUpdate: true, conflicts: false });
    expect(open?.items[0]?.branch).toEqual({ behindBy: 4, canUpdate: false, conflicts: true });
    expect(open?.items[0]?.linkedIssues).toEqual([{ id: "I1", number: 1, repository: "o/r" }]);
    // The archived repository's discussion is dropped; the category is the detail.
    expect(discussions?.items.map((item) => [item.id, item.detail])).toEqual([["D1", "Ideas"]]);
  });

  it("loses only the pills when the checks request fails", async () => {
    const api = fakeApi(
      happyRoute({
        checks: () => {
          throw new Error("Resource not accessible by integration");
        },
      }),
    );
    const columns = await loadColumns(api, "octocat", 30);
    expect(columns.every((column) => column.error === null)).toBe(true);
    expect(columns[2]?.items[0]?.checks).toBeNull();
    expect(columns[2]?.items[0]?.branch).not.toBeNull();
    expect(api.warnings).toEqual([expect.stringContaining("checks unavailable")]);
  });

  it("loses only the branch pills when the branch-status request fails", async () => {
    const api = fakeApi(
      happyRoute({
        branch: () => {
          throw new Error("Could not resolve");
        },
      }),
    );
    const columns = await loadColumns(api, "octocat", 30);
    expect(columns.every((column) => column.error === null)).toBe(true);
    expect(columns[1]?.items[0]?.branch).toBeNull();
    expect(columns[2]?.items[0]?.checks).not.toBeNull();
    expect(api.warnings).toEqual([expect.stringContaining("branch status unavailable")]);
  });

  it("gives a failed search its own column error and leaves the others loaded", async () => {
    const api = fakeApi(
      happyRoute({
        discussions: () => {
          throw new Error("missing read:discussion scope");
        },
      }),
    );
    const columns = await loadColumns(api, "octocat", 30);
    expect(columns[3]).toMatchObject({ items: [], error: "missing read:discussion scope" });
    expect(columns.slice(0, 3).every((column) => column.error === null && column.items.length > 0)).toBe(true);
  });

  it("fails both pull request columns together, since they share a search", async () => {
    const api = fakeApi((request) => {
      if (isPullSearch(request)) throw new Error("rate limited");
      return happyRoute()(request);
    });
    const columns = await loadColumns(api, "octocat", 30);
    expect(columns[1]?.error).toBe("rate limited");
    expect(columns[2]?.error).toBe("rate limited");
    expect(columns[0]?.error).toBeNull();
    expect(api.requests.some(isChecks)).toBe(false);
  });
});

describe("mergeItems", () => {
  const item = (id: string, updatedAt: string) => ({ id, updatedAt }) as BoardItem;

  it("keeps the first of each id, newest first, cut to the limit", () => {
    const merged = mergeItems(
      [item("a", "2026-01-01"), item("b", "2026-03-01"), item("a", "2026-09-09"), item("c", "2026-02-01")],
      2,
    );
    expect(merged.map((entry) => [entry.id, entry.updatedAt])).toEqual([
      ["b", "2026-03-01"],
      ["c", "2026-02-01"],
    ]);
  });
});

describe("multiSearchQuery", () => {
  it("declares a variable for every alias and one shared limit", () => {
    const { text, aliases } = multiSearchQuery("ISSUE", "id", ["mine", "owned"] as const);
    expect(aliases).toEqual(["mine", "owned"]);
    expect(text).toContain("query($mine: String!, $owned: String!, $limit: Int!)");
    expect(text).toContain("mine: search(query: $mine, type: ISSUE, first: $limit)");
    expect(text).toContain("owned: search(query: $owned, type: ISSUE, first: $limit)");
  });
});

describe("foldChecks", () => {
  it("counts a re-run once, by its newest attempt", () => {
    expect(
      foldChecks([
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 1 } } },
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { workflowRun: { databaseId: 2 } } },
      ]),
    ).toEqual({ passed: 1, failed: 0, pending: 0 });
  });

  it("reads commit statuses and treats startup failures as failed and stale runs as nothing", () => {
    expect(
      foldChecks([
        { __typename: "StatusContext", context: "deploy", state: "PENDING" },
        { __typename: "StatusContext", context: "lint", state: "ERROR" },
        { __typename: "CheckRun", name: "boot", status: "COMPLETED", conclusion: "STARTUP_FAILURE" },
        { __typename: "CheckRun", name: "old", status: "COMPLETED", conclusion: "STALE" },
        { __typename: "CheckRun", name: "run", status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toEqual({ passed: 0, failed: 2, pending: 2 });
  });

  it("is null when nothing counted", () => {
    expect(foldChecks([])).toBeNull();
    expect(
      foldChecks([{ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }]),
    ).toBeNull();
  });
});

describe("settleBranches", () => {
  const board = () => [
    {
      id: "open-prs" as const,
      title: "Open PRs",
      error: null,
      items: [{ id: "P1", branch: { behindBy: 3, canUpdate: true, conflicts: false } } as BoardItem],
    },
  ];

  it("keeps a just-updated branch up to date over a comparison that predates it", () => {
    const recent = new Map([["P1", 1_000]]);
    const [column] = settleBranches(board(), recent, 1_000 + BRANCH_UPDATE_SETTLE_MS - 1);
    expect(column?.items[0]?.branch).toEqual(UPDATED_BRANCH);
    expect(recent.has("P1")).toBe(true);
  });

  it("believes the comparison again once the window has passed", () => {
    const recent = new Map([["P1", 1_000]]);
    const [column] = settleBranches(board(), recent, 1_000 + BRANCH_UPDATE_SETTLE_MS);
    expect(column?.items[0]?.branch).toEqual({ behindBy: 3, canUpdate: true, conflicts: false });
    expect(recent.has("P1")).toBe(false);
  });
});

describe("updateBranch", () => {
  const lookThen = (status: unknown, onMutation?: () => unknown): Route => (request) => {
    if (request.query.includes("headRefOid")) return { node: { headRefOid: "sha" } };
    if (isBranchStatus(request)) return { pr0: status };
    if (request.query === UPDATE_BRANCH_MUTATION) return onMutation?.() ?? { updatePullRequestBranch: {} };
    throw new Error("unexpected");
  };

  it("looks again first, and sends nothing when the branch now conflicts", async () => {
    const api = fakeApi(
      lookThen({ mergeable: "CONFLICTING", viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: 2 } } }),
    );
    const result = await updateBranch(api, "P1");
    expect(result).toEqual({ updated: false, branch: { behindBy: 2, canUpdate: false, conflicts: true } });
    expect(api.requests.some((request) => request.query === UPDATE_BRANCH_MUTATION)).toBe(false);
  });

  it("merges when the look says it can, and answers up to date", async () => {
    const api = fakeApi(
      lookThen({ mergeable: "MERGEABLE", viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: 2 } } }),
    );
    expect(await updateBranch(api, "P1")).toEqual({ updated: true, branch: UPDATED_BRANCH });
    expect(api.requests.at(-1)).toEqual({ query: UPDATE_BRANCH_MUTATION, variables: { id: "P1" } });
  });

  it("merges for a writer where the repository does not suggest updating", async () => {
    const api = fakeApi(
      lookThen({
        mergeable: "MERGEABLE",
        viewerCanUpdateBranch: false,
        repository: { viewerPermission: "WRITE" },
        baseRef: { compare: { behindBy: 1 } },
      }),
    );
    expect(await updateBranch(api, "P1")).toEqual({ updated: true, branch: UPDATED_BRANCH });
  });

  it("sends nothing for a reader, however far behind", async () => {
    const api = fakeApi(
      lookThen({
        mergeable: "MERGEABLE",
        viewerCanUpdateBranch: false,
        repository: { viewerPermission: "READ" },
        baseRef: { compare: { behindBy: 5 } },
      }),
    );
    expect((await updateBranch(api, "P1")).updated).toBe(false);
    expect(api.requests.some((request) => request.query === UPDATE_BRANCH_MUTATION)).toBe(false);
  });

  it("lets the mutation answer for itself when the look fails", async () => {
    const api = fakeApi((request) => {
      if (request.query.includes("headRefOid")) throw new Error("timeout");
      if (request.query === UPDATE_BRANCH_MUTATION) return {};
      throw new Error("unexpected");
    });
    expect((await updateBranch(api, "P1")).updated).toBe(true);
    expect(api.warnings).toHaveLength(1);
  });
});

describe("the other requests", () => {
  it("resolves @me to a concrete login", async () => {
    const api = fakeApi(() => ({ viewer: { login: "octocat" } }));
    expect(await resolveViewerLogin(api)).toBe("octocat");
    await expect(resolveViewerLogin(fakeApi(() => ({ viewer: {} })))).rejects.toThrow(/login/);
  });

  it("answers a label toggle with GitHub's labels after the change", async () => {
    const api = fakeApi(() => ({
      removeLabelsFromLabelable: { labelable: { labels: { nodes: [{ name: "keep" }] } } },
    }));
    expect(await toggleLabel(api, "I1", "L1", false)).toEqual(["keep"]);
    expect(api.requests[0]?.query).toContain("removeLabelsFromLabelable");
    expect(api.requests[0]?.variables).toEqual({ item: "I1", label: "L1" });
  });

  it("reads an item's labels a full page at a time, 21 and more", async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `label-${index}` }));
    const api = fakeApi(() => ({ addLabelsToLabelable: { labelable: { labels: { nodes: many } } } }));
    expect(await toggleLabel(api, "I1", "L1", true)).toHaveLength(21);
    expect(api.requests[0]?.query).toContain("labels(first: 100)");
    expect(api.requests[0]?.query).not.toContain("labels(first: 20)");
  });

  it("derives an item's state rather than copying it", async () => {
    const answer = (node: unknown) => fakeApi(() => ({ node }));
    expect((await fetchItemDetails(answer({ state: "OPEN", isDraft: true }), "x")).state).toBe("draft");
    expect((await fetchItemDetails(answer({ state: "MERGED" }), "x")).state).toBe("merged");
    expect((await fetchItemDetails(answer({ closed: true }), "x")).state).toBe("closed");
    await expect(fetchItemDetails(answer(null), "x")).rejects.toThrow(/no longer has this item/);
  });

  it("flattens discussion replies one level deep and says when a page was full", async () => {
    const api = fakeApi(() => ({
      node: {
        comments: {
          totalCount: 1,
          nodes: [
            {
              id: "C1",
              body: "top",
              author: { login: "a" },
              replies: { totalCount: 21, nodes: [{ id: "R1", body: "reply", author: null }] },
            },
          ],
        },
      },
    }));
    const { comments, truncated } = await fetchComments(api, "D1");
    expect(comments.map((comment) => [comment.id, comment.depth, comment.author])).toEqual([
      ["C1", 0, "a"],
      ["R1", 1, null],
    ]);
    expect(truncated).toBe(true);
  });

  it("takes repositories as owner/name only", () => {
    expect(splitRepository("o/r")).toEqual({ owner: "o", name: "r" });
    expect(() => splitRepository("o/r/x")).toThrow();
    expect(() => splitRepository("o")).toThrow();
  });
});
