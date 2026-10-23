---
name: diff-review
description: "Answer review comments sent from Diff Review's Review tab with `bb diff-review`. Use when a message titled \"Address review comments\" arrives, or the user asks you to reply to, resolve or dismiss a Diff Review comment thread."
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

An id may be shortened to any unique prefix of four or more characters.

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
  path `__general__` means the whole change.

If you end your turn without answering a thread, the tab marks it "No reply" and links back here.

## Errors

- "was not sent to this thread" — the comment went to another thread; leave it.
- "No comment thread … was sent to this thread" — check the id with `bb diff-review list`.
- "Run this inside the bb thread the comments were sent to" — the command ran outside a bb thread.
