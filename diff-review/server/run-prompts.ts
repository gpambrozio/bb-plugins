/**
 * The messages AI runs get: a review, a question to the view's reviewer (`@reviewer` / `@agent`, as a
 * follow-up turn of the reviewer's thread or the first message of a new one), a fix in a new thread,
 * a summary of the change and an explanation of a file or lines.
 *
 * Adapted from diffity's `src-tauri/prompts/review.md`, `thread.md`, `summarize.md` and `explain.md`
 * (https://github.com/nilbuild/diffity), Copyright (c) 2026 Kamran Ahmed, MIT License — see
 * THIRD_PARTY_NOTICES.md. The review steps, what to flag, the validation pass, the writing rules and
 * the rejected-edit rules are diffity's; the tools are this plugin's `diff_review_*` tools, with the
 * `bb diff-review` command as the way back when a tool is missing.
 */
import { rangeText } from "../shared/git-spec";
import { describeLocation, describeTarget, type ReviewThread, type Target } from "../shared/types";
import { CLI, sendPrompt } from "./prompt";
import { TOOL } from "./tool-names";

/**
 * The line every run's final message opens with. A run's thread is a child of the thread under review,
 * and bb posts each of a child's finished turns to its parent ("@thread:… completed: <final message>"),
 * which wakes the parent's agent; this line tells that agent the notice is a report, not a request.
 */
export const REPORT_LINE = "Diff Review status report — no action needed; the results are in the Review tab.";

const REPORT = `Start your final message with this line, exactly: "${REPORT_LINE}" bb shows your final message to the thread whose changes are under review (this thread is its child), and that line tells its agent this is a report to read, not a request to act on.`;

const WRITING = `## How to write comments

Comments show in a small box next to the code, and the reader is busy. Write in simple English: short sentences, common words, no filler.

- Say what is wrong and what to do, in 1-3 sentences (about 50 words at most). Lead with the problem.
- Cite \`path:line\` instead of quoting code or walking through it. Do not explain things the author already knows.
- For a project-rule violation, quote the rule in a few words.`;

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
    case "staged":
      return "`git diff --cached`";
    case "unstaged":
      return "`git diff`, plus the untracked files `git status --porcelain` lists";
    case "range":
      return `\`git diff ${rangeText(target)}\``;
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

You are now this view's reviewer: when the user asks about a comment thread with @reviewer, the question arrives here as a new message, and you answer it in that thread.

${REPORT}
`;
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * A question to the view's reviewer about one comment thread. `followUp`: sent as a new turn of the
 * reviewer's own thread, which already knows the diff; otherwise the first message of a new reviewer.
 */
export function reviewerPrompt(target: Target, thread: ReviewThread, followUp: boolean): string {
  const comments = thread.comments
    .map((comment) => `**${comment.authorType === "user" ? "User" : `Agent (${comment.authorName})`}:**\n\n${quote(comment.body)}`)
    .join("\n\n");
  const code =
    thread.startLine > 0 && thread.anchorContent !== null ? `\nCommented code, as it read then:\n\n\`\`\`\n${thread.anchorContent}\n\`\`\`\n` : "";
  const intro = followUp
    ? "The user asked you, the reviewer of this view, about a review thread (they wrote @reviewer or @agent). Use what you already know of the diff and your earlier comments."
    : `You are the reviewer of a diff in Diff Review. The user asked about a review thread (they wrote @reviewer or @agent). Read the diff with ${gitCommandFor(target)} as you need it. Later questions about this view's threads will arrive here as new messages, so you stay its reviewer.`;
  return `# A question about a review thread

${intro}

- Diff: ${describeTarget(target)}, in this workspace
- Thread: \`${thread.id}\` — ${describeLocation(thread)}
${code}
## The thread, when the question was sent

${comments}

The user may have added comments since; \`${TOOL.threads}\` shows the thread as it is now. Answer its latest user comment.

## Tools

- \`${TOOL.reply}(threadId, text)\` — answer in the thread. Your reply is shown to the user as your comment.
- \`${TOOL.resolve}\`, \`${TOOL.dismiss}\` — close a thread, with a one-line reason.
- \`${TOOL.comment}\`, \`${TOOL.generalComment}\` — a new review comment, if the question shows a problem no thread covers.
- \`${TOOL.threads}\` — this view's threads, with every comment.

${fallback(`\`list\`, \`reply\`, \`resolve\`, \`dismiss\`, \`comment\``)}

**Do not edit files, and do not run commands that change the repository.** You review; the user sends fixes to an agent. Diff Review lists every file that changes in this workspace while you run.

${WRITING}

- If you disagree with a comment, say why in one or two sentences and leave the thread open.

## Instructions

1. Work on thread \`${thread.id}\`. Read the code it points to (the old side means removed code, visible only in the diff); a whole-file thread is about the file, a whole-diff thread about the whole change.
2. Decide what the latest user comment asks for:
   a. **A question or discussion** ("why…?", "is this safe?", "what does this do?"): answer with a reply, grounded in code you actually read (cite \`path:line\`). Leave the thread open; the user decides when it is done.
   b. **A change** ("rename…", "fix…", "can we add…?"): do not make it. Reply with the change you recommend, specific enough for an agent to apply, and leave the thread open.
   c. **Unclear**: reply with a specific clarifying question instead of guessing.
3. Leave exactly one response in the thread.
4. Finish with one sentence here saying what you did.

${REPORT}
`;
}

export function fixPrompt(input: { target: Target; threads: readonly ReviewThread[]; note: string }): string {
  return `You were started by Diff Review as a child of the thread whose changes the user reviewed, in its workspace. Make the fixes here; that thread is not asked to.

${REPORT}

The \`diff_review_*\` tools (\`${TOOL.threads}\`, \`${TOOL.reply}\`, \`${TOOL.resolve}\`, \`${TOOL.dismiss}\`) do the same as the commands below; use them when they are available.

${sendPrompt(input)}`;
}

/** "Summarize": a summary of the change for a reviewer, left as a comment on the whole diff. */
export function summaryPrompt(target: Target): string {
  return `# Summarize the changes

Summarize ${describeTarget(target)} in this workspace for a reviewer, with Diff Review. Read the diff with ${gitCommandFor(target)} (use \`git log\` for the range when commit messages add context), and enough of the surrounding code to understand the intent, not just the text of the hunks.

Write the summary:

- **Overview**: one or two sentences: what this change does and why.
- **Changes by area**: group files by area (backend, frontend, tests, config, docs, …). For each area, bullet the meaningful changes with file paths. Collapse mechanical changes (renames, formatting) into one line.
- **Behaviour changes**: anything user-visible, API or contract changes, migrations, new config or dependencies.
- **Worth a closer look**: risky or subtle spots a reviewer should focus on, with \`path:line\`.

Be concise and factual; no filler, no praise.

Post the summary, once, with \`${TOOL.generalComment}\` (a comment about the whole diff, no severity). ${fallback("`comment --general`")}

**Do not edit files, and do not run commands that change the repository.** Do not leave other comments.

Then finish with one sentence here saying the summary is in the Review tab.

${REPORT}
`;
}

export interface ExplainPlace {
  filePath: string;
  side: "old" | "new" | null;
  startLine: number;
  endLine: number;
  /** The selected lines' text, when lines were selected. */
  code: string | null;
}

/** "Explain": a file or selected lines explained to a reviewer, left as a comment on them. */
export function explainPrompt(target: Target, place: ExplainPlace): string {
  const file = "`" + place.filePath + "`";
  const lines = place.startLine === 0 ? null : place.startLine === place.endLine ? `line ${place.startLine}` : `lines ${place.startLine}-${place.endLine}`;
  const what = lines === null ? file : `${lines} of ${file} (${place.side === "old" ? "the old side: removed lines" : "the new side"})`;
  const fence = "```";
  const code = place.code === null ? "" : `\nThe selected code:\n\n${fence}\n${place.code}\n${fence}\n`;
  const where =
    lines === null
      ? `with \`${TOOL.comment}\` on the whole file (file ${file}, startLine 0)`
      : `with \`${TOOL.comment}\` on the same lines (file ${file}, startLine ${place.startLine}, endLine ${place.endLine}, side \`${place.side ?? "new"}\`)`;
  return `# Explain ${what}

Explain ${what} to a reviewer who has not seen it before. The diff under review is ${describeTarget(target)} in this workspace (read it with ${gitCommandFor(target)}); ${lines === null ? "explain the file" : "explain those lines specifically, using the rest of the file only as supporting context"}.
${code}
Cover, in this order and only as far as it is useful:

1. **Purpose**: what it is for, in one or two sentences.
2. **How it works**: the main pieces (types, functions, components) and the flow between them.
3. **How it connects**: what it depends on, and who depends on it. Search for callers and importers; list the important call sites with \`path:line\`.
4. **Things to watch**: non-obvious behaviour, invariants, side effects, error handling, or anything surprising a reviewer should know.

Read the actual code before explaining; cite \`path:line\` for concrete claims. Be concise: short sections and bullet points over prose.

Post the explanation, once, ${where}, with no severity. ${fallback("`comment`")}

**Do not edit files, and do not run commands that change the repository.** Do not leave other comments.

Then finish with one sentence here saying the explanation is in the Review tab.

${REPORT}
`;
}
