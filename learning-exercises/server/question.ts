/**
 * What the server can check of a question before showing it. A question must stand on its own: the card
 * is all the learner sees while answering, and bb folds a turn's earlier messages away, so code the
 * question relies on travels inside it as a fenced block. Whether a question leans on something it does
 * not contain cannot be told from its text; what can be told is that its code blocks close and that it
 * fits.
 */
import { QUESTION_MAX_CHARS } from "../shared/types";

/** A CommonMark fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The line a fenced code block opens on (1-based) when it never closes; null when every block closes. */
export function unclosedFence(markdown: string): number | null {
  let open: { char: string; length: number; line: number } | null = null;
  const lines = markdown.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line);
    if (match === null) continue;
    const marker = match[1]!;
    const rest = match[2]!;
    if (open === null) {
      // A backtick fence's info string may not hold a backtick; then it is inline code, not a fence.
      if (marker[0] === "`" && rest.includes("`")) continue;
      open = { char: marker[0]!, length: marker.length, line: index + 1 };
    } else if (marker[0] === open.char && marker.length >= open.length && rest.trim() === "") {
      open = null;
    }
  }
  return open?.line ?? null;
}

/** Why a question cannot be shown as it is, said to the agent; null when it can. */
export function questionProblem(question: string): string | null {
  if (question.length > QUESTION_MAX_CHARS) {
    return `The question is ${question.length.toLocaleString("en-US")} characters; the card takes at most ${QUESTION_MAX_CHARS.toLocaleString("en-US")}. Shorten it: keep only the code the question needs, and point at files for the rest.`;
  }
  const line = unclosedFence(question);
  if (line !== null) {
    return `The question's code block opened on line ${line} never closes, so the rest of the question would show as code. Close it with a fence like the one that opened it and ask again.`;
  }
  return null;
}
