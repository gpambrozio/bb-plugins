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
- **AI review.** **AI review** in the toolbar starts an agent reviewing the diff, with an optional
  focus (Security, Performance, Correctness, Naming, Tests, Types) and your own instructions. It works
  in a thread of its own in the same workspace — open it to watch or steer — and its comments appear in
  the tab as it leaves them.
- **Mention an agent.** Write @claude, @codex or @opencode in a comment or a reply, outside code, and
  that agent answers in the comment thread, from a thread of its own; mention it again there to carry on.
- **Fix in a new thread.** In **Send to agent**, choose *A new thread…* and an agent to have the fixes
  made in a new thread in the same workspace instead of the thread under review.
- **Runs.** The AI runs are listed under the toolbar, with **Open thread** and **Close** (which archives
  the thread). They start with the provider and model in Settings → Plugins → Diff Review (Claude Code
  and its default model unless changed), each in bb's *accept edits* mode. bb cannot make a thread
  read-only, so an AI review is only asked not to edit; when it ends, the run lists every file that
  changed in the workspace while it ran.
- **Leave generated files out.** List gitignore patterns in Settings → Plugins → Diff Review, and
  the workspace's own `.diffityignore` (and `.git/info/diffityignore`) is read too, as diffity does.

Comments are stored by the plugin, per workspace and view, on the bb server; they stay when the tab or
bb closes.

## What it is not (yet)

- It does not comment inside bb's own diff panel (Mod+D): bb has no hook for that, so the Review tab
  draws its own diff with the same renderer.
- No GitHub pull request review ([#47](https://github.com/gpambrozio/bb-plugins/issues/47)), and no staged/unstaged split,
  arbitrary ranges, find, viewed marks or suggestion apply
  ([#48](https://github.com/gpambrozio/bb-plugins/issues/48)).
- The agent may edit files the way it always can in its thread: Diff Review adds no permission of its
  own. Its AI runs use *accept edits*, bb's most limited mode.

## Install

Needs bb 0.46 or newer.

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.2.0' --plugin diff-review --tag-prefix diff-review/
```

## For agents

The plugin ships a `diff-review` skill that tells a thread's agent how to answer: `bb diff-review list`,
then `reply`, `resolve` or `dismiss` with the text as base64 through `--text-base64-stdin`; an AI review
also has `comment`. Answers are accepted only from the thread the comments were sent to (or, for an AI
review, from its own thread). The threads AI runs start also get `diff_review_*` tools that do the same
without the base64.

## Development

```bash
npm install --include=dev
npm run typecheck
npm test
bb plugin build
```

See [AGENTS.md](AGENTS.md) for how it is built and what must not break.
