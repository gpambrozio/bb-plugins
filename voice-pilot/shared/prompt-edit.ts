/**
 * An edit of the voice's own instructions (the owner's **Instructions** setting), proposed by the voice and
 * never applied by it: it is staged, one at a time, until the owner applies it as is, applies it after a tweak,
 * or rejects it on the Voice page. An applied edit is the setting from then on, so it reaches the next session;
 * a session in progress keeps the instructions it started with.
 *
 * Shared by the server and the app. The app reads the staged edit with `experimental_useRpcQuery`, which takes
 * the contract as a value, so this module imports the SDK as types only (bb provides the SDK root to the server
 * bundle, not the app's).
 */
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The tag the staged-edit read carries; the server invalidates it whenever the staged edit changes. */
export const PROMPT_EDIT_TAG = "prompt-edit";
/** The longest instructions an edit may make. */
export const PROMPT_MAX = 20_000;
export const SUMMARY_MAX = 300;

/** One change: `find` must occur exactly once in the instructions; an empty `find` appends `replace` at the end. */
export const PromptChangeSchema = z.object({ find: z.string().max(PROMPT_MAX), replace: z.string().max(PROMPT_MAX) });
export type PromptChange = z.infer<typeof PromptChangeSchema>;

export const StagedEditSchema = z.object({
  id: z.string().min(1).max(64),
  /** The instructions as the edit would make them. */
  proposed: z.string().max(PROMPT_MAX),
  /** The instructions the edit was made against. */
  base: z.string().max(PROMPT_MAX),
  /** The voice's one-line reason, in the owner's words where it can. */
  summary: z.string().max(SUMMARY_MAX),
  stagedAt: z.number(),
  /** The edit this one replaced, when one was waiting. */
  replaced: z.object({ summary: z.string().max(SUMMARY_MAX), stagedAt: z.number() }).nullable(),
});
export type StagedEdit = z.infer<typeof StagedEditSchema>;

export const promptContract = {
  /** The staged edit, if any, and the instructions now in force (the default when the setting is blank). */
  "prompt.staged": {
    input: z.object({}),
    output: z.object({ staged: StagedEditSchema.nullable(), current: z.string() }),
    tags: () => [PROMPT_EDIT_TAG],
  },
  /** Applies staged edit `id`, as staged or as the owner tweaked it (`text`). Refused when another edit replaced it. */
  "prompt.apply": { input: z.object({ id: z.string().min(1).max(64), text: z.string().max(PROMPT_MAX).optional() }), output: z.object({ applied: z.literal(true) }) },
  /** Drops staged edit `id`, leaving the instructions as they are. */
  "prompt.reject": { input: z.object({ id: z.string().min(1).max(64) }), output: z.null() },
} satisfies PluginRpcContract;

/**
 * The instructions with `changes` made, in order. Throws, naming the change, when a `find` is missing or occurs
 * more than once, so the voice can say what went wrong and try again.
 */
export function applyChanges(current: string, changes: readonly PromptChange[]): string {
  let text = current;
  changes.forEach((change, index) => {
    const which = changes.length === 1 ? "The change" : `Change ${index + 1}`;
    if (change.find === "") {
      text = text.trimEnd() === "" ? change.replace : `${text.trimEnd()}\n\n${change.replace}`;
      return;
    }
    const at = text.indexOf(change.find);
    if (at < 0) throw new Error(`${which} looks for text that is not in the instructions: quote them exactly, or append with an empty find.`);
    if (text.indexOf(change.find, at + 1) >= 0) throw new Error(`${which} looks for text that occurs more than once: quote more of it.`);
    text = text.slice(0, at) + change.replace + text.slice(at + change.find.length);
  });
  return text;
}

type Op = { kind: " " | "-" | "+"; line: string };

/** The line-by-line edit from `a` to `b` (longest common subsequence). */
function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++]! });
  while (j < m) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}

/**
 * A unified patch from `before` to `after` for one file, as bb's diff view takes it: `---`/`+++` headers and
 * hunks with `context` lines around each change. Empty when they are the same.
 */
export function unifiedPatch(before: string, after: string, path: string, context = 3): string {
  const ops = lineOps(lines(before), lines(after));
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return "";
  // Group changes whose context would touch into one hunk.
  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const last = groups.at(-1);
    if (last !== undefined && index - last[1] <= context * 2 + 1) last[1] = index;
    else groups.push([index, index]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length - 1, last + context);
    // Line numbers before the hunk, on each side.
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") oldLine += 1;
      if (op.kind !== "-") newLine += 1;
    }
    const body = ops.slice(start, end + 1);
    const oldCount = body.filter((op) => op.kind !== "+").length;
    const newCount = body.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
    for (const op of body) out.push(`${op.kind}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}

/** How many lines an edit adds and removes, for a one-line summary. */
export function changeCounts(before: string, after: string): { added: number; removed: number } {
  const ops = lineOps(lines(before), lines(after));
  return { added: ops.filter((op) => op.kind === "+").length, removed: ops.filter((op) => op.kind === "-").length };
}
