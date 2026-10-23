/**
 * Where a thread belongs in the diff on screen now. Comments on uncommitted code go stale as the agent
 * edits it, so a thread keeps the text of the lines it was made on (`anchorContent`), as diffity's do,
 * and is looked for again each time the diff loads:
 *
 * - `anchored`: the same text is still at the same lines.
 * - `moved`: the text is somewhere else on the same side; the thread is shown there.
 * - `outdated`: the text is gone, or its file left the diff; the tab lists the thread apart, with the
 *   lines it was made on.
 *
 * Nothing is written back: the stored lines stay the ones the comment was made on, which is what the
 * agent is told.
 */
import { linesText, type PatchLines } from "./patch-lines";
import { GENERAL_PATH, type ReviewThread } from "./types";

export type Placement =
  | { state: "anchored" | "moved"; startLine: number; endLine: number }
  | { state: "outdated" };

type Anchorable = Pick<ReviewThread, "filePath" | "side" | "startLine" | "endLine" | "anchorContent">;

/** Places `thread` against its file's current lines; `lines` is undefined when the file is not in the diff. */
export function placeThread(thread: Anchorable, lines: PatchLines | undefined): Placement {
  if (thread.filePath === GENERAL_PATH) return { state: "anchored", startLine: 0, endLine: 0 };
  if (lines === undefined) return { state: "outdated" };
  if (thread.startLine === 0 || thread.side === null) return { state: "anchored", startLine: 0, endLine: 0 };

  const here = linesText(lines, thread.side, thread.startLine, thread.endLine);
  if (thread.anchorContent === null) {
    return here === null ? { state: "outdated" } : { state: "anchored", startLine: thread.startLine, endLine: thread.endLine };
  }
  if (here === thread.anchorContent) return { state: "anchored", startLine: thread.startLine, endLine: thread.endLine };
  // Blank lines are everywhere; finding "the same" one elsewhere would be a guess.
  if (thread.anchorContent.trim() === "") return { state: "outdated" };

  const length = thread.endLine - thread.startLine;
  const map = thread.side === "old" ? lines.old : lines.new;
  let best: number | null = null;
  for (const start of map.keys()) {
    if (linesText(lines, thread.side, start, start + length) !== thread.anchorContent) continue;
    if (best === null || Math.abs(start - thread.startLine) < Math.abs(best - thread.startLine)) best = start;
  }
  return best === null ? { state: "outdated" } : { state: "moved", startLine: best, endLine: best + length };
}
