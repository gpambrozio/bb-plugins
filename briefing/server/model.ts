/**
 * The briefing as data: what `bb briefing --json` prints and what the text renderer (`render.ts`) budgets.
 * Everything here is already read, filtered and cleaned; nothing in it is fetched lazily.
 */

/** A sub-thread that needs someone: the only children the briefing names. */
export interface FlaggedChild {
  id: string;
  title: string;
  /** Why it is named, in plain words. */
  state: "waiting for an answer" | "failed" | "blocked" | "needs a decision";
  /** The rest of its status line (`blocked: <this>`), cleaned, when it gave one. */
  detail: string | null;
}

export interface ThreadBrief {
  id: string;
  title: string;
  projectId: string;
  project: string | null;
  /** bb's status in plain words: working, idle, failed, starting, … */
  status: string;
  /** A question or form is waiting for the user in this thread. */
  needsUser: boolean;
  isFirstMate: boolean;
  updatedAt: number;
  /** The first message the user sent, cleaned. */
  opening: string | null;
  /** The latest message the user sent, cleaned; null when it is the opening one. */
  lastUser: string | null;
  /** The agent's latest reply, cleaned. */
  lastAgent: string | null;
  /** Every sub-thread below it, at any depth, that is not archived. */
  childCount: number;
  flaggedChildren: FlaggedChild[];
}

export interface ProjectBrief {
  id: string;
  name: string;
  /** The opening of its AGENTS.md, CLAUDE.md or README, cleaned; null when none could be read. */
  description: string | null;
  /** Which file the description came from. */
  source: string | null;
}

export interface TaskLine {
  title: string;
  /** A short reason or question, in plain words: the hold, "waits on another task", "worker failed". */
  detail: string | null;
}

/** The first mate's tasks by state, from firstmate-crew's board. */
export interface FirstMateBrief {
  threadId: string;
  needsOwner: TaskLine[];
  blocked: TaskLine[];
  inFlight: TaskLine[];
  queued: TaskLine[];
  /** Newest first. */
  done: TaskLine[];
  /** The first mate's suggested next steps, by label. */
  suggestions: string[];
}

export interface Briefing {
  generatedAt: number;
  /** Most urgent first: needs the user, then the first mate, then most recently updated. */
  threads: ThreadBrief[];
  /** The projects of the threads above, in the order they first appear there. */
  projects: ProjectBrief[];
  firstMate: FirstMateBrief | null;
  /** What could not be read, in plain words (an offline machine, FirstMate not installed). */
  problems: string[];
}

export interface ThreadDetail {
  thread: ThreadBrief;
  project: ProjectBrief | null;
  /** Newest first, the latest included. */
  recentUserMessages: string[];
  children: { id: string; title: string; status: string; statusLine: string | null }[];
  firstMate: FirstMateBrief | null;
  problems: string[];
}
