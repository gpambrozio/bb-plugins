/**
 * Every GitHub query the board makes, and how each answer is read.
 *
 * Nothing here knows how a request reaches GitHub: every function takes a
 * `GitHubApi`, whose `graphql` is `gh api graphql` today and could be a plain
 * HTTPS call with a token tomorrow. What the functions depend on is the one
 * behaviour both share — **any GraphQL error rejects the whole request** — and
 * several invariants below are built on it.
 */
import type {
  BoardColumn,
  BoardItem,
  BranchStatus,
  CheckSummary,
  ItemComment,
  ItemDetails,
  LinkedIssue,
  RepositoryLabel,
} from "../shared/board";

/** A GraphQL variable as the board uses them: strings, integers and lists of ids. */
export type GraphQLVariable = string | number | readonly string[];

export type GraphQLVariables = Readonly<Record<string, GraphQLVariable>>;

export interface GitHubApi {
  /**
   * Runs one GraphQL document and answers its `data`. Rejects on a transport
   * failure *and* on any entry in `errors`, the way `gh api graphql` exits
   * non-zero — which is why checks and branch status are requests of their own.
   */
  graphql(query: string, variables?: GraphQLVariables): Promise<unknown>;
  /** Where a failure that costs only pills goes, rather than being dropped. */
  warn(message: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dataRecord(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

/**
 * `@me` resolves differently per search type and is opaque in the UI, so every
 * query runs against a concrete login instead.
 */
export async function resolveViewerLogin(api: GitHubApi): Promise<string> {
  const data = await api.graphql("{ viewer { login } }");
  const login = (data as { viewer?: { login?: unknown } } | undefined)?.viewer?.login;
  if (typeof login !== "string" || login === "") {
    throw new Error("GitHub did not return a login for the authenticated account.");
  }
  return login;
}

interface GhSearchNode {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  author?: { login?: unknown };
  comments?: { totalCount?: unknown };
  labels?: { nodes?: unknown };
  repository?: { nameWithOwner?: unknown; isArchived?: unknown };
}

function toItem(node: GhSearchNode, detail: string | null): BoardItem {
  const labelNodes = node.labels?.nodes;
  const labels = Array.isArray(labelNodes)
    ? labelNodes
        .map((label) => (label as { name?: unknown }).name)
        .filter((name): name is string => typeof name === "string")
    : [];
  const comments = node.comments?.totalCount;
  return {
    id: typeof node.id === "string" ? node.id : String(node.url),
    number: typeof node.number === "number" ? node.number : 0,
    title: typeof node.title === "string" ? node.title : "",
    url: typeof node.url === "string" ? node.url : "",
    repository:
      typeof node.repository?.nameWithOwner === "string" ? node.repository.nameWithOwner : "",
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    commentsCount: typeof comments === "number" ? comments : 0,
    labels,
    // Null rather than empty for a deleted account, which GitHub returns as no
    // author at all; the card shows nothing instead of an authorless byline.
    author: typeof node.author?.login === "string" ? node.author.login : null,
    detail,
    // Only pull requests link issues; every other caller keeps the empty list.
    linkedIssues: [],
    // Filled for open pull requests only, by fetchChecks; see attachChecks.
    checks: null,
    // Filled for draft and open pull requests, by fetchBranchStatuses.
    branch: null,
  };
}

/**
 * An archived repository is read-only, so its open issues and pull requests can
 * never be closed and sit on the board forever. The qualifier filters them out
 * server-side; discussions have no such qualifier and are filtered on the
 * response.
 */
const UNARCHIVED_ONLY = "archived:false";

/**
 * A built search document together with the aliases it declares variables for,
 * so `multiSearch` can only be handed a query set that matches the document it
 * is about to run.
 */
export interface SearchDocument<Alias extends string> {
  text: string;
  aliases: readonly Alias[];
}

/**
 * Every column is the union of several searches, one per alias: `mine` is what
 * this login authored, anywhere; `owned` is everything in the repositories this
 * login owns, whoever opened it; and `assigned` is what somebody else opened
 * anywhere and put on this login's plate. The last two are what put other
 * people's work on the board — an issue filed on your own repository, or handed
 * to you on someone else's, is yours to answer even though you did not write
 * it.
 *
 * They cannot be one query. GitHub search ANDs its qualifiers, so
 * `author:x user:x` is "authored by x, in x's repositories" — narrower than
 * either half, not their union. Aliased searches still share one request,
 * which is what keeps a refresh at three requests rather than eight.
 */
export function multiSearchQuery<Alias extends string>(
  type: "ISSUE" | "DISCUSSION",
  selection: string,
  aliases: readonly Alias[],
): SearchDocument<Alias> {
  const variables = [...aliases.map((alias) => `$${alias}: String!`), "$limit: Int!"].join(", ");
  const searches = aliases
    .map(
      (alias) =>
        `  ${alias}: search(query: $${alias}, type: ${type}, first: $limit) { nodes { ${selection} } }`,
    )
    .join("\n");
  return { text: `query(${variables}) {\n${searches}\n}`, aliases };
}

function nodesOf(result: unknown): unknown[] {
  const nodes = (result as { nodes?: unknown } | undefined)?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

/**
 * Runs every alias in one request and returns their nodes back to back. The
 * searches overlap — anything the login wrote on its own repository matches
 * two of them, and anything also assigned to the login matches all three —
 * which is what `mergeItems` deduplicates.
 */
async function multiSearch<Alias extends string>(
  api: GitHubApi,
  document: SearchDocument<Alias>,
  queries: Record<Alias, string>,
  limit: number,
): Promise<unknown[]> {
  const variables: Record<string, GraphQLVariable> = { limit };
  for (const alias of document.aliases) variables[alias] = queries[alias];
  const data = dataRecord(await api.graphql(document.text, variables));
  return document.aliases.flatMap((alias) => nodesOf(data?.[alias]));
}

/**
 * Anything matching more than one search comes back more than once, so the
 * union is deduplicated by node id. Each search is sorted only within itself,
 * hence the re-sort; and each was allowed `limit` rows, so the merged column is
 * cut back to the one budget it was asked for.
 */
export function mergeItems(items: readonly BoardItem[], limit: number): BoardItem[] {
  const byId = new Map<string, BoardItem>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

const ISSUE_SELECTION = `... on Issue {
  id
  number
  title
  url
  updatedAt
  author { login }
  comments { totalCount }
  labels(first: 20) { nodes { name } }
  repository { nameWithOwner isArchived }
}`;

/**
 * `type: ISSUE` covers issues and pull requests both, so the search itself has
 * to say `is:issue` — the inline fragment alone would leave every pull request
 * in the response as an empty node.
 */
const ISSUE_QUERY = multiSearchQuery("ISSUE", ISSUE_SELECTION, [
  "mine",
  "owned",
  "assigned",
] as const);

export async function fetchIssues(api: GitHubApi, login: string, limit: number): Promise<BoardItem[]> {
  const scope = `is:issue state:open ${UNARCHIVED_ONLY} sort:updated-desc`;
  const nodes = await multiSearch(
    api,
    ISSUE_QUERY,
    {
      mine: `${scope} author:${login}`,
      owned: `${scope} user:${login}`,
      assigned: `${scope} assignee:${login}`,
    },
    limit,
  );
  const items = nodes
    .filter((node): node is GhSearchNode => typeof node === "object" && node !== null)
    .filter((node) => typeof node.id === "string")
    .map((node) => toItem(node, null));
  return mergeItems(items, limit);
}

/**
 * Pull requests carry `closingIssuesReferences` — the link from a pull request
 * to the issues it closes, and the only source that sees both closing keywords
 * in the body and issues attached by hand from the Development panel. The board
 * needs it to fold an issue into the pull request that closes it.
 *
 * `headRefOid` is what `fetchBranchStatuses` compares against the base.
 */
const PULL_REQUEST_SELECTION = `... on PullRequest {
  id
  number
  title
  url
  updatedAt
  isDraft
  headRefOid
  author { login }
  comments { totalCount }
  labels(first: 20) { nodes { name } }
  repository { nameWithOwner isArchived }
  closingIssuesReferences(first: 20) {
    nodes { id number repository { nameWithOwner } }
  }
}`;

const PULL_REQUEST_QUERY = multiSearchQuery("ISSUE", PULL_REQUEST_SELECTION, [
  "mine",
  "owned",
  "assigned",
] as const);

interface GhPullRequestNode extends GhSearchNode {
  isDraft?: unknown;
  headRefOid?: unknown;
  closingIssuesReferences?: { nodes?: unknown };
}

function toLinkedIssues(node: GhPullRequestNode): LinkedIssue[] {
  const nodes = node.closingIssuesReferences?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((issue): issue is Record<string, unknown> => typeof issue === "object" && issue !== null)
    .map((issue) => ({
      id: typeof issue.id === "string" ? issue.id : "",
      number: typeof issue.number === "number" ? issue.number : 0,
      repository:
        typeof (issue.repository as { nameWithOwner?: unknown } | undefined)?.nameWithOwner ===
        "string"
          ? (issue.repository as { nameWithOwner: string }).nameWithOwner
          : "",
    }))
    .filter((issue) => issue.id !== "");
}

/**
 * The checks on each pull request's head commit, by node id.
 *
 * A **separate request** from the search, deliberately. A token without the
 * Checks permission — a fine-grained PAT, typically — answers
 * `statusCheckRollup` with "Resource not accessible", and any GraphQL error
 * fails the whole request. Asking for it inside the search would turn that into
 * a blank Draft PRs *and* Open PRs column; asking for it separately costs pills
 * nobody could have seen anyway.
 *
 * `nodes(ids:)` takes at most 100 ids, which the caller cannot exceed: it asks
 * only for the open pull requests, and the merged list was already cut to
 * `limit`, whose own ceiling is 100.
 */
export const CHECKS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    checkSuite { workflowRun { databaseId } }
                  }
                  ... on StatusContext {
                    context
                    state
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Where one check lands in the summary. `ignored` is the fourth outcome that is
 * neither a result nor a wait — a skipped or cancelled run says nothing about
 * whether the pull request is healthy, so it is counted nowhere, exactly as
 * Paseo's own checks summary drops it.
 */
type CheckOutcome = "passed" | "failed" | "pending" | "ignored";

/**
 * Mirrors Paseo's `mapCheckRunStatus`, with one deliberate difference:
 * `STARTUP_FAILURE` and `STALE` are terminal, so reporting them as `pending`
 * would show a run still going that will never report again.
 */
function checkRunOutcome(status: unknown, conclusion: unknown): CheckOutcome {
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failed";
    case "CANCELLED":
    case "SKIPPED":
    case "NEUTRAL":
    case "STALE":
      return "ignored";
    default:
      return "pending";
  }
}

/** The commit-status half of the rollup, which has states rather than conclusions. */
function statusContextOutcome(state: unknown): CheckOutcome {
  switch (state) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "ERROR":
      return "failed";
    default:
      return "pending";
  }
}

function parseTime(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface CountedCheck {
  name: string;
  outcome: CheckOutcome;
  /** Higher wins when the same name appears twice; see `foldChecks`. */
  recency: number;
}

function toCountedCheck(node: Record<string, unknown>): CountedCheck | null {
  if (node.__typename === "CheckRun") {
    const workflowRunId = (
      node.checkSuite as { workflowRun?: { databaseId?: unknown } } | undefined
    )?.workflowRun?.databaseId;
    return {
      name: typeof node.name === "string" ? node.name : "",
      outcome: checkRunOutcome(node.status, node.conclusion),
      // A re-run gets a higher run id than the run it replaced, so the id
      // orders attempts even before either of them has a timestamp.
      recency:
        typeof workflowRunId === "number"
          ? workflowRunId
          : parseTime(node.completedAt ?? node.startedAt),
    };
  }
  if (node.__typename === "StatusContext") {
    return {
      name: typeof node.context === "string" ? node.context : "",
      outcome: statusContextOutcome(node.state),
      recency: parseTime(node.createdAt),
    };
  }
  // A rollup entry of some type this query did not ask for.
  return null;
}

/**
 * Folds one commit's rollup into the three counts a card shows.
 *
 * Deduplicated by check name, keeping the most recent: a re-run leaves the
 * attempt it replaced in the rollup, and counting both would report a check
 * that failed and then passed as one of each.
 *
 * Null rather than three zeroes when nothing reported at all, so "no CI here"
 * and "every check was skipped" both render as no pills instead of as an empty
 * summary.
 */
export function foldChecks(nodes: readonly unknown[]): CheckSummary | null {
  const latest = new Map<string, CountedCheck>();
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const check = toCountedCheck(node as Record<string, unknown>);
    if (check === null) continue;
    const existing = latest.get(check.name);
    if (existing === undefined || check.recency >= existing.recency) latest.set(check.name, check);
  }
  if (latest.size === 0) return null;

  const summary = { passed: 0, failed: 0, pending: 0 };
  for (const check of latest.values()) {
    if (check.outcome === "passed") summary.passed += 1;
    else if (check.outcome === "failed") summary.failed += 1;
    else if (check.outcome === "pending") summary.pending += 1;
  }
  return summary.passed + summary.failed + summary.pending === 0 ? null : summary;
}

function rollupContexts(node: unknown): unknown[] {
  const commits = (node as { commits?: { nodes?: unknown } } | undefined)?.commits?.nodes;
  if (!Array.isArray(commits)) return [];
  // `commits(last: 1)` is the head commit, which is the only one whose checks
  // describe the pull request as it stands.
  const commit = (commits[0] as { commit?: unknown } | undefined)?.commit;
  const contexts = (
    commit as { statusCheckRollup?: { contexts?: { nodes?: unknown } } } | undefined
  )?.statusCheckRollup?.contexts?.nodes;
  return Array.isArray(contexts) ? contexts : [];
}

async function fetchChecks(
  api: GitHubApi,
  ids: readonly string[],
): Promise<Map<string, CheckSummary>> {
  const data = await api.graphql(CHECKS_QUERY, { ids });
  const nodes = (data as { nodes?: unknown } | undefined)?.nodes;
  const summaries = new Map<string, CheckSummary>();
  if (!Array.isArray(nodes)) return summaries;
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const id = (node as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const summary = foldChecks(rollupContexts(node));
    if (summary !== null) summaries.set(id, summary);
  }
  return summaries;
}

/**
 * Checks are a second round trip, so a failure here must cost the pills and
 * nothing else — the pull requests themselves already loaded. The reason goes
 * to the plugin log rather than being dropped, because a permanently pill-less
 * board with no explanation is the one outcome worse than no pills.
 */
async function attachChecks(api: GitHubApi, items: readonly BoardItem[]): Promise<BoardItem[]> {
  const ids = items.map((item) => item.id).filter((id) => id !== "");
  if (ids.length === 0) return [...items];
  let summaries: Map<string, CheckSummary>;
  try {
    summaries = await fetchChecks(api, ids);
  } catch (error) {
    api.warn(`pull request checks unavailable: ${messageOf(error)}`);
    return [...items];
  }
  return items.map((item) => ({ ...item, checks: summaries.get(item.id) ?? null }));
}

/** A pull request to compare, and the head commit the search saw it at. */
interface BranchHead {
  id: string;
  headOid: string;
}

/**
 * One alias per pull request, because `compare` takes the head as an argument
 * and GraphQL cannot feed one field's answer into another's argument — so the
 * head commit has to come from the search first, and this is a second request.
 *
 * The comparison runs from the *base* ref, in the base repository, against the
 * head commit's SHA rather than the head branch's name: a pull request from a
 * fork has no such branch in the base repository, but GitHub keeps every pull
 * request's head commit there (`refs/pull/<n>/head`), so the SHA resolves for a
 * fork and a same-repository branch alike.
 */
export function branchStatusQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `$id${index}: ID!, $head${index}: String!`).join(", ");
  const selections = indexes
    .map(
      (index) =>
        `  pr${index}: node(id: $id${index}) { ... on PullRequest { mergeable viewerCanUpdateBranch repository { viewerPermission } baseRef { compare(headRef: $head${index}) { behindBy } } } }`,
    )
    .join("\n");
  return `query(${variables}) {\n${selections}\n}`;
}

/** Permissions that can push to the base repository, and so can merge its base into a head there. */
const WRITE_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

/**
 * One alias's answer, or null when GitHub had no comparison to give — a base
 * branch deleted from under an open pull request leaves `baseRef` null.
 *
 * `canUpdate` is: behind, no known conflicts, and either GitHub's own
 * `viewerCanUpdateBranch` or write access to the base repository.
 *
 * - Write access, because `viewerCanUpdateBranch` is also false wherever the
 *   repository has "Always suggest updating pull request branches" off — the
 *   default for a new repository — and the update still works there: checked
 *   on 2026-09-30 against a throwaway pull request on
 *   gpambrozio/SquarelineToEsphome (setting off, `viewerCanUpdateBranch`
 *   false, one behind), where `updatePullRequestBranch` merged the base in.
 *   Paseo's board, and GitHub's own page, show no button there; this one does.
 *   Without write access the button stays hidden.
 * - Not conflicts, because neither signal accounts for them:
 *   getpaseo/paseo#3339 answered `viewerCanUpdateBranch: true` with
 *   `mergeable: CONFLICTING`, and the update GitHub offered there fails.
 * - `behindBy > 0`, so the button can never appear without the pill.
 *
 * `mergeable` is `UNKNOWN` until GitHub has computed it, which asking starts;
 * that reads as no conflicts, and the look in `updateBranch` is what stops a
 * press on a branch whose conflicts were not known yet.
 */
export function toBranchStatus(node: unknown): BranchStatus | null {
  const record = node as
    | {
        mergeable?: unknown;
        viewerCanUpdateBranch?: unknown;
        repository?: { viewerPermission?: unknown } | null;
        baseRef?: { compare?: { behindBy?: unknown } | null } | null;
      }
    | null
    | undefined;
  const behindBy = record?.baseRef?.compare?.behindBy;
  if (typeof behindBy !== "number" || behindBy < 0) return null;
  const conflicts = record?.mergeable === "CONFLICTING";
  return {
    behindBy,
    canUpdate:
      behindBy > 0 &&
      !conflicts &&
      (record?.viewerCanUpdateBranch === true ||
        WRITE_PERMISSIONS.has(String(record?.repository?.viewerPermission))),
    conflicts,
  };
}

/**
 * Whether each pull request has fallen behind its base, draft and open alike —
 * unlike checks, being out of date is worth knowing while the work is still a
 * draft, because that is when bringing it up to date is cheapest.
 *
 * A separate request from the search for the reason above, and treated like
 * checks when it fails: the pull requests already loaded, so a failure costs the
 * pills and the buttons and goes to the plugin log. It runs alongside the
 * checks request rather than after it, so the board waits for the slower of the
 * two and not their sum.
 */
async function fetchBranchStatuses(
  api: GitHubApi,
  heads: readonly BranchHead[],
): Promise<Map<string, BranchStatus>> {
  const statuses = new Map<string, BranchStatus>();
  if (heads.length === 0) return statuses;
  const variables: Record<string, GraphQLVariable> = {};
  heads.forEach((head, index) => {
    variables[`id${index}`] = head.id;
    variables[`head${index}`] = head.headOid;
  });
  try {
    const data = dataRecord(await api.graphql(branchStatusQuery(heads.length), variables));
    heads.forEach((head, index) => {
      const status = toBranchStatus(data?.[`pr${index}`]);
      if (status !== null) statuses.set(head.id, status);
    });
  } catch (error) {
    api.warn(`pull request branch status unavailable: ${messageOf(error)}`);
  }
  return statuses;
}

/**
 * One search backs two columns. Splitting client-side would ship draft pull
 * requests the open column discards, so the split happens here — after the
 * merge, so the `limit` is spent on the pull requests that exist rather than on
 * one column's share of them.
 */
export async function fetchPullRequests(
  api: GitHubApi,
  login: string,
  limit: number,
): Promise<{ draft: BoardItem[]; open: BoardItem[] }> {
  const scope = `is:pr state:open ${UNARCHIVED_ONLY} sort:updated-desc`;
  const nodes = await multiSearch(
    api,
    PULL_REQUEST_QUERY,
    {
      mine: `${scope} author:${login}`,
      owned: `${scope} user:${login}`,
      assigned: `${scope} assignee:${login}`,
    },
    limit,
  );

  const drafts = new Set<string>();
  const headOids = new Map<string, string>();
  const items: BoardItem[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const row = node as GhPullRequestNode;
    // The search returns issues and pull requests under one type; a node that
    // matched neither inline fragment comes back as an empty object.
    if (typeof row.id !== "string") continue;
    if (row.isDraft === true) drafts.add(row.id);
    if (typeof row.headRefOid === "string" && row.headRefOid !== "") {
      headOids.set(row.id, row.headRefOid);
    }
    items.push({ ...toItem(row, null), linkedIssues: toLinkedIssues(row) });
  }

  const merged = mergeItems(items, limit);
  const heads = merged.flatMap((item) => {
    const headOid = headOids.get(item.id);
    return headOid === undefined ? [] : [{ id: item.id, headOid }];
  });
  // Checks are fetched for the open column alone: a draft says its work is not
  // finished, so its CI is nobody's business yet, and asking for fewer ids
  // keeps the extra request as small as the thing it feeds.
  const [statuses, open] = await Promise.all([
    fetchBranchStatuses(api, heads),
    attachChecks(
      api,
      merged.filter((item) => !drafts.has(item.id)),
    ),
  ]);
  const withBranch = (item: BoardItem): BoardItem => ({
    ...item,
    branch: statuses.get(item.id) ?? null,
  });
  return {
    draft: merged.filter((item) => drafts.has(item.id)).map(withBranch),
    open: open.map(withBranch),
  };
}

const DISCUSSION_SELECTION = `... on Discussion {
  id
  number
  title
  url
  updatedAt
  author { login }
  category { name }
  comments { totalCount }
  repository { nameWithOwner isArchived }
}`;

const DISCUSSION_QUERY = multiSearchQuery("DISCUSSION", DISCUSSION_SELECTION, [
  "mine",
  "owned",
] as const);

interface GhDiscussionNode extends GhSearchNode {
  category?: { name?: unknown };
}

/**
 * GitHub's discussion search accepts `author:` and `user:` but ignores
 * `involves:` and `commenter:`, so this column is what the login wrote plus
 * whatever is being discussed on its own repositories — never a thread it only
 * replied to elsewhere. A discussion has no assignee either, so this column
 * gets two searches where the others get three.
 */
export async function fetchDiscussions(
  api: GitHubApi,
  login: string,
  limit: number,
): Promise<BoardItem[]> {
  const nodes = await multiSearch(
    api,
    DISCUSSION_QUERY,
    {
      mine: `author:${login} sort:updated-desc`,
      owned: `user:${login} sort:updated-desc`,
    },
    limit,
  );
  const items = nodes
    .filter((node): node is GhDiscussionNode => typeof node === "object" && node !== null)
    .filter((node) => typeof node.id === "string")
    .filter((node) => node.repository?.isArchived !== true)
    .map((node) =>
      toItem(node, typeof node.category?.name === "string" ? node.category.name : null),
    );
  return mergeItems(items, limit);
}

async function settle(
  id: BoardColumn["id"],
  title: string,
  load: () => Promise<BoardItem[]>,
): Promise<BoardColumn> {
  try {
    return { id, title, items: await load(), error: null };
  } catch (error) {
    return { id, title, items: [], error: messageOf(error) };
  }
}

/**
 * The four columns, in display order. Each carries its own `error`, so a
 * missing `read:discussion` scope blanks one column instead of the board; both
 * pull request columns come from one request, so they fail together.
 *
 * `login` must already be concrete — see `resolveViewerLogin`.
 */
export async function loadColumns(
  api: GitHubApi,
  login: string,
  limit: number,
): Promise<BoardColumn[]> {
  const pullRequests = fetchPullRequests(api, login, limit).then(
    (split) => ({ split, error: null as string | null }),
    (error: unknown) => ({
      split: { draft: [] as BoardItem[], open: [] as BoardItem[] },
      error: messageOf(error),
    }),
  );

  const [issues, prs, discussions] = await Promise.all([
    settle("issues", "Issues", () => fetchIssues(api, login, limit)),
    pullRequests,
    settle("discussions", "Discussions", () => fetchDiscussions(api, login, limit)),
  ]);

  return [
    issues,
    { id: "draft-prs", title: "Draft PRs", items: prs.split.draft, error: prs.error },
    { id: "open-prs", title: "Open PRs", items: prs.split.open, error: prs.error },
    discussions,
  ];
}

/**
 * Up to date from here on. GitHub accepts the update and makes the merge
 * commit on its side, so comparing straight afterwards could still see the old
 * head and put the pill back on a branch that was just updated; a success is
 * taken at its word instead. A merge conflict fails the mutation itself, which
 * is what the client then shows.
 */
export const UPDATED_BRANCH: BranchStatus = { behindBy: 0, canUpdate: false, conflicts: false };

/**
 * How long a success is taken at its word over a comparison — long enough for
 * GitHub to have made the merge commit, after which a refresh reads the real
 * state again.
 */
export const BRANCH_UPDATE_SETTLE_MS = 2 * 60_000;

/**
 * Applies recent branch updates to a board that was compared before they
 * landed. `recentUpdates` maps a pull request's node id to when its branch was
 * updated; entries older than the settle window are deleted as they are met.
 *
 * Run after the board's last `await` and before it is cached: a refresh
 * already running when an update lands compared the branch *before* it, and
 * caching that answer would put the pill and the button straight back.
 */
export function settleBranches(
  columns: readonly BoardColumn[],
  recentUpdates: Map<string, number>,
  now: number,
): BoardColumn[] {
  const settled = (item: BoardItem): BoardItem => {
    const updatedAt = recentUpdates.get(item.id);
    if (updatedAt === undefined) return item;
    if (now - updatedAt < BRANCH_UPDATE_SETTLE_MS) return { ...item, branch: UPDATED_BRANCH };
    recentUpdates.delete(item.id);
    return item;
  };
  return columns.map((column) => ({ ...column, items: column.items.map(settled) }));
}

/** How long a label edit is taken at its word over a search that may predate it. */
export const LABEL_EDIT_SETTLE_MS = 2 * 60_000;

/**
 * Applies recent label edits to a board whose searches may have run before
 * them — a refresh in flight when a label is toggled would otherwise cache the
 * labels the edit replaced. `recentLabels` maps an item's node id to the labels
 * GitHub answered and when; entries past the window are deleted as they are met.
 */
export function settleLabels(
  columns: readonly BoardColumn[],
  recentLabels: Map<string, { labels: string[]; at: number }>,
  now: number,
): BoardColumn[] {
  const settled = (item: BoardItem): BoardItem => {
    const edit = recentLabels.get(item.id);
    if (edit === undefined) return item;
    if (now - edit.at < LABEL_EDIT_SETTLE_MS) return { ...item, labels: edit.labels };
    recentLabels.delete(item.id);
    return item;
  };
  return columns.map((column) => ({ ...column, items: column.items.map(settled) }));
}

/**
 * First 100 by name, which is every label on all but a deliberately elaborate
 * repository. Paging past that would mean a cursor loop for a menu nobody can
 * read anyway; a label past the hundredth is edited on GitHub.
 */
const LABELS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) {
      nodes { id name color description }
    }
  }
}`;

/** `owner/name` as every card spells it, and the only form these functions take. */
export function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split("/");
  if (owner === undefined || owner === "" || name === undefined || name === "" || rest.length > 0) {
    throw new Error(`"${repository}" is not an owner/name repository.`);
  }
  return { owner, name };
}

export async function fetchRepositoryLabels(
  api: GitHubApi,
  repository: string,
): Promise<RepositoryLabel[]> {
  const { owner, name } = splitRepository(repository);
  const data = await api.graphql(LABELS_QUERY, { owner, name });
  const nodes = (data as { repository?: { labels?: { nodes?: unknown } } } | undefined)?.repository
    ?.labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node): node is Record<string, unknown> => typeof node === "object" && node !== null)
    .map((node) => ({
      id: typeof node.id === "string" ? node.id : "",
      name: typeof node.name === "string" ? node.name : "",
      color: typeof node.color === "string" ? node.color : "",
      description:
        typeof node.description === "string" && node.description !== "" ? node.description : null,
    }))
    .filter((label) => label.id !== "" && label.name !== "");
}

/**
 * Both mutations answer with the labelable they changed, so the item's new
 * labels come back in the same round trip that set them — no read-after-write,
 * and no window where the card and GitHub disagree.
 *
 * `Labelable` is an interface, so the labels have to be selected through an
 * inline fragment per concrete type; issues and pull requests are the two the
 * board offers this on.
 */
const LABELABLE_SELECTION = `labelable {
      ... on Issue { labels(first: 20) { nodes { name } } }
      ... on PullRequest { labels(first: 20) { nodes { name } } }
    }`;

const ADD_LABEL_MUTATION = `mutation($item: ID!, $label: ID!) {
  addLabelsToLabelable(input: { labelableId: $item, labelIds: [$label] }) {
    ${LABELABLE_SELECTION}
  }
}`;

const REMOVE_LABEL_MUTATION = `mutation($item: ID!, $label: ID!) {
  removeLabelsFromLabelable(input: { labelableId: $item, labelIds: [$label] }) {
    ${LABELABLE_SELECTION}
  }
}`;

function labelNamesOf(result: unknown): string[] {
  const nodes = (result as { labelable?: { labels?: { nodes?: unknown } } } | undefined)?.labelable
    ?.labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (node as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string");
}

/** Adds or removes one label and answers the item's labels as GitHub now has them. */
export async function toggleLabel(
  api: GitHubApi,
  itemId: string,
  labelId: string,
  add: boolean,
): Promise<string[]> {
  const data = dataRecord(
    await api.graphql(add ? ADD_LABEL_MUTATION : REMOVE_LABEL_MUTATION, {
      item: itemId,
      label: labelId,
    }),
  );
  return labelNamesOf(add ? data?.addLabelsToLabelable : data?.removeLabelsFromLabelable);
}

/**
 * `MERGE` is spelled out although it is the default: it is the choice that
 * matters, since a rebase would rewrite a branch someone may have checked out.
 *
 * No `expectedHeadOid`. It would refuse the update whenever the branch moved
 * since the board loaded — a push from an agent five minutes ago, say — and
 * merging the base into the *new* head is still exactly what the button
 * promised.
 */
export const UPDATE_BRANCH_MUTATION = `mutation($id: ID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, updateMethod: MERGE }) {
    pullRequest { id }
  }
}`;

const HEAD_OID_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequest { headRefOid } }
}`;

/**
 * A last look before merging, because the board's answer is not enough to
 * send an update on. It can be minutes old, and it can predate GitHub knowing
 * about conflicts at all — `mergeable` is `UNKNOWN` the first time it is asked
 * — while `viewerCanUpdateBranch` stays true either way. By the time someone
 * presses the button the board's own load has set GitHub computing, so this
 * look is the one that knows.
 *
 * Two requests, because `compare` needs the head and a query cannot feed one
 * field's answer into another's argument; a press is rare enough for that.
 * Null when the look fails, and the mutation is then left to answer for itself.
 */
async function currentBranchStatus(api: GitHubApi, id: string): Promise<BranchStatus | null> {
  let headOid: unknown;
  try {
    const data = await api.graphql(HEAD_OID_QUERY, { id });
    headOid = (data as { node?: { headRefOid?: unknown } } | undefined)?.node?.headRefOid;
  } catch (error) {
    api.warn(`could not check the branch before updating it: ${messageOf(error)}`);
    return null;
  }
  if (typeof headOid !== "string" || headOid === "") return null;
  return (await fetchBranchStatuses(api, [{ id, headOid }])).get(id) ?? null;
}

/**
 * GitHub's "Update branch", after a last look. `updated: false` means the look
 * found nothing the update could do and nothing was sent; `branch` is then what
 * the look found. On success `branch` is `UPDATED_BRANCH`, and the caller
 * records the update for `settleBranches`.
 */
export async function updateBranch(
  api: GitHubApi,
  id: string,
): Promise<{ updated: boolean; branch: BranchStatus }> {
  const current = await currentBranchStatus(api, id);
  if (current !== null && !current.canUpdate) return { updated: false, branch: current };
  await api.graphql(UPDATE_BRANCH_MUTATION, { id });
  return { updated: true, branch: UPDATED_BRANCH };
}

/**
 * The body of one card, fetched when its panel opens rather than with the
 * board: a body is the largest field an item has, and thirty of them per column
 * would weigh down a refresh for text the user reads one at a time.
 *
 * `node(id:)` resolves any node type, so one query serves all three kinds and
 * the inline fragments decide which fields come back. A discussion carries no
 * assignees on GitHub, and only a pull request has branches.
 */
const ITEM_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on Issue {
      body state createdAt
      assignees(first: 20) { nodes { login } }
    }
    ... on PullRequest {
      body state isDraft createdAt baseRefName headRefName
      assignees(first: 20) { nodes { login } }
    }
    ... on Discussion { body closed createdAt }
  }
}`;

interface GhItemNode {
  body?: unknown;
  state?: unknown;
  isDraft?: unknown;
  closed?: unknown;
  createdAt?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  assignees?: { nodes?: unknown };
}

function itemStateOf(node: GhItemNode): ItemDetails["state"] {
  if (node.state === "MERGED") return "merged";
  if (node.state === "CLOSED" || node.closed === true) return "closed";
  if (node.isDraft === true) return "draft";
  return "open";
}

export function toItemDetails(node: GhItemNode): ItemDetails {
  const assigneeNodes = node.assignees?.nodes;
  const assignees = Array.isArray(assigneeNodes)
    ? assigneeNodes
        .map((assignee) => (assignee as { login?: unknown }).login)
        .filter((login): login is string => typeof login === "string")
    : [];
  return {
    state: itemStateOf(node),
    body: typeof node.body === "string" ? node.body : "",
    createdAt: typeof node.createdAt === "string" ? node.createdAt : "",
    assignees,
    branches:
      typeof node.headRefName === "string" && typeof node.baseRefName === "string"
        ? { head: node.headRefName, base: node.baseRefName }
        : null,
  };
}

const GONE = "GitHub no longer has this item, or the account cannot see it.";

export async function fetchItemDetails(api: GitHubApi, id: string): Promise<ItemDetails> {
  const data = await api.graphql(ITEM_QUERY, { id });
  const node = (data as { node?: unknown } | undefined)?.node;
  if (typeof node !== "object" || node === null) throw new Error(GONE);
  return toItemDetails(node as GhItemNode);
}

/**
 * The conversation on one card. `comments` on an issue or a pull request is
 * the flat conversation; a discussion threads one level deep, so its replies
 * are selected too and flattened with `depth: 1`. The page sizes are what a
 * panel can be scrolled through — anything longer is read on GitHub, which
 * `truncated` tells the panel to say.
 */
export const COMMENTS_PAGE = 50;
export const REPLIES_PAGE = 20;

const COMMENT_FIELDS = "id body createdAt author { login }";

const COMMENTS_QUERY = `query($id: ID!, $first: Int!, $replies: Int!) {
  node(id: $id) {
    ... on Issue {
      comments(first: $first) { totalCount nodes { ${COMMENT_FIELDS} } }
    }
    ... on PullRequest {
      comments(first: $first) { totalCount nodes { ${COMMENT_FIELDS} } }
    }
    ... on Discussion {
      comments(first: $first) {
        totalCount
        nodes {
          ${COMMENT_FIELDS}
          replies(first: $replies) { totalCount nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

interface GhCommentNode {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  author?: { login?: unknown };
  replies?: { totalCount?: unknown; nodes?: unknown };
}

function toComment(node: GhCommentNode, depth: number): ItemComment {
  return {
    id: typeof node.id === "string" ? node.id : "",
    author: typeof node.author?.login === "string" ? node.author.login : null,
    createdAt: typeof node.createdAt === "string" ? node.createdAt : "",
    body: typeof node.body === "string" ? node.body : "",
    depth,
  };
}

function commentNodesOf(value: unknown): GhCommentNode[] {
  const nodes = (value as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((node): node is GhCommentNode => typeof node === "object" && node !== null);
}

function countOf(value: unknown): number {
  const total = (value as { totalCount?: unknown } | undefined)?.totalCount;
  return typeof total === "number" ? total : 0;
}

export async function fetchComments(
  api: GitHubApi,
  id: string,
): Promise<{ comments: ItemComment[]; truncated: boolean }> {
  const data = await api.graphql(COMMENTS_QUERY, {
    id,
    first: COMMENTS_PAGE,
    replies: REPLIES_PAGE,
  });
  const node = (data as { node?: unknown } | undefined)?.node;
  if (typeof node !== "object" || node === null) throw new Error(GONE);
  const connection = (node as { comments?: unknown }).comments;
  const comments: ItemComment[] = [];
  let truncated = countOf(connection) > COMMENTS_PAGE;
  for (const commentNode of commentNodesOf(connection)) {
    comments.push(toComment(commentNode, 0));
    // Replies are a discussion's second level; issues and pull requests have none.
    if (countOf(commentNode.replies) > REPLIES_PAGE) truncated = true;
    for (const reply of commentNodesOf(commentNode.replies)) {
      comments.push(toComment(reply, 1));
    }
  }
  return { comments: comments.filter((comment) => comment.id !== ""), truncated };
}
