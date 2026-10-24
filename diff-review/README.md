# Diff Review (diff-review)

Review an agent's changes the way you review a pull request, without leaving bb: comment on lines,
ranges, files or the whole diff in a **Review** tab beside the thread, then send the comments to the
thread's agent. It fixes the code and answers in each comment thread, and the tab updates as it does.

It is a bb take on [diffity](https://github.com/nilbuild/diffity)'s review loop, and reuses its prompts
(MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## What you get

- **A Review tab** in each thread's side panel, opened from the **Review** button in the thread's title
  bar, the side panel's tabs, or the command palette (*Diff Review: review this thread's changes*). It
  shows the diff of the thread's workspace: the **uncommitted changes**, the changes **committed
  since** the base branch, **all changes since** the base branch, or **one commit** of the branch. It
  opens on the uncommitted changes, or on the committed ones when nothing is uncommitted; after that,
  the view is the one you pick. Split or unified, in bb's code theme. Each file's diff loads by itself as it scrolls into view; a
  very large change starts folded, and a binary or oversized file says why it has no line diff.
- **Comments where you need them.** Hover a line and click **+**, or drag across lines and click **+**
  for a range. **Comment on file** sits in each file's header, **Comment on the diff** in the toolbar.
  A comment can carry a severity (must fix, suggestion, nit, question) and is written in Markdown.
- **Threads.** Reply, edit or delete your comments, resolve, reopen or dismiss a thread. Resolved and
  dismissed threads fold to one line.
- **Comments follow the code.** When the lines under a comment move, the comment moves with them.
  When they change or leave the view, the comment is listed at the top under *Not on the current diff*,
  with the code as it read when you commented.
- **Send to agent.** Pick open threads, add an overall note, and send them to the thread under review,
  queued behind its current turn if it is in one. The agent answers each thread with
  `bb diff-review reply`, `resolve` or `dismiss`; its answers appear in the tab as they land. A thread
  shows *Sent · waiting*, *Agent answered*, or *No reply* (with a link to the thread) when the agent's
  turn ended without a word on it.
- **Leave generated files out.** List gitignore patterns in Settings → Plugins → Diff Review, and
  the workspace's own `.diffityignore` (and `.git/info/diffityignore`) is read too, as diffity does.

Comments are stored by the plugin, per workspace and view, on the bb server; they stay when the tab or
bb closes.

## What it is not (yet)

- It does not comment inside bb's own diff panel (Mod+D): bb has no hook for that, so the Review tab
  draws its own diff with the same renderer.
- No AI review runs, `@claude` mentions or fixing in a new thread yet (phase 2), no GitHub pull request
  review ([#47](https://github.com/gpambrozio/bb-plugins/issues/47)), and no staged/unstaged split,
  arbitrary ranges, find, viewed marks or suggestion apply
  ([#48](https://github.com/gpambrozio/bb-plugins/issues/48)).
- The agent may edit files the way it always can in its thread: Diff Review adds no permission of its own.

## Install

Needs bb 0.46 or newer.

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin diff-review --tag-prefix diff-review/
```

## For agents

The plugin ships a `diff-review` skill that tells a thread's agent how to answer: `bb diff-review list`,
then `reply`, `resolve` or `dismiss` with the text as base64 through `--text-base64-stdin`. Answers are
accepted only from the thread the comments were sent to.

## Development

```bash
npm install --include=dev
npm run typecheck
npm test
bb plugin build
```

See [AGENTS.md](AGENTS.md) for how it is built and what must not break.
