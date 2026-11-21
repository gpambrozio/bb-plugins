/**
 * Reading the briefing from bb through `BriefingPorts`. One thread, project or machine that cannot be
 * read leaves a gap and a line in `problems`; it never fails the whole briefing.
 */
import { describe, DESCRIPTION_FILES } from "./description";
import { groupFleet } from "./firstmate";
import { flaggedStatusLine, lastLine, userMessages } from "./messages";
import type { Briefing, DetailChild, FirstMateBrief, FlaggedChild, ProjectBrief, ThreadBrief, ThreadDetail } from "./model";
import type { BriefingPorts, ProjectRow, ThreadRow } from "./ports";
import { clip, cleanTitle, plain } from "./text";

export const LIMITS = {
  /** The longest message text kept in the data, after cleaning; the renderer cuts it further. */
  messageChars: 1_200,
  /** Events per page when looking for the user's messages. */
  pageSize: 100,
  /** Pages read from the end of a thread before giving up on finding a message of the user's. */
  userPages: 5,
  /** Sub-threads whose latest reply is read for a status line, across the whole briefing. */
  childReplies: 60,
  /** Reads in flight at once. */
  concurrency: 8,
  /** Checkouts tried per project before its description is given up. */
  descriptionSources: 2,
} as const;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** bb's display status in plain words. */
export function statusWord(status: string): string {
  switch (status) {
    case "active":
      return "working";
    case "error":
      return "failed";
    case "pending":
    case "starting":
      return "starting";
    case "waiting-for-host":
      return "waiting for its machine";
    default:
      return status.replace(/[-_]+/g, " ");
  }
}

function titleOf(row: ThreadRow): string {
  return cleanTitle(row.title ?? row.titleFallback ?? "Untitled");
}

/** `text` cleaned for speech and cut to `max` characters (the thread detail keeps it whole). */
function kept(text: string | null, max: number = LIMITS.messageChars): string | null {
  if (text === null) return null;
  const cleaned = plain(text);
  return cleaned === "" ? null : clip(cleaned, max);
}

interface Messages {
  opening: string | null;
  /** Newest first; the opening one left out. */
  recentUser: string[];
  lastAgent: string | null;
}

/**
 * The thread's opening message, its latest `want` messages from the user, and its agent's latest message,
 * each cut to `maxChars`.
 */
export async function readMessages(
  ports: BriefingPorts,
  threadId: string,
  want: number,
  problems: string[],
  name: string,
  maxChars: number = LIMITS.messageChars,
): Promise<Messages> {
  const failed = (what: string) => (error: unknown) => {
    problems.push(`Could not read ${what} of "${name}": ${reason(error)}`);
    return null;
  };
  const [openingEvent, recent, agent] = await Promise.all([
    ports
      .requests(threadId, "asc", 20)
      .then((events) => userMessages(events)[0] ?? null)
      .catch(failed("the opening message")),
    (async () => {
      const found: { seq: number; text: string }[] = [];
      let before: number | undefined;
      for (let page = 0; page < LIMITS.userPages && found.length < want; page++) {
        const events = await ports.requests(threadId, "desc", LIMITS.pageSize, before);
        found.push(...userMessages(events));
        if (events.length < LIMITS.pageSize) break;
        before = Math.min(...events.map((event) => event.seq));
      }
      return found.slice(0, want);
    })().catch(failed("the latest messages")),
    ports.lastAgentPreview(threadId).catch(failed("the latest reply")),
  ]);
  const openingSeq = openingEvent?.seq ?? null;
  const recentUser = (recent ?? [])
    .filter((message) => message.seq !== openingSeq)
    .map((message) => kept(message.text, maxChars))
    .filter((text): text is string => text !== null);
  return { opening: kept(openingEvent?.text ?? null, maxChars), recentUser, lastAgent: kept(agent, maxChars) };
}

/** Where a project's files can be read: its checkouts, then the workspaces of its threads. */
function placesOf(project: ProjectRow | undefined, rows: readonly ThreadRow[]): { hostId: string; path: string }[] {
  const places: { hostId: string; path: string }[] = [...(project?.sources ?? [])];
  for (const row of rows) {
    if (row.hostId !== null && row.path !== null) places.push({ hostId: row.hostId, path: row.path });
  }
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.hostId}\u0000${place.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The project's description from the first of its files that has one, on the first machine that answers.
 * A file bb refuses (outside the folder, too large, unreadable) is passed over for the next one; a machine
 * that does not answer is passed over for the next place.
 */
export async function readProject(
  ports: BriefingPorts,
  projectId: string,
  project: ProjectRow | undefined,
  rows: readonly ThreadRow[],
  problems: string[],
): Promise<ProjectBrief> {
  const name = project?.name ?? projectId;
  const places = placesOf(project, rows).slice(0, LIMITS.descriptionSources);
  let lastError: string | null = null;
  for (const place of places) {
    const refused: string[] = [];
    try {
      for (const file of DESCRIPTION_FILES) {
        const read = await ports.readFile(place.hostId, place.path, file);
        if (read.kind === "refused") {
          refused.push(`${file} (${read.reason})`);
          continue;
        }
        const description = read.kind === "text" ? describe(read.text) : null;
        if (description !== null) return { id: projectId, name, description: clip(description, LIMITS.messageChars), source: file };
      }
    } catch (error) {
      lastError = reason(error);
      continue;
    }
    if (refused.length > 0) problems.push(`Did not read the description of project "${name}" from ${refused.join(", ")}.`);
    return { id: projectId, name, description: null, source: null };
  }
  if (lastError !== null) problems.push(`Could not read the files of project "${name}": ${lastError}`);
  return { id: projectId, name, description: null, source: null };
}

/** A sub-thread the briefing checked: named when it needs someone, `unchecked` when its reply was not read. */
type ChildCheck = { flag: FlaggedChild | null; unchecked: boolean };

/** Why a sub-thread is worth naming. Reads its latest reply only when it is idle; a failed read is noted in `budget.failed`. */
async function flagOf(ports: BriefingPorts, row: ThreadRow, budget: ReplyBudget): Promise<ChildCheck> {
  const base = { id: row.id, title: titleOf(row) };
  if (row.hasPendingInteraction) return { flag: { ...base, state: "waiting for an answer", detail: null }, unchecked: false };
  if (row.status === "error") return { flag: { ...base, state: "failed", detail: null }, unchecked: false };
  if (row.status !== "idle") return { flag: null, unchecked: false };
  if (budget.replies <= 0) {
    budget.skipped++;
    return { flag: null, unchecked: true };
  }
  budget.replies--;
  let reply: string | null;
  try {
    reply = await ports.latestReply(row.id);
  } catch (error) {
    budget.failed.push(reason(error));
    return { flag: null, unchecked: true };
  }
  const line = flaggedStatusLine(reply);
  if (line === null) return { flag: null, unchecked: false };
  const detail = plain(line.detail);
  return { flag: { ...base, state: line.state, detail: detail === "" ? null : clip(detail, 200) }, unchecked: false };
}

interface ReplyBudget {
  replies: number;
  /** Idle sub-threads not read because `replies` ran out. */
  skipped: number;
  /** Why each failed read failed. */
  failed: string[];
}

/** The problem lines for sub-thread replies that were not read. */
function replyProblems(budget: ReplyBudget, cap: number): string[] {
  const out: string[] = [];
  if (budget.failed.length > 0) {
    out.push(`Could not check ${budget.failed.length === 1 ? "1 sub-thread" : `${budget.failed.length} sub-threads`} for a blocked status line: ${budget.failed[0]}`);
  }
  if (budget.skipped > 0) out.push(`Only ${cap} idle sub-threads were checked for a blocked status line; ${budget.skipped} were not.`);
  return out;
}

/** Most urgent first: the user's attention, then the first mate, then the most recently updated. */
export function compareThreads(a: ThreadBrief, b: ThreadBrief): number {
  return Number(b.needsUser) - Number(a.needsUser) || Number(b.isFirstMate) - Number(a.isFirstMate) || b.updatedAt - a.updatedAt;
}

async function readFirstMate(ports: BriefingPorts, problems: string[]): Promise<FirstMateBrief | null> {
  const read = await ports.fleet().catch((error: unknown) => ({ ok: false as const, reason: reason(error) }));
  if (!read.ok) {
    if (read.reason !== "") problems.push(`Could not read FirstMate's tasks: ${read.reason}`);
    return null;
  }
  return groupFleet(read.fleet);
}

async function childRows(ports: BriefingPorts, rootIds: readonly string[]): Promise<Map<string, ThreadRow[]>> {
  if (rootIds.length === 0) return new Map();
  const below = await ports.descendants(rootIds);
  const ids = [...new Set([...below.values()].flat())];
  const rows = ids.length === 0 ? [] : await ports.threads(ids);
  const byId = new Map(rows.filter((row) => row.archivedAt === null).map((row) => [row.id, row]));
  const out = new Map<string, ThreadRow[]>();
  for (const rootId of rootIds) {
    out.set(
      rootId,
      (below.get(rootId) ?? []).map((id) => byId.get(id)).filter((row): row is ThreadRow => row !== undefined),
    );
  }
  return out;
}

/** The whole briefing: every root thread, its project, its flagged sub-threads, and the first mate's tasks. */
export async function gatherBriefing(ports: BriefingPorts, now: number = Date.now()): Promise<Briefing> {
  const problems: string[] = [];
  const listed = await ports.rootThreads();
  if (!listed.complete) problems.push(`Only the first ${listed.threads.length} root threads were read.`);
  const roots = listed.threads.filter((row) => row.parentThreadId === null && row.archivedAt === null);
  const rootIds = roots.map((row) => row.id);
  const [projects, firstMateAll, children] = await Promise.all([
    ports.projects().catch((error: unknown) => {
      problems.push(`Could not list the projects: ${reason(error)}`);
      return [] as ProjectRow[];
    }),
    readFirstMate(ports, problems),
    childRows(ports, rootIds).catch((error: unknown) => {
      problems.push(`Could not read the sub-threads: ${reason(error)}`);
      return new Map<string, ThreadRow[]>();
    }),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const firstMate = firstMateAll !== null && rootIds.includes(firstMateAll.threadId) ? firstMateAll : null;

  const budget: ReplyBudget = { replies: LIMITS.childReplies, skipped: 0, failed: [] };
  const threads = await pool(roots, LIMITS.concurrency, async (row): Promise<ThreadBrief> => {
    const title = titleOf(row);
    const below = children.get(row.id) ?? [];
    const [messages, flags] = await Promise.all([
      readMessages(ports, row.id, 1, problems, title),
      pool(below, LIMITS.concurrency, (child) => flagOf(ports, child, budget)),
    ]);
    return {
      id: row.id,
      title,
      projectId: row.projectId,
      project: projectById.get(row.projectId)?.name ?? null,
      status: statusWord(row.status),
      needsUser: row.hasPendingInteraction,
      isFirstMate: firstMate?.threadId === row.id,
      updatedAt: row.updatedAt,
      opening: messages.opening,
      lastUser: messages.recentUser[0] ?? null,
      lastAgent: messages.lastAgent,
      childCount: below.length,
      flaggedChildren: flags.map((check) => check.flag).filter((flag): flag is FlaggedChild => flag !== null),
      uncheckedChildren: flags.filter((check) => check.unchecked).length,
    };
  });
  threads.sort(compareThreads);
  problems.push(...replyProblems(budget, LIMITS.childReplies));

  const projectIds = [...new Set(threads.map((thread) => thread.projectId))];
  const mateProjectId = threads.find((thread) => thread.isFirstMate)?.projectId ?? null;
  const projectBriefs = await pool(projectIds, LIMITS.concurrency, (projectId) =>
    projectId === mateProjectId
      ? Promise.resolve(firstMateProject(projectId, projectById.get(projectId)))
      : readProject(ports, projectId, projectById.get(projectId), roots.filter((row) => row.projectId === projectId), problems),
  );

  return { generatedAt: now, threads, projects: projectBriefs, firstMate, problems };
}

/**
 * The first mate's home describes it in its charter, written to the first mate ("You are the first
 * mate…"), and goes on with paths and rules: nothing a voice should read as a project's description.
 */
export const FIRSTMATE_DESCRIPTION =
  "Home of the first mate, who runs a crew of worker threads across all the user's projects and keeps their task list.";

function firstMateProject(projectId: string, project: ProjectRow | undefined): ProjectBrief {
  return { id: projectId, name: project?.name ?? projectId, description: FIRSTMATE_DESCRIPTION, source: "FirstMate" };
}

/** The user's latest messages the thread detail gives. */
const DETAIL_USER_MESSAGES = 3;

/** Sub-threads whose latest reply is read for the thread detail. */
const DETAIL_CHILD_REPLIES = 20;

/**
 * One thread in more depth: its last few messages from the user, every sub-thread, and the first mate's
 * tasks when it is the first mate. Messages and the latest reply are kept whole; the text renderer decides
 * what fits.
 */
export async function gatherThread(ports: BriefingPorts, threadId: string): Promise<ThreadDetail | null> {
  const row = await ports.thread(threadId);
  if (row === null) return null;
  const problems: string[] = [];
  const title = titleOf(row);
  const [projects, firstMateAll, children, messages, reply] = await Promise.all([
    ports.projects().catch((error: unknown) => {
      problems.push(`Could not list the projects: ${reason(error)}`);
      return [] as ProjectRow[];
    }),
    readFirstMate(ports, problems),
    childRows(ports, [row.id])
      .then((map) => map.get(row.id) ?? [])
      .catch((error: unknown) => {
        problems.push(`Could not read the sub-threads: ${reason(error)}`);
        return [] as ThreadRow[];
      }),
    // One more than shown, since the opening message is not repeated among them.
    readMessages(ports, row.id, DETAIL_USER_MESSAGES + 1, problems, title, Number.POSITIVE_INFINITY),
    ports.latestReply(row.id).catch((error: unknown) => {
      problems.push(`Could not read the whole latest reply of "${title}", so only its opening is given: ${reason(error)}`);
      return null;
    }),
  ]);
  const project = projects.find((candidate) => candidate.id === row.projectId);
  const firstMate = firstMateAll?.threadId === row.id ? firstMateAll : null;
  const budget: ReplyBudget = { replies: DETAIL_CHILD_REPLIES, skipped: 0, failed: [] };
  const childLines = await pool(children, LIMITS.concurrency, async (child): Promise<DetailChild> => {
    const status = child.hasPendingInteraction ? "waiting for an answer" : statusWord(child.status);
    const base = { id: child.id, title: titleOf(child), status };
    if (child.status !== "idle") return { ...base, statusLine: null, unread: null };
    if (budget.replies <= 0) {
      budget.skipped++;
      return { ...base, statusLine: null, unread: "over-limit" };
    }
    budget.replies--;
    try {
      const line = lastLine(await ports.latestReply(child.id));
      return { ...base, statusLine: line === null ? null : clip(plain(line), 200) || null, unread: null };
    } catch (error) {
      budget.failed.push(reason(error));
      return { ...base, statusLine: null, unread: "failed" };
    }
  });
  problems.push(...replyProblems(budget, DETAIL_CHILD_REPLIES));
  const projectBrief = firstMate !== null ? firstMateProject(row.projectId, project) : await readProject(ports, row.projectId, project, [row], problems);
  const thread: ThreadBrief = {
    id: row.id,
    title,
    projectId: row.projectId,
    project: project?.name ?? null,
    status: statusWord(row.status),
    needsUser: row.hasPendingInteraction,
    isFirstMate: firstMate !== null,
    updatedAt: row.updatedAt,
    opening: messages.opening,
    lastUser: messages.recentUser[0] ?? null,
    lastAgent: kept(reply, Number.POSITIVE_INFINITY) ?? messages.lastAgent,
    childCount: children.length,
    flaggedChildren: [],
    uncheckedChildren: childLines.filter((child) => child.unread !== null).length,
  };
  return { thread, project: projectBrief, recentUserMessages: messages.recentUser.slice(0, DETAIL_USER_MESSAGES), children: childLines, firstMate, problems };
}
