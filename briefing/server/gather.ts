/**
 * Reading the briefing from bb through `BriefingPorts`. One thread, project or machine that cannot be
 * read leaves a gap and a line in `problems`; it never fails the whole briefing.
 */
import { describe, DESCRIPTION_FILES } from "./description";
import { groupFleet } from "./firstmate";
import { flaggedStatusLine, lastLine, userMessages } from "./messages";
import type { Briefing, FirstMateBrief, FlaggedChild, ProjectBrief, ThreadBrief, ThreadDetail } from "./model";
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

function kept(text: string | null): string | null {
  if (text === null) return null;
  const cleaned = plain(text);
  return cleaned === "" ? null : clip(cleaned, LIMITS.messageChars);
}

interface Messages {
  opening: string | null;
  /** Newest first; the opening one left out. */
  recentUser: string[];
  lastAgent: string | null;
}

/** The thread's opening message, its latest `want` messages from the user, and its agent's latest message. */
export async function readMessages(ports: BriefingPorts, threadId: string, want: number, problems: string[], name: string): Promise<Messages> {
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
    .map((message) => kept(message.text))
    .filter((text): text is string => text !== null);
  return { opening: kept(openingEvent?.text ?? null), recentUser, lastAgent: kept(agent) };
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

/** The project's description from the first of its files that has one, on the first machine that answers. */
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
    try {
      for (const file of DESCRIPTION_FILES) {
        const text = await ports.readFile(place.hostId, `${place.path.replace(/\/+$/, "")}/${file}`);
        const description = text === null ? null : describe(text);
        if (description !== null) return { id: projectId, name, description: clip(description, LIMITS.messageChars), source: file };
      }
      return { id: projectId, name, description: null, source: null };
    } catch (error) {
      lastError = reason(error);
    }
  }
  if (lastError !== null) problems.push(`Could not read the files of project "${name}": ${lastError}`);
  return { id: projectId, name, description: null, source: null };
}

/** Why a sub-thread is worth naming, or null when it is not. Reads its latest reply only when it is idle. */
async function flagOf(ports: BriefingPorts, row: ThreadRow, budget: { replies: number; skipped: number }): Promise<FlaggedChild | null> {
  const base = { id: row.id, title: titleOf(row) };
  if (row.hasPendingInteraction) return { ...base, state: "waiting for an answer", detail: null };
  if (row.status === "error") return { ...base, state: "failed", detail: null };
  if (row.status !== "idle") return null;
  if (budget.replies <= 0) {
    budget.skipped++;
    return null;
  }
  budget.replies--;
  const line = flaggedStatusLine(await ports.latestReply(row.id).catch(() => null));
  if (line === null) return null;
  const detail = plain(line.detail);
  return { ...base, state: line.state, detail: detail === "" ? null : clip(detail, 200) };
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

  const budget = { replies: LIMITS.childReplies, skipped: 0 };
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
      flaggedChildren: flags.filter((flag): flag is FlaggedChild => flag !== null),
    };
  });
  threads.sort(compareThreads);
  if (budget.skipped > 0) {
    problems.push(`Only ${LIMITS.childReplies} idle sub-threads were checked for a blocked status line; ${budget.skipped} were not.`);
  }

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

/** One thread in more depth: its last few messages from the user, every sub-thread, and the first mate's tasks when it is the first mate. */
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
    readMessages(ports, row.id, DETAIL_USER_MESSAGES + 1, problems, title),
    ports.latestReply(row.id).catch(() => null),
  ]);
  const project = projects.find((candidate) => candidate.id === row.projectId);
  const firstMate = firstMateAll?.threadId === row.id ? firstMateAll : null;
  let replies = DETAIL_CHILD_REPLIES;
  const childLines = await pool(children, LIMITS.concurrency, async (child) => {
    let statusLine: string | null = null;
    if (child.status === "idle" && replies > 0) {
      replies--;
      const line = lastLine(await ports.latestReply(child.id).catch(() => null));
      statusLine = line === null ? null : clip(plain(line), 200) || null;
    }
    const status = child.hasPendingInteraction ? "waiting for an answer" : statusWord(child.status);
    return { id: child.id, title: titleOf(child), status, statusLine };
  });
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
    lastAgent: kept(reply) ?? messages.lastAgent,
    childCount: children.length,
    flaggedChildren: [],
  };
  return { thread, project: projectBrief, recentUserMessages: messages.recentUser.slice(0, DETAIL_USER_MESSAGES), children: childLines, firstMate, problems };
}
