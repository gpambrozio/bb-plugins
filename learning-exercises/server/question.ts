/**
 * What the server can check of a question before showing it. A question must stand on its own: the card
 * is all the learner sees while answering, and bb folds a turn's earlier messages away, so code the
 * question relies on travels inside it as a fenced block. Whether a question leans on something it does
 * not contain cannot be told from its text; what can be told is that its code blocks close and that it
 * fits.
 */
import { parse, postprocess, preprocess } from "micromark";

import { QUESTION_MAX_CHARS } from "../shared/types";

/**
 * The line a fenced code block opens on (1-based) when it never closes; null when every block closes.
 * micromark parses the question as CommonMark does, containers included (list items, block quotes, their
 * indentation), and marks each fence of a fenced block with a `codeFencedFence` token: a block that
 * closes has two, one left open (it runs to the end of its container) has only its opening fence.
 */
export function unclosedFence(markdown: string): number | null {
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)));
  const open: { line: number; fences: number }[] = [];
  for (const [kind, token] of events) {
    if (token.type === "codeFenced") {
      if (kind === "enter") open.push({ line: token.start.line, fences: 0 });
      else {
        const block = open.pop();
        if (block !== undefined && block.fences < 2) return block.line;
      }
    } else if (token.type === "codeFencedFence" && kind === "enter") {
      const block = open.at(-1);
      if (block !== undefined) block.fences += 1;
    }
  }
  return null;
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
