---
name: diff-review
description: "Answer review comments sent from Diff Review's Review tab with `bb diff-review` (or its `diff_review_*` tools). Use when a message titled \"Address review comments\", \"Address a review thread\" or \"Review\" from Diff Review arrives, or the user asks you to reply to, resolve or dismiss a Diff Review comment thread."
---

# Answering Diff Review comments

The user reviews a thread's changes in Diff Review's **Review** tab, beside the thread, and sends their
comment threads to the thread's agent. Each sent thread has an id (twelve hex characters). Answer each
one with `bb diff-review`, from this thread: the plugin accepts answers only from the thread the
comments were sent to, and the user sees them in the tab, next to the code.

## Commands

- `bb diff-review list` — the open threads sent to this thread, with every comment. `--all` adds the
  resolved and dismissed ones; `--json` prints them as JSON.
- `bb diff-review reply <id>` — answer in a thread; it stays open.
- `bb diff-review resolve <id>` — mark it resolved, with a one-line summary of what you changed.
- `bb diff-review dismiss <id>` — close it without acting, with the reason.
- `bb diff-review comment <file> --line <n> [--end-line <n>] [--side new|old] [--severity …]` — only in
  the thread of an AI review, summary or explanation Diff Review started: a new comment on lines the
  diff shows (`--line 0` for the whole file, `--general` instead of a file for the whole diff).
- `bb diff-review open [file] [--view uncommitted|staged|unstaged|branch|all|commit|range]
  [--base <branch>] [--commit <sha>] [--range a...b] [--thread <id>]` — when the user asks to see a
  review: opens this thread's (or `--thread`'s) review on that view, at that file, in the bb window
  that shows the thread, and prints the page's address to give the user. A GitHub pull request's
  address in place of the file opens that pull request's review.
- Comments marked GitHub come from a pull request's review threads. You never post to GitHub: answer
  them with `reply` like any other (your answer stays in the tab), and the user posts what they choose.

An id may be shortened to any unique prefix of four or more characters.

In a thread Diff Review started (an AI review, which also answers @reviewer questions, a summary, an
explanation, or fixes in a new thread), the
`diff_review_threads`, `diff_review_comment`, `diff_review_general_comment`, `diff_review_reply`,
`diff_review_resolve` and `diff_review_dismiss` tools do the same without the base64; use them when
they are there.

## Passing the text

Give the text as base64 through stdin, so quotes, backticks, `$(...)` and new lines arrive as written. A
heredoc whose delimiter is in single quotes leaves the text alone:

```sh
base64 <<'DIFF_REVIEW_END' | tr -d '\n' | bb diff-review reply 3fa9c2 --text-base64-stdin
Because `b` is read before it is set; see src/a.ts:12.
DIFF_REVIEW_END
```

Run that one pipeline per answer. If a line of your text is exactly `DIFF_REVIEW_END`, pick another
delimiter. The one new line the heredoc adds is dropped. Texts up to 12,000 bytes fit. Plain words after
the id also work (`bb diff-review resolve 3fa9c2 Fixed: accept http too.`), but only for text with
nothing the shell would change.

## How to answer

- Leave exactly one answer per thread: a `reply`, a `resolve` summary, or a `dismiss` reason.
- Resolve only after your change for that thread was actually written. If the user rejected the edit,
  `reply` saying what you would change and leave the thread open.
- A question or discussion gets a `reply` grounded in the code you read (cite `path:line`), not an edit.
- Keep a `resolve` summary to one sentence under 15 words ("Fixed: accept http as well as https."); a
  `reply` to 1-3 sentences.
- A thread's side `old` means removed lines, visible only in the diff; line 0 means the whole file; the
  path `__general__` means the whole change. In the "files of the working tree" view, line numbers are
  the file's own, with no diff.
- A comment may hold a ```` ```suggestion ```` block: the code the user or reviewer suggests for the
  thread's lines. Apply it if it is right, then resolve the thread.

If you end your turn without answering a thread, the tab marks it "No reply" and links back here.

## Notices from Diff Review's threads

Diff Review starts its AI reviews (which also answer @reviewer questions), summaries, explanations and
fixes as child threads of the thread under review, so that thread gets bb's `@thread:… completed: …` notice after each of their turns. A notice
that opens with "Diff Review status report — no action needed" is a report: read it, and do nothing
about it unless the user asks. Review comments reach you only as a message from the Review tab.

## Errors

- "was not sent to this thread" — the comment went to another thread; leave it.
- "No comment thread … was sent to this thread" — check the id with `bb diff-review list`.
- "Run this inside the bb thread the comments were sent to" — the command ran outside a bb thread.
