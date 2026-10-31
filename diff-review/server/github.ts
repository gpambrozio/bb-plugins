/**
 * GitHub, through the GitHub CLI's own login on the bb server's Mac (decision 5 of the plan: posting
 * as the owner with `gh`, never from an agent run). `gh` is found on PATH or where Homebrew puts it,
 * as `github-board` finds it. The GraphQL queries and mutations are diffity's
 * (`src-tauri/src/github/graphql.rs`, https://github.com/nilbuild/diffity, MIT).
 */
import { execFile } from "node:child_process";

import type { PullRef, ReviewEvent } from "../shared/github";

export const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"] as const;
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT = 16 * 1024 * 1024;

/** Runs `gh` with `args`, writing `stdin` to it when given; answers its stdout. `signal` kills it. */
export type GhRunner = (args: readonly string[], stdin?: string, signal?: AbortSignal) => Promise<string>;

export class GitHubError extends Error {}

function describeFailure(error: unknown, stderr: string): string {
  if ((error as { code?: unknown } | null)?.code === "ENOENT") return "The GitHub CLI (gh) is not installed on the bb server's machine.";
  if (stderr.includes("gh auth login") || stderr.toLowerCase().includes("authentication")) return "The GitHub CLI is not signed in. Run `gh auth login` on the machine running bb.";
  return stderr.trim().split("\n").at(-1) || (error instanceof Error ? error.message : String(error));
}

/** Runs `gh`, the first of `GH_CANDIDATES` that exists; remembered once found. */
export function createGhRunner(): GhRunner {
  let found: string | null = null;
  const attempt = (file: string, args: readonly string[], stdin: string | undefined, signal: AbortSignal | undefined) =>
    new Promise<{ stdout: string; missing: boolean }>((resolve, reject) => {
      const options = { encoding: "utf8" as const, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_OUTPUT, ...(signal === undefined ? {} : { signal }) };
      const child = execFile(file, [...args], options, (error, stdout, stderr) => {
        if (error === null) resolve({ stdout, missing: false });
        else if ((error as { code?: unknown }).code === "ENOENT") resolve({ stdout: "", missing: true });
        else reject(new GitHubError(describeFailure(error, stderr)));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin ?? "");
    });
  return async (args, stdin, signal) => {
    for (const candidate of found === null ? GH_CANDIDATES : [found]) {
      const result = await attempt(candidate, args, stdin, signal);
      if (result.missing) continue;
      found = candidate;
      return result.stdout;
    }
    throw new GitHubError(describeFailure({ code: "ENOENT" }, ""));
  };
}

type Variables = Record<string, unknown>;

/**
 * A GraphQL request as `gh api graphql --input -` takes it: the whole JSON body on stdin, so object
 * variables (a mutation's `input`) keep their types; `-F` would send them as strings.
 */
export function graphqlRequest(query: string, variables: Variables): { args: string[]; body: string } {
  const present = Object.fromEntries(Object.entries(variables).filter(([, value]) => value !== null && value !== undefined));
  return { args: ["api", "graphql", "--input", "-"], body: JSON.stringify({ query, variables: present }) };
}

export interface PullMeta {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  baseRefOid: string;
}

export interface RemoteComment {
  id: string;
  body: string;
  author: string;
  createdAt: number;
  /** The diff around the commented lines when the comment was made, ending with them. */
  diffHunk: string | null;
}

export interface RemoteThread {
  id: string;
  path: string;
  isResolved: boolean;
  isOutdated: boolean;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  /** `FILE` for a comment on the whole file, which has no lines. */
  subjectType: "LINE" | "FILE";
  comments: RemoteComment[];
}

export interface DraftThread {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

const PULL_FIELDS = "id number title url state baseRefName headRefName headRefOid baseRefOid";
const PULL_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${PULL_FIELDS}}}}`;
const COMMENT_FIELDS = "id body createdAt diffHunk author{login}";
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line startLine originalLine originalStartLine diffSide subjectType comments(first:100){nodes{${COMMENT_FIELDS}}}}}}}}`;
const ADD_REVIEW = "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id url}}}";
const ADD_THREAD = "mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id comments(first:1){nodes{id}}}}}";
const SUBMIT_REVIEW = "mutation($input:SubmitPullRequestReviewInput!){submitPullRequestReview(input:$input){pullRequestReview{id url}}}";
const DELETE_REVIEW = "mutation($input:DeletePullRequestReviewInput!){deletePullRequestReview(input:$input){pullRequestReview{id}}}";
const REPLY = "mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id}}}";
const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
const UNRESOLVE = "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
const FILES_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){files(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`;
const MARK_VIEWED = "mutation($input:MarkFileAsViewedInput!){markFileAsViewed(input:$input){clientMutationId}}";
const UNMARK_VIEWED = "mutation($input:UnmarkFileAsViewedInput!){unmarkFileAsViewed(input:$input){clientMutationId}}";

/**
 * The signed-in account's own Viewed mark on a pull request's file: `DISMISSED` when the file changed
 * after it was marked (GitHub then shows it unmarked).
 */
export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

/** The most review threads read from one pull request. */
const MAX_THREAD_PAGES = 10;
/** The most pages of a pull request's files read for their Viewed marks: GitHub lists 3,000 files at most. */
const MAX_FILE_PAGES = 30;

export class GitHub {
  constructor(private readonly run: GhRunner) {}

  private async graphql(query: string, variables: Variables, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const request = graphqlRequest(query, variables);
    const raw = await this.run(request.args, request.body, signal);
    let parsed: { data?: Record<string, unknown>; errors?: { message?: string }[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new GitHubError("GitHub answered with something that is not JSON.");
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) throw new GitHubError(parsed.errors.map((error) => error.message ?? "error").join("; "));
    return parsed.data ?? {};
  }

  async pull(ref: PullRef): Promise<PullMeta> {
    const data = await this.graphql(PULL_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number });
    const pull = (data.repository as { pullRequest?: PullMeta | null } | null)?.pullRequest;
    if (pull === undefined || pull === null) throw new GitHubError(`No pull request ${ref.owner}/${ref.repo}#${ref.number}, or the GitHub CLI's account cannot see it.`);
    return pull;
  }

  async threads(ref: PullRef): Promise<RemoteThread[]> {
    const threads: RemoteThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const data = await this.graphql(THREADS_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number, after });
      const connection = (data.repository as { pullRequest?: { reviewThreads?: unknown } } | null)?.pullRequest?.reviewThreads as
        | {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: (Omit<RemoteThread, "comments" | "subjectType"> & {
              subjectType?: string | null;
              comments: { nodes: { id: string; body: string; createdAt: string; diffHunk?: string | null; author: { login: string } | null }[] };
            })[];
          }
        | undefined;
      if (connection === undefined) break;
      for (const node of connection.nodes) {
        threads.push({
          ...node,
          subjectType: node.subjectType === "FILE" ? "FILE" : "LINE",
          comments: node.comments.nodes.map((comment) => ({
            id: comment.id,
            body: comment.body,
            author: comment.author?.login ?? "ghost",
            createdAt: Date.parse(comment.createdAt) || 0,
            diffHunk: comment.diffHunk ?? null,
          })),
        });
      }
      if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break;
      after = connection.pageInfo.endCursor;
    }
    return threads;
  }

  /** The account's Viewed mark on each of the pull request's files, by path; `signal` abandons the read. */
  async viewedFiles(ref: PullRef, signal?: AbortSignal): Promise<Map<string, FileViewedState>> {
    const states = new Map<string, FileViewedState>();
    let after: string | null = null;
    for (let page = 0; page < MAX_FILE_PAGES; page++) {
      signal?.throwIfAborted();
      const data = await this.graphql(FILES_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number, after }, signal);
      const connection = (data.repository as { pullRequest?: { files?: unknown } } | null)?.pullRequest?.files as
        | { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ({ path: string; viewerViewedState: string } | null)[] | null }
        | null
        | undefined;
      if (connection === undefined || connection === null) break;
      for (const node of connection.nodes ?? []) {
        if (node === null) continue;
        const state = node.viewerViewedState;
        states.set(node.path, state === "VIEWED" || state === "DISMISSED" ? state : "UNVIEWED");
      }
      if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break;
      after = connection.pageInfo.endCursor;
    }
    return states;
  }

  /** Marks a file of the pull request Viewed for the signed-in account, or clears the mark. */
  async setViewed(pullId: string, path: string, viewed: boolean): Promise<void> {
    await this.graphql(viewed ? MARK_VIEWED : UNMARK_VIEWED, { input: { pullRequestId: pullId, path } });
  }

  async reply(threadId: string, body: string): Promise<void> {
    await this.graphql(REPLY, { input: { pullRequestReviewThreadId: threadId, body } });
  }

  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    await this.graphql(resolved ? RESOLVE : UNRESOLVE, { id: threadId });
  }

  /**
   * One review, in diffity's order: a pending review on the head commit, a thread per line comment,
   * then the submit with the verdict and body. `beforeSubmit` runs just before that last request (the
   * head check); a review that fails or is refused part-way is deleted, so no half-made pending
   * review is left on the pull request. Answers each draft's new thread and first comment ids.
   */
  async submitReview(
    pullId: string,
    headSha: string,
    event: ReviewEvent,
    body: string,
    drafts: readonly DraftThread[],
    beforeSubmit: () => Promise<void> = async () => undefined,
  ): Promise<{ url: string | null; threads: { threadId: string; commentId: string | null }[] }> {
    const added = await this.graphql(ADD_REVIEW, { input: { pullRequestId: pullId, commitOID: headSha } });
    const review = (added.addPullRequestReview as { pullRequestReview?: { id: string; url: string } } | undefined)?.pullRequestReview;
    if (review === undefined) throw new GitHubError("GitHub did not start the review.");
    try {
      const threads: { threadId: string; commentId: string | null }[] = [];
      for (const draft of drafts) {
        const added = await this.graphql(ADD_THREAD, {
          input: {
            pullRequestReviewId: review.id,
            path: draft.path,
            body: draft.body,
            line: draft.line,
            side: draft.side,
            ...(draft.startLine === undefined ? {} : { startLine: draft.startLine, startSide: draft.startSide ?? draft.side }),
          },
        });
        const thread = (added.addPullRequestReviewThread as { thread?: { id: string; comments?: { nodes?: { id: string }[] } } } | undefined)?.thread;
        if (thread === undefined) throw new GitHubError("GitHub did not add a review comment.");
        threads.push({ threadId: thread.id, commentId: thread.comments?.nodes?.[0]?.id ?? null });
      }
      await beforeSubmit();
      const submitted = await this.graphql(SUBMIT_REVIEW, { input: { pullRequestReviewId: review.id, event, ...(body.trim() === "" ? {} : { body }) } });
      return { url: (submitted.submitPullRequestReview as { pullRequestReview?: { url?: string } } | undefined)?.pullRequestReview?.url ?? review.url, threads };
    } catch (error) {
      await this.graphql(DELETE_REVIEW, { input: { pullRequestReviewId: review.id } }).catch(() => undefined);
      throw error;
    }
  }
}
