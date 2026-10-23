/**
 * The first messages of the threads AI runs start in: a review, an answer to an @-mention, and a fix
 * in a new thread.
 *
 * Adapted from diffity's `src-tauri/prompts/review.md` and `thread.md`
 * (https://github.com/nilbuild/diffity), Copyright (c) 2026 Kamran Ahmed, MIT License — see
 * THIRD_PARTY_NOTICES.md. The review steps, what to flag, the validation pass, the writing rules and
 * the rejected-edit rules are diffity's; the tools are this plugin's `diff_review_*` tools, with the
 * `bb diff-review` command as the way back when a tool is missing.
 */
import { describeLocation, describeTarget, type ReviewThread, type Target } from "../shared/types";
import { CLI, sendPrompt } from "./prompt";
import { TOOL } from "./tool-names";

const WRITING = `## How to write comments

Comments show in a small box next to the code, and the reader is busy. Write in simple English: short sentences, common words, no filler.

- Say what is wrong and what to do, in 1-3 sentences (about 50 words at most). Lead with the problem.
- Cite \`path:line\` instead of quoting code or walking through it. Do not explain things the author already knows.
- For a project-rule violation, quote the rule in a few words.`;

const REJECTED = `## Rejected edits

A file write may be shown to the user, who can allow or reject it. A rejected write means the user does NOT want that change.
- Never resolve a thread (and never write "Fixed: …") unless your edit for it was actually applied. If any write for a thread is rejected, stop editing for that thread: make no further edits for it (not a retry, not the remaining parts of the same change, not another route to it).
- Instead reply on the thread: say the edit was rejected, describe the change you proposed, and ask how they would like to proceed. Leave the thread open.`;

function fallback(commands: string): string {
  return `If a \`diff_review_*\` tool is not available in this session, use the \`${CLI}\` command instead (${commands}); the \`diff-review\` skill describes it. Text goes to it as one line of base64 through \`--text-base64-stdin\`.`;
}

/** How to read a view's diff with git, for the agent. */
export function gitCommandFor(target: Target): string {
  switch (target.kind) {
    case "uncommitted":
      return "`git diff HEAD`, plus the untracked files `git status --porcelain` lists";
    case "branch":
      return `\`git diff ${target.base}...HEAD\``;
    case "all":
      return `\`git diff $(git merge-base ${target.base} HEAD)\`, plus the untracked files \`git status --porcelain\` lists`;
    case "commit":
      return `\`git show ${target.sha}\``;
  }
}

export interface ReviewPromptInput {
  target: Target;
  focus: string | null;
  instructions: string;
}

export function reviewPrompt({ target, focus, instructions }: ReviewPromptInput): string {
  const extra = instructions.trim() === "" ? "" : `\n## Instructions from the user\n\n${instructions.trim()}\n`;
  return `# Review

You are reviewing a diff with Diff Review and leaving review comments with its tools. The user reads them in the Review tab, next to the code.

- Diff under review: ${describeTarget(target)}, in this workspace — read it with ${gitCommandFor(target)}
- Focus: ${focus ?? "none — apply every pass"}
${extra}
## Tools

- \`${TOOL.threads}\` — existing review threads, so you do not duplicate them.
- \`${TOOL.comment}\` — an inline comment: \`file\`, \`startLine\`, optional \`endLine\` (defaults to \`startLine\`), optional \`side\` (\`new\` by default, \`old\` for removed lines), \`body\`, \`severity\`. \`startLine\` 0 comments on the whole file. Lines must be shown in the diff; the tool says which are when one is not.
- \`${TOOL.generalComment}\` — a comment about the whole diff.
- \`${TOOL.reply}\`, \`${TOOL.resolve}\`, \`${TOOL.dismiss}\` — act on an existing thread by id.

${fallback(`\`list\`, \`comment\`, \`reply\`, \`resolve\`, \`dismiss\``)}

Read the diff with git as above, and files as you need. **Do not edit files, and do not run commands that change the repository.** Diff Review lists every file that changes in this workspace while you review, so the user will see any edit.

## Step 1: Understand the change

1. Read the diff. Call \`${TOOL.threads}\` so you do not duplicate existing comments.
2. Find and read the relevant project instruction files — the root \`CLAUDE.md\` / \`AGENTS.md\` and any in directories containing modified files. They define project-specific rules the diff must follow.
3. Gauge the diff size and plan your approach. Every file gets a thorough review regardless of size — only the organization differs:
   - **Small** (under ~100 changed lines, 1-3 files): review each file in order.
   - **Medium** (100-500 lines, 3-10 files): group files by area (backend, frontend, tests, config). Review core logic first so you understand intent before the ripple effects.
   - **Large** (500+ lines or 10+ files): group by area, start with core logic, then review every remaining file. For mechanically repetitive changes, verify the pattern on the first instances, then check every remaining instance for deviations.

   Read and review every changed file. Do not skip or spot-check.
4. Summarize the change for yourself before looking for problems: what is it trying to accomplish, which files are structural vs. core logic, what did the author intend (read \`git log\` for the range when useful), and what constraints were they working within. Intent separates deliberate behaviour from real bugs.
5. For each changed file, read the entire file, not just the hunks.
6. Cross-reference callers and dependents. For any changed signature, renamed export, modified return type or altered behaviour, search for usages. Will callers handle the new value, error or null case? Will imports still resolve? Do type changes propagate?

## Step 2: Analyze

If a focus was given, concentrate on it; otherwise apply every pass.

**Data flow** — Can a value be null where the code assumes it isn't? Are all branches of an upstream conditional handled? Do callers handle a changed return shape? Did the diff move code outside a narrowing check?

**State and lifecycle** — Unreachable or inescapable states? Listeners, subscriptions, handles still cleaned up on every path? Concurrent access corrupting shared state? Init-before-use ordering preserved?

**Contracts** — Does the function still satisfy its callers (read them, don't guess)? Interface conformance? Pre/post-conditions? API response shapes vs. clients?

**Boundaries** — User input validated? Malformed external data crashing or corrupting state? Injection vectors (SQL, shell, XSS, path traversal)?

**Edge cases** — only ones that will happen in practice: empty collections/strings, zero, negatives, off-by-one, overflow, division by zero from input.

**Completeness** — New behaviour without tests (\`suggestion\`)? Bug fix without a regression test? Existing tests not updated? Tests that could pass with broken code? Schema change without migration, new env var without defaults, new dependency without lockfile, API change without client update, removed feature with leftovers. Flag only pieces clearly needed for this change to work.

### What to flag

- Code that will fail to compile, parse or run
- Logic errors producing wrong results
- Security vulnerabilities in changed code
- Race conditions or data loss with a concrete scenario
- Project-instruction violations where you can quote the exact rule
- Broken contracts with callers
- Missing tests for new or changed behaviour (\`suggestion\`, unless project rules require tests)
- Incomplete changes clearly needed for this change to work

Skip style concerns, linter-catchable issues and pre-existing problems in unchanged code.

### Validate before commenting

Re-read the surrounding code; grep to confirm claims of a missing import or an undefined name; read actual call sites for broken-caller claims; confirm a rule is scoped to the file; check for tests elsewhere before flagging missing tests. For a pattern repeated across files, comment on the first occurrence and mention the pattern in the general summary.

Before you say a check is not needed, a value is safe, or an input cannot happen, try to break your own claim. Look for a counter-example (for example, \`javascript://host/\` has a hostname), and run a quick read-only snippet when that settles it. If you cannot confirm the claim, do not post it, or post it as a \`question\`. Another agent may act on your comment, so a wrong claim turns into a wrong fix.

## Step 3: Leave comments

1. Post comments ordered by severity: all \`must-fix\` first, then \`suggestion\`, then \`nit\`, then \`question\`; file order within each.
2. Set the \`severity\` argument on every inline comment (do not prefix the body):
   - \`must-fix\` — bugs, security issues, data loss; code that will break or produce wrong results.
   - \`suggestion\` — concrete improvements with a clear reason (including missing tests and incomplete changes). Not style preferences.
   - \`nit\` — minor but still worth changing.
   - \`question\` — something unclear that needs the author's clarification.
3. Use \`side: "new"\` for added or modified code and \`side: "old"\` for removed code; set \`endLine\` when the issue spans lines. If a comment is refused because the line is not in the diff, pick a line that is. Follow **How to write comments** below.
4. Then decide on a general comment (\`${TOOL.generalComment}\`):
   - No findings → "No issues found. Checked for bugs and project-rule compliance."
   - 1-2 findings → skip unless there is a cross-cutting concern.
   - 3+ findings → summarize the themes.
   - Large diffs → always note the scope reviewed and group findings by area.
   - No severity labels in the general comment. Lead with the verdict in one sentence, then at most 3 short bullets; no compliments, no filler, no narrating the code.

${WRITING}

## Step 4: Report

Reply with a short summary: counts per severity (e.g. "2 must-fix, 1 suggestion") and one line per must-fix. The comments are already visible in the Review tab.
`;
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export function mentionPrompt(target: Target, thread: ReviewThread): string {
  const comments = thread.comments
    .map((comment) => `**${comment.authorType === "user" ? "User" : `Agent (${comment.authorName})`}:**\n\n${quote(comment.body)}`)
    .join("\n\n");
  const code =
    thread.startLine > 0 && thread.anchorContent !== null ? `\nCommented code, as it read then:\n\n\`\`\`\n${thread.anchorContent}\n\`\`\`\n` : "";
  return `# Address a review thread

You were mentioned in a review thread in Diff Review. Read the thread, look at the code it points to, and respond in the thread with Diff Review's tools.

- Diff: ${describeTarget(target)}, in this workspace
- Thread: \`${thread.id}\` — ${describeLocation(thread)}
${code}
## The thread

${comments}

## Tools

- \`${TOOL.reply}(threadId, text)\` — answer in the thread. Your reply is shown to the user as your comment.
- \`${TOOL.resolve}(threadId, text)\` — mark the thread resolved with a summary of what you changed.
- \`${TOOL.threads}\` — the thread again, with any newer comments.

${fallback(`\`reply\`, \`resolve\`, \`list\``)}

${REJECTED}

${WRITING}

- A \`resolve\` summary: one sentence, under 15 words, saying what changed. Example: "Fixed: accept http as well as https."
- If you disagree with a comment, say why in one or two sentences and leave the thread open.

## Instructions

1. Work on thread \`${thread.id}\` only. The latest user comment (especially one that mentions you) is what you are responding to; earlier comments are context.
2. Read the file around the commented lines (the old side means removed code, visible only in the diff). A whole-file thread is about the file; a whole-diff thread is about the whole change (read it with \`git diff\`).
3. Decide what the comment asks for:
   a. **A question or discussion** ("why…?", "is this safe?", "what does this do?"): answer it with a reply, grounded in code you actually read (cite \`path:line\`). Do not edit files and do not resolve the thread — the user decides when it is done.
   b. **A change** ("rename…", "fix…", "can we add…?", "should handle X"): make the minimal change, then resolve the thread with a one-line summary like "Fixed: <what changed>".
   c. **Unclear**: reply asking a specific clarifying question instead of guessing.
   d. If an edit is rejected, follow **Rejected edits** above.
4. Always leave exactly one response in the thread (a reply, or the resolve summary).
5. Finish with one sentence here saying what you did. If the user mentions you again in this thread, you will get it here.
`;
}

export function fixPrompt(input: { target: Target; threads: readonly ReviewThread[]; note: string }): string {
  return `You were started by Diff Review in the workspace of another thread, whose changes the user reviewed. Make the fixes here; the other thread is not told.

The \`diff_review_*\` tools (\`${TOOL.threads}\`, \`${TOOL.reply}\`, \`${TOOL.resolve}\`, \`${TOOL.dismiss}\`) do the same as the commands below; use them when they are available.

${sendPrompt(input)}`;
}
