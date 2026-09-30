/**
 * What the board draws from a loaded board, decided without React so it can be
 * tested: which columns show, which cards they hold, and the words on pills.
 */
import type {
  Board,
  BoardColumn,
  BoardItem,
  BranchStatus,
  CheckSummary,
  ColumnId,
  ItemDetails,
  LinkedIssue,
} from "../shared/board";

/** Every repository with a card in any column, filtered out or not. */
export function repositoriesOf(board: Board | null): string[] {
  const seen = new Set<string>();
  for (const column of board?.columns ?? []) {
    for (const item of column.items) {
      if (item.repository !== "") seen.add(item.repository);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The columns as drawn:
 *
 * 1. The repository filter hides cards.
 * 2. An issue a pull request closes is dropped from Issues and shown as a pill
 *    on that pull request — one piece of work, one card. Drafts claim too.
 *    This runs *after* the filter, so a pull request the filter hides stops
 *    claiming its issue instead of taking the issue's card off the board with it.
 * 3. A column left empty comes off the board, unless it failed: then the
 *    emptiness is the error, and the error is the only thing saying so. When
 *    that would leave nothing at all, every column comes back — four empty
 *    columns read as a board that loaded and found nothing, where a blank page
 *    reads as a broken one.
 */
export function visibleColumns(board: Board | null, hidden: ReadonlySet<string>): BoardColumn[] {
  if (board === null) return [];
  const filtered =
    hidden.size === 0
      ? board.columns
      : board.columns.map((column) => ({
          ...column,
          items: column.items.filter((item) => !hidden.has(item.repository)),
        }));

  const claimed = new Set<string>();
  for (const column of filtered) {
    if (column.id !== "draft-prs" && column.id !== "open-prs") continue;
    for (const item of column.items) {
      for (const issue of item.linkedIssues) claimed.add(issue.id);
    }
  }
  const folded =
    claimed.size === 0
      ? filtered
      : filtered.map((column) =>
          column.id === "issues"
            ? { ...column, items: column.items.filter((item) => !claimed.has(item.id)) }
            : column,
        );

  const populated = folded.filter((column) => column.items.length > 0 || column.error !== null);
  return populated.length > 0 ? populated : folded;
}

/** Applies an edit to one card wherever it is on the board. */
export function patchBoard(board: Board, itemId: string, patch: Partial<BoardItem>): Board {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      items: column.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    })),
  };
}

/** The card with this id on the board, wherever it is. */
export function findItem(board: Board | null, itemId: string): { item: BoardItem; column: ColumnId } | null {
  for (const column of board?.columns ?? []) {
    const item = column.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) return { item, column: column.id };
  }
  return null;
}

/**
 * The repository is spelled out only when the issue lives somewhere other than
 * the pull request; within one repository the number alone is how GitHub reads.
 */
export function linkedIssueLabel(issue: LinkedIssue, repository: string): string {
  return issue.repository === repository || issue.repository === ""
    ? `Issue #${issue.number}`
    : `Issue ${issue.repository}#${issue.number}`;
}

/** The three counts in words, for the pill group's accessible label. */
export function checksSentence(checks: CheckSummary): string {
  const parts: string[] = [];
  if (checks.passed > 0) parts.push(`${checks.passed} passed`);
  if (checks.failed > 0) parts.push(`${checks.failed} failed`);
  if (checks.pending > 0) parts.push(`${checks.pending} running`);
  return parts.join(", ");
}

/**
 * The branch status worth a pill, or null for a branch that is up to date.
 * Conflicts count on their own: the pill must not depend on the count to say so.
 */
export function staleBranch(branch: BranchStatus | null): BranchStatus | null {
  return branch !== null && (branch.behindBy > 0 || branch.conflicts) ? branch : null;
}

export function behindSentence(branch: BranchStatus): string {
  const behind = `${branch.behindBy} ${branch.behindBy === 1 ? "commit" : "commits"} behind`;
  return branch.conflicts ? `${behind}, with conflicts` : behind;
}

/** Why an update was not sent, from the last look the server took. */
export function notUpdatedReason(branch: BranchStatus): string {
  if (branch.conflicts) return "This branch has conflicts to resolve first.";
  if (branch.behindBy === 0) return "This branch is already up to date.";
  return "This account cannot update this branch.";
}

export function kindLabel(column: ColumnId): string {
  if (column === "issues") return "Issue";
  if (column === "discussions") return "Discussion";
  return "Pull request";
}

export function stateLabel(state: ItemDetails["state"]): string {
  return { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" }[state];
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(then).toLocaleDateString();
}

export function absoluteDate(iso: string): string {
  const then = Date.parse(iso);
  return Number.isNaN(then)
    ? ""
    : new Date(then).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A label colour is six hex digits from GitHub; anything else is not painted. */
export function labelColor(color: string | undefined): string | null {
  return color !== undefined && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;
}
