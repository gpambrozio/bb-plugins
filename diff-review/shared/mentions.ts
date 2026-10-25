/**
 * `@reviewer` or `@agent` in a comment, outside code: the user asks the view's AI reviewer about the
 * comment thread. Both words mean the same. Provider names (`@claude`, …) start nothing.
 *
 * Ported from diffity's `src/lib/mentions.ts` (https://github.com/nilbuild/diffity), Copyright (c)
 * 2026 Kamran Ahmed, MIT License — see THIRD_PARTY_NOTICES.md. Same rules: case-insensitive, whole
 * word, not inside a fenced block or an inline code span, not part of an email address or a path.
 */

/** The words that ask the view's reviewer. */
export const REVIEWER_HANDLES = ["reviewer", "agent"] as const;

function stripCode(body: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const closes = marker !== null && marker[1]![0] === fence.ch && marker[1]!.length >= fence.len && line.trim() === marker[1];
      if (closes) fence = null;
      out.push("");
      continue;
    }
    if (marker !== null) {
      fence = { ch: marker[1]![0]!, len: marker[1]!.length };
      out.push("");
      continue;
    }
    out.push(line.replace(/(`+)[\s\S]*?\1(?!`)/g, " "));
  }
  return out.join("\n");
}

const HANDLES = REVIEWER_HANDLES.join("|");
const MENTION = new RegExp(`(^|[^\\p{L}\\p{N}_\\-@./])(@(${HANDLES}))(?![\\p{L}\\p{N}_\\-@/]|\\.[\\p{L}\\p{N}_-])`, "iu");

/** Whether the comment asks the reviewer: `@reviewer` or `@agent`, outside code. */
export function mentionsReviewer(body: string): boolean {
  return MENTION.test(stripCode(body));
}
