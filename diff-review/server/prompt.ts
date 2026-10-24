/**
 * The message "Send to agent" puts in the thread under review.
 *
 * Adapted from diffity's `src-tauri/prompts/review-feedback.md` and `resolve.md`
 * (https://github.com/nilbuild/diffity), Copyright (c) 2026 Kamran Ahmed, MIT License — see
 * THIRD_PARTY_NOTICES.md. The writing rules, the rejected-edit rules and the per-thread instructions
 * are diffity's; the tools are `bb diff-review` commands instead of diffity's MCP server, and the
 * threads are written into the message, so the agent needs no call to read them.
 */
import { describeLocation, describeTarget, GENERAL_PATH, type ReviewThread, type Target } from "../shared/types";

/** The command an agent answers with; the skill in `skills/diff-review` says the same. */
export const CLI = "bb diff-review";

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function threadSection(thread: ReviewThread): string {
  const facts = [describeLocation(thread)];
  if (thread.severity !== null) facts.push(thread.severity);
  const lines = [`### Thread \`${thread.id}\` — ${facts.join(" · ")}`, ""];
  if (thread.filePath !== GENERAL_PATH && thread.startLine > 0 && thread.anchorContent !== null) {
    lines.push("Commented code, as it read then:", "", "```", thread.anchorContent, "```", "");
  }
  for (const comment of thread.comments) {
    const who = comment.authorType === "user" ? "User" : `Agent (${comment.authorName})`;
    lines.push(`**${who}:**`, "", quote(comment.body), "");
  }
  return lines.join("\n").trimEnd();
}

export interface SendPromptInput {
  target: Target;
  threads: readonly ReviewThread[];
  note: string;
}

export function sendPrompt({ target, threads, note }: SendPromptInput): string {
  const ids = threads.map((thread) => `\`${thread.id}\``).join(", ");
  const summary = note.trim() === "" ? "" : `\n## Review summary\n\n${note.trim()}\n`;
  return `# Address review comments

The user reviewed ${describeTarget(target)} in this workspace with Diff Review and wants you to address their comments: answer questions, make the requested code changes, and report back in each thread with the \`${CLI}\` command.

- Diff: ${describeTarget(target)}
- Threads in this review, in order: ${ids}
${summary}
## Threads

${threads.map(threadSection).join("\n\n")}

## Commands

Report back only with \`${CLI}\`; the user reads your answers in the Review tab, next to the code. Text goes in as one line of base64, so quotes, backticks and new lines arrive as written:

\`\`\`sh
base64 <<'DIFF_REVIEW_END' | tr -d '\\n' | ${CLI} reply <thread-id> --text-base64-stdin
<your reply>
DIFF_REVIEW_END
\`\`\`

- \`${CLI} reply <thread-id> --text-base64-stdin\` — answer in a thread; it stays open.
- \`${CLI} resolve <thread-id> --text-base64-stdin\` — mark a thread resolved, with a summary of what you changed.
- \`${CLI} dismiss <thread-id> --text-base64-stdin\` — close a thread you will not act on, with the reason.
- \`${CLI} list\` — the threads sent to you, with every comment, if you need them again.

Thread ids accept unique prefixes.

## Rejected edits

A file write may be shown to the user, who can allow or reject it. A rejected write means the user does NOT want that change.
- Never \`resolve\` a thread (and never write "Fixed: …") unless your edit for it was actually applied. If any write for a thread is rejected, stop editing for that thread: make no further edits for it (not a retry, not the remaining parts of the same change, not another route to it).
- Instead \`reply\` on the thread: say the edit was rejected, describe the change you proposed, and ask how they would like to proceed. Leave the thread open.

## How to write comments

The user reads your replies and summaries in a small box next to the code. Write in simple English: short sentences, common words, no filler.

- \`resolve\` summary: one sentence, under 15 words, saying what changed. Example: "Fixed: accept http as well as https." Do not list every file or test; the diff shows that.
- \`reply\`: answer in 1-3 sentences (about 50 words at most). Cite \`path:line\` instead of quoting code.
- If you disagree with a comment, say why in one or two sentences and leave the thread open.
- Do not repeat the comment back or explain background the user already knows.

## Instructions

1. Handle the threads above in order. The latest user comment in each is what you respond to; earlier comments are context.
2. Read the file around the commented lines (the old side means removed code, visible only in the diff). A whole-file thread is about the file; a whole-diff thread is about the whole change.
   a. **Question or discussion**: answer with \`reply\`, grounded in code you actually read (cite \`path:line\`). Do not edit files for it and leave the thread open.
   b. **Change request** (including questions like "can we rename this?"): make the minimal change, then \`resolve\` the thread with a one-line summary like "Fixed: <what changed>".
   c. **Unclear**: \`reply\` with a specific clarifying question instead of guessing.
   d. If an edit is rejected, follow **Rejected edits** above: do not retry it and do not \`resolve\`; \`reply\` explaining what you would change and leave the thread open.
3. Leave exactly one response per thread (a \`reply\`, the \`resolve\` summary, or a \`dismiss\` reason).
4. If the review summary asks for something no thread covers, do it too (same rules) and mention it in your final message.
5. Finish with a short summary here: threads resolved, answered, left open after a rejected edit, awaiting clarification, dismissed.
`;
}
