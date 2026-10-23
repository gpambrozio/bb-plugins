Comment on a thread's changes line by line, then send the comments to its agent, which fixes the code
and answers each one. It is diffity's review loop on your own working tree, inside bb.

## What you get

- A Review tab in each thread's side panel, one click away in the thread's title bar, with the diff of
  the thread's workspace: its uncommitted changes, the changes committed since the base branch, all
  changes since the base branch, or one of the branch's commits. Split or unified, in bb's code theme,
  loading as you scroll.
- Comments on a line, a range of lines, a whole file or the whole diff, in Markdown, with an optional
  severity: must fix, suggestion, nit or question. Reply, edit, resolve, reopen or dismiss.
- Comments that follow the code as it moves. A comment whose code changed or left the view is listed
  apart, with the code as it read when you made it.
- Send to agent: pick open comment threads, add a note, and send them to the thread under review,
  queued behind its current turn. The agent answers in each thread from its own chat, and the tab
  shows every answer as it arrives, or "No reply" with a link back to the thread.
- Ignore patterns for lockfiles and generated files, in the plugin's settings and in the workspace's
  own .diffityignore.

## How it works

The diff comes from bb itself, from the machine the thread's workspace is on. Comments are stored by
the plugin on your bb server, per workspace and per view, so they survive closing the tab or bb. The
agent answers through a bb diff-review command the plugin teaches it with a skill, and only the thread
the comments were sent to can answer them.

## What it costs

Nothing beyond bb: no account, no service and nothing else to install. The fixes are made by the
thread's own agent, in its own turn, on your provider plan.

## Limits

- The Review tab draws its own diff; bb's built-in diff panel has no comment hook.
- AI review runs, mentions of an agent in a comment, GitHub pull request review, staged versus unstaged
  changes, viewed marks and applying suggestions are planned, not built.
