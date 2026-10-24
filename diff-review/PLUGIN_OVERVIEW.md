Comment on a thread's changes line by line, then send the comments to its agent, which fixes the code
and answers each one. It is diffity's review loop on your own working tree, inside bb.

## What you get

- A Review tab in each thread's side panel, one click away in the thread's title bar, with the diff of
  the thread's workspace: its uncommitted changes, the changes committed since the base branch, all
  changes since the base branch, or one of the branch's commits. Split or unified, in bb's code theme,
  loading as you scroll.
- Comments on a line, a range of lines, a whole file or the whole diff, in Markdown, with an optional
  severity: must fix, suggestion, nit or question. Reply, edit, resolve, reopen or dismiss. Each file
  shows its comment count, and one switch narrows the diff to the files with comments.
- Comments that follow the code as it moves. A comment whose code changed or left the view is listed
  apart, with the code as it read when you made it.
- Send to agent: pick open comment threads, add a note, and send them to the thread under review,
  queued behind its current turn. The agent answers in each thread from its own chat, and the tab
  shows every answer as it arrives, or "No reply" with a link back to the thread.
- AI review: an agent reviews the diff, with an optional focus such as security or tests, in a thread
  under the one being reviewed that you can watch, and leaves its comments in the tab. AI runs use
  bb's Approve for me mode unless you choose Accept edits.
- Mention @claude, @codex or @opencode in a comment and that agent answers in the comment thread.
- Fix in a new thread: send the comments to a new thread in the same workspace, with the agent and
  model you pick, instead of the thread under review.
- Ignore patterns for lockfiles and generated files, in the plugin's settings and in the workspace's
  own .diffityignore.

## How it works

The diff comes from bb itself, from the machine the thread's workspace is on. Comments are stored by
the plugin on your bb server, per workspace and per view, so they survive closing the tab or bb. The
agent answers through a bb diff-review command the plugin teaches it with a skill, and only the thread
the comments were sent to can answer them.

## What it costs

Nothing beyond bb: no account, no service and nothing else to install. Fixes, reviews and answers
are made by agents in bb threads, on your own provider plans; AI runs start with Claude Code unless
you pick another provider.

## Limits

- The Review tab draws its own diff; bb's built-in diff panel has no comment hook.
- bb cannot make a thread read-only, so an AI review is only asked not to edit files; the tab lists any
  file that changed while it ran.
- GitHub pull request review, staged versus unstaged changes, viewed marks and applying suggestions are
  planned, not built.
