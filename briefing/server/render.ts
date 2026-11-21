/**
 * The briefing as text that fits one Handsfree tool result.
 *
 * Handsfree cuts every tool result at 4,000 characters, so the text is rendered at the most detailed
 * level that fits `BUDGET`, dropping detail in a fixed order (`LEVELS`), then whole threads from the
 * least urgent end. Whatever was dropped is named in a "Left out" line, so the voice can say so and ask
 * for `bb briefing thread <id>`. Ids appear in brackets for the voice model's tools; the instructions tell
 * it never to read them aloud.
 */
import type { Briefing, FirstMateBrief, FlaggedChild, TaskLine, ThreadBrief, ThreadDetail } from "./model";
import { clip, sentences } from "./text";

/** Under Handsfree's 4,000, with room for its own "…[truncated]" never to be needed. */
export const BUDGET = 3_900;

export interface Detail {
  /** Sentences and characters per message. */
  sentences: number;
  chars: number;
  /** Sentences and characters per project description; 0 sentences leaves descriptions out. */
  descSentences: number;
  descChars: number;
  /** Items named per FirstMate list before "and N more". */
  listLimit: number;
  doneLimit: number;
  /** The question behind each held task. */
  holdDetail: boolean;
  /** Whose latest user message is shown. */
  lastUser: "all" | "needs-you" | "none";
  /** Threads shown with their messages; the rest get one line each. */
  fullThreads: number;
  /** The reason after a flagged sub-thread's status word (`blocked: <this>`). */
  childDetail: boolean;
  /** Flagged sub-threads named per thread. */
  flaggedLimit: number;
}

const ALL = Number.POSITIVE_INFINITY;

export const LEVELS: readonly Detail[] = [
  { sentences: 2, chars: 260, descSentences: 2, descChars: 260, listLimit: 12, doneLimit: 5, holdDetail: true, lastUser: "all", fullThreads: ALL, childDetail: true, flaggedLimit: 3 },
  { sentences: 1, chars: 180, descSentences: 1, descChars: 180, listLimit: 8, doneLimit: 5, holdDetail: true, lastUser: "all", fullThreads: ALL, childDetail: true, flaggedLimit: 3 },
  { sentences: 1, chars: 140, descSentences: 1, descChars: 140, listLimit: 6, doneLimit: 3, holdDetail: true, lastUser: "needs-you", fullThreads: ALL, childDetail: true, flaggedLimit: 2 },
  { sentences: 1, chars: 120, descSentences: 1, descChars: 120, listLimit: 6, doneLimit: 3, holdDetail: true, lastUser: "needs-you", fullThreads: 8, childDetail: false, flaggedLimit: 2 },
  { sentences: 1, chars: 110, descSentences: 1, descChars: 100, listLimit: 5, doneLimit: 3, holdDetail: true, lastUser: "needs-you", fullThreads: 5, childDetail: false, flaggedLimit: 1 },
  { sentences: 1, chars: 100, descSentences: 0, descChars: 0, listLimit: 4, doneLimit: 2, holdDetail: true, lastUser: "needs-you", fullThreads: 3, childDetail: false, flaggedLimit: 1 },
  { sentences: 1, chars: 90, descSentences: 0, descChars: 0, listLimit: 3, doneLimit: 2, holdDetail: true, lastUser: "needs-you", fullThreads: 1, childDetail: false, flaggedLimit: 1 },
  { sentences: 1, chars: 90, descSentences: 0, descChars: 0, listLimit: 3, doneLimit: 1, holdDetail: false, lastUser: "none", fullThreads: 0, childDetail: false, flaggedLimit: 0 },
];

/** The level after which, rather than dropping more detail, the oldest threads go first, down to `THREAD_FLOOR`. */
const THREADS_BEFORE_DETAIL = 4;
/** Threads kept while detail is dropped from the later levels. */
export const THREAD_FLOOR = 15;

/**
 * Every (level, threads shown) pair in the order they are tried: drop detail through
 * `LEVELS[THREADS_BEFORE_DETAIL]`, then the oldest threads down to `THREAD_FLOOR`, then the remaining
 * detail, then the rest of the threads.
 */
export function* attempts(count: number): Generator<[Detail, number]> {
  for (const detail of LEVELS.slice(0, THREADS_BEFORE_DETAIL + 1)) yield [detail, count];
  const middle = LEVELS[THREADS_BEFORE_DETAIL] as Detail;
  const floor = Math.min(count, THREAD_FLOOR);
  for (let shown = count - 1; shown >= floor; shown--) yield [middle, shown];
  for (const detail of LEVELS.slice(THREADS_BEFORE_DETAIL + 1)) yield [detail, floor];
  const last = LEVELS[LEVELS.length - 1] as Detail;
  for (let shown = floor - 1; shown >= 0; shown--) yield [last, shown];
}

function short(text: string | null, detail: Pick<Detail, "sentences" | "chars">): string | null {
  return text === null ? null : sentences(text, detail.sentences, detail.chars);
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function taskList(lines: readonly TaskLine[], limit: number, withDetail: boolean): string {
  const shown = lines.slice(0, limit).map((line) => (withDetail && line.detail !== null ? `${line.title} (${line.detail})` : line.title));
  const more = lines.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${more} more` : shown.join("; ");
}

export function renderFirstMate(fm: FirstMateBrief, detail: Detail): string[] {
  const lines = ["FirstMate's tasks:"];
  lines.push(`Needs you: ${fm.needsOwner.length === 0 ? "nothing" : taskList(fm.needsOwner, detail.listLimit, detail.holdDetail)}.`);
  lines.push(`Blocked: ${fm.blocked.length === 0 ? "nothing" : taskList(fm.blocked, detail.listLimit, true)}.`);
  if (fm.inFlight.length > 0) lines.push(`In flight: ${taskList(fm.inFlight, detail.listLimit, false)}.`);
  if (fm.queued.length > 0) lines.push(`Queued: ${taskList(fm.queued, detail.listLimit, false)}.`);
  if (fm.done.length > 0 && detail.doneLimit > 0) {
    const shown = fm.done.slice(0, detail.doneLimit).map((line) => line.title);
    const of = fm.done.length > shown.length ? ` (latest ${shown.length} of ${fm.done.length})` : "";
    lines.push(`Done recently${of}: ${shown.join("; ")}.`);
  }
  if (fm.suggestions.length > 0) lines.push(`Suggested next: ${taskList(fm.suggestions.map((title) => ({ title, detail: null })), detail.listLimit, false)}.`);
  return lines;
}

function headline(thread: ThreadBrief): string {
  const facts = [thread.project, thread.status, thread.needsUser ? "needs you" : null].filter((fact): fact is string => fact !== null);
  return `${thread.isFirstMate ? "FirstMate thread: " : ""}${thread.title} (${facts.join(", ")}) [${thread.id}]`;
}

/** The longest reason shown after a flagged sub-thread. */
const CHILD_DETAIL_MAX = 100;

const CHILD_STATE: Record<FlaggedChild["state"], string> = {
  "waiting for an answer": "is waiting for an answer",
  failed: "failed",
  blocked: "is blocked",
  "needs a decision": "needs a decision",
};

function childrenLine(thread: ThreadBrief, limit: number, withDetail: boolean): string | null {
  if (thread.childCount === 0) return null;
  const flagged = thread.flaggedChildren;
  const named = flagged
    .slice(0, limit)
    .map((child) => `${child.title} ${CHILD_STATE[child.state]}${withDetail && child.detail !== null ? ` (${clip(child.detail, CHILD_DETAIL_MAX)})` : ""}`);
  const more = flagged.length - named.length;
  const parts = named.length > 0 ? [named.join("; ")] : [];
  if (more > 0) parts.push(`and ${more} more need attention`);
  // "None blocked" only when every idle one was read: an unread reply may end with `blocked:`.
  if (thread.uncheckedChildren > 0) parts.push(`${thread.uncheckedChildren} could not be checked`);
  else if (flagged.length === 0) parts.push("none blocked");
  return `  ${plural(thread.childCount, "sub-thread")}: ${parts.join("; ")}.`;
}

function fullThread(thread: ThreadBrief, detail: Detail): string[] {
  const lines = [`- ${headline(thread)}`];
  const children = childrenLine(thread, detail.flaggedLimit, detail.childDetail);
  if (children !== null) lines.push(children);
  const opening = short(thread.opening, detail);
  if (opening !== null) lines.push(`  Asked: ${opening}`);
  const showUser = detail.lastUser === "all" || (detail.lastUser === "needs-you" && thread.needsUser);
  const user = showUser ? short(thread.lastUser, detail) : null;
  if (user !== null) lines.push(`  User last: ${user}`);
  const agent = short(thread.lastAgent, detail);
  if (agent !== null) lines.push(`  Agent last: ${agent}`);
  return lines;
}

function compactThread(thread: ThreadBrief): string {
  const flagged = thread.flaggedChildren.length;
  const unchecked = thread.uncheckedChildren > 0 ? `, ${thread.uncheckedChildren} not checked` : "";
  const children = thread.childCount === 0 ? "" : `; ${plural(thread.childCount, "sub-thread")}${flagged > 0 ? `, ${flagged} need attention` : ""}${unchecked}`;
  return `- ${headline(thread).replace(/\) \[/, `${children}) [`)}`;
}

/** What a level dropped against the most detailed one, in plain words. */
function leftOut(briefing: Briefing, detail: Detail, shownThreads: number): string[] {
  const top = LEVELS[0] as Detail;
  const notes: string[] = [];
  if (detail.sentences < top.sentences || detail.chars < top.chars) notes.push("messages cut to their first sentence");
  if (!detail.childDetail && briefing.threads.slice(0, Math.min(detail.fullThreads, shownThreads)).some((thread) => thread.flaggedChildren.some((child) => child.detail !== null))) {
    notes.push("why sub-threads are blocked");
  }
  if (detail.lastUser === "needs-you") notes.push("the user's latest message except where a thread needs you");
  if (detail.lastUser === "none") notes.push("the user's latest messages");
  const full = Math.min(detail.fullThreads, shownThreads);
  if (full < shownThreads) notes.push(`messages of every thread after the first ${full}`);
  if (detail.descSentences === 0 && briefing.projects.some((project) => project.description !== null)) notes.push("project descriptions");
  if (!detail.holdDetail && (briefing.firstMate?.needsOwner.some((line) => line.detail !== null) ?? false)) notes.push("the questions behind held tasks");
  const dropped = briefing.threads.length - shownThreads;
  if (dropped > 0) notes.push(`${plural(dropped, "older thread")}`);
  return notes;
}

function problemLines(problems: readonly string[], max: number): string[] {
  if (problems.length === 0 || max === 0) return [];
  const shown = problems.slice(0, max).map((problem) => clip(problem, 160));
  const more = problems.length - shown.length;
  return [`Problems: ${shown.join(" ")}${more > 0 ? ` And ${more} more.` : ""}`];
}

/** The briefing at one level of detail with the first `shownThreads` threads. */
export function renderAt(briefing: Briefing, detail: Detail, shownThreads: number, problemCount: number): string {
  const threads = briefing.threads.slice(0, shownThreads);
  const needYou = briefing.threads.filter((thread) => thread.needsUser).length;
  const out: string[] = [
    `Briefing: ${plural(briefing.threads.length, "root thread")}${needYou > 0 ? `, ${needYou} ${needYou === 1 ? "needs" : "need"} you` : ""}.`,
  ];
  if (briefing.firstMate !== null) out.push("", ...renderFirstMate(briefing.firstMate, detail));
  if (threads.length > 0) {
    out.push("", "Threads, most urgent first:");
    threads.forEach((thread, index) => {
      out.push(...(index < detail.fullThreads ? fullThread(thread, detail) : [compactThread(thread)]));
    });
  }
  if (detail.descSentences > 0) {
    const shownProjects = new Set(threads.map((thread) => thread.projectId));
    const described = briefing.projects.filter((project) => shownProjects.has(project.id) && project.description !== null);
    if (described.length > 0) {
      out.push("", "Projects:");
      for (const project of described) out.push(`- ${project.name}: ${sentences(project.description ?? "", detail.descSentences, detail.descChars)}`);
    }
  }
  const notes = leftOut(briefing, detail, threads.length);
  out.push("");
  if (notes.length > 0) out.push(`Left out to fit: ${notes.join("; ")}.`);
  out.push(...problemLines(briefing.problems, problemCount));
  out.push("More on one thread: bb briefing thread <id>.");
  return out.join("\n");
}

/**
 * Hard stop for a text no level could fit (a backlog with hundreds of held tasks): the body is cut and
 * the closing lines, from "Left out to fit" on, are kept.
 */
function cut(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const at = text.lastIndexOf("\nLeft out to fit:");
  const footer = at === -1 ? "" : text.slice(at);
  const marker = "\n…[briefing cut to fit]";
  const room = Math.max(0, budget - marker.length - footer.length);
  return `${text.slice(0, room).replace(/\s+\S*$/, "")}${marker}${footer}`.slice(0, budget);
}

/** The most detailed briefing text that fits `budget` characters. */
export function renderBriefing(briefing: Briefing, budget: number = BUDGET): string {
  for (const [detail, shown] of attempts(briefing.threads.length)) {
    const text = renderAt(briefing, detail, shown, 2);
    if (text.length <= budget) return text;
  }
  return cut(renderAt(briefing, LEVELS[LEVELS.length - 1] as Detail, 0, 0), budget);
}

interface DetailLevel {
  opening: number;
  messages: number;
  messageChars: number;
  descSentences: number;
  descChars: number;
  children: number;
  first: Detail;
  /**
   * The latest reply gets whatever room the rest leaves; this is the least of it kept at this level
   * before the next level cuts the rest instead.
   */
  minReply: number;
}

const FULL_FIRST_MATE: Detail = { ...(LEVELS[0] as Detail), listLimit: ALL, doneLimit: ALL };

/** The first level is everything; each later one cuts the rest further so more room is left for the reply. */
const DETAIL_LEVELS: readonly DetailLevel[] = [
  { opening: ALL, messages: 3, messageChars: ALL, descSentences: ALL, descChars: ALL, children: ALL, first: FULL_FIRST_MATE, minReply: ALL },
  { opening: 700, messages: 3, messageChars: 300, descSentences: 3, descChars: 400, children: 15, first: { ...(LEVELS[0] as Detail), listLimit: 15, doneLimit: 10 }, minReply: 1_500 },
  { opening: 450, messages: 2, messageChars: 220, descSentences: 2, descChars: 260, children: 10, first: { ...(LEVELS[1] as Detail), doneLimit: 5 }, minReply: 900 },
  { opening: 250, messages: 1, messageChars: 180, descSentences: 1, descChars: 160, children: 6, first: LEVELS[2] as Detail, minReply: 500 },
  { opening: 160, messages: 1, messageChars: 120, descSentences: 1, descChars: 120, children: 3, first: LEVELS[5] as Detail, minReply: 200 },
];

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** Whether a FirstMate list at this level names fewer items than it has. */
function firstMateCut(fm: FirstMateBrief, detail: Detail): boolean {
  const lists = [fm.needsOwner, fm.blocked, fm.inFlight, fm.queued, fm.suggestions];
  return lists.some((list) => list.length > detail.listLimit) || fm.done.length > detail.doneLimit;
}

/** The thread detail at one level, with the latest reply cut to `replyChars`, and a "Left out" line naming every cut. */
function renderDetailAt(detail: ThreadDetail, level: DetailLevel, replyChars: number): string {
  const { thread } = detail;
  const notes: string[] = [];
  const out = [headline(thread)];
  if (detail.project?.description != null) {
    const about = sentences(detail.project.description, level.descSentences, level.descChars);
    if (about.length < detail.project.description.length) notes.push("the rest of the project's description");
    out.push(`About ${detail.project.name}: ${about}`);
  }
  if (thread.opening !== null) {
    if (thread.opening.length > level.opening) notes.push("the end of the opening message");
    out.push("", `Opening message: ${clip(thread.opening, level.opening)}`);
  }
  const recent = detail.recentUserMessages.slice(0, level.messages);
  if (recent.length > 0) {
    out.push("", "User's latest messages, newest first:");
    for (const message of recent) out.push(`- ${clip(message, level.messageChars)}`);
    if (recent.some((message) => message.length > level.messageChars)) notes.push("the end of the user's longer messages");
  }
  const olderMessages = detail.recentUserMessages.length - recent.length;
  if (olderMessages > 0) notes.push(`the user's ${plural(olderMessages, "older message")}`);
  if (thread.lastAgent !== null) {
    const reply = clip(thread.lastAgent, replyChars);
    if (thread.lastAgent.length > replyChars) {
      notes.push(`the end of the agent's latest reply (the first ${count(reply.length)} of ${count(thread.lastAgent.length)} characters are given)`);
    }
    out.push("", `Agent's latest reply: ${reply}`);
  }
  if (detail.children.length > 0) {
    out.push("", `Sub-threads (${detail.children.length}):`);
    for (const child of detail.children.slice(0, level.children)) {
      const said =
        child.unread === "failed" ? ": its latest reply could not be read" : child.unread === "over-limit" ? ": not checked" : child.statusLine === null ? "" : `: ${clip(child.statusLine, 140)}`;
      out.push(`- ${child.title} (${child.status}) [${child.id}]${said}`);
    }
    const more = detail.children.length - level.children;
    if (more > 0) {
      out.push(`- and ${more} more`);
      notes.push(plural(more, "sub-thread"));
    }
  }
  if (detail.firstMate !== null) {
    out.push("", ...renderFirstMate(detail.firstMate, level.first));
    if (firstMateCut(detail.firstMate, level.first)) notes.push("some of FirstMate's tasks");
  }
  if (notes.length > 0) out.push("", `Left out to fit: ${notes.join("; ")}.`);
  out.push(...problemLines(detail.problems, 2));
  return out.join("\n");
}

/**
 * One thread in depth: everything when it fits `budget`; otherwise, at the first level whose cuts leave the
 * latest reply at least that level's `minReply`, the reply gets all the room the rest leaves.
 */
export function renderThread(detail: ThreadDetail, budget: number = BUDGET): string {
  const reply = detail.thread.lastAgent;
  for (const level of DETAIL_LEVELS) {
    const whole = renderDetailAt(detail, level, ALL);
    if (whole.length <= budget) return whole;
    if (reply === null) continue;
    // Shrink the reply by what is over, plus room for the "Left out" note its cut adds.
    let chars = reply.length - (whole.length - budget) - 120;
    while (chars >= Math.min(level.minReply, reply.length) && chars < reply.length) {
      const text = renderDetailAt(detail, level, chars);
      if (text.length <= budget) return text;
      chars -= text.length - budget;
    }
  }
  const last = DETAIL_LEVELS[DETAIL_LEVELS.length - 1] as DetailLevel;
  return cut(renderDetailAt(detail, last, last.minReply), budget);
}
