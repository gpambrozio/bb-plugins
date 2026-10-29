# Diff Review (diff-review)

Review an agent's changes the way you review a pull request, without leaving bb: comment on lines,
ranges, files or the whole diff in a **Review** tab beside the thread, then send the comments to the
thread's agent. It fixes the code and answers in each comment thread, and the tab updates as it does.

It is a bb take on [diffity](https://github.com/nilbuild/diffity)'s review loop, and reuses its prompts
(MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## What you get

- **A Review tab** in each thread's side panel, opened from the **Review** icon button in the thread's
  header (which also closes it), the side panel's tabs, or the
  command palette (*Diff Review: review this thread's changes*). It shows the diff of the thread's
  workspace: the **uncommitted changes**, the **staged** or the **unstaged** ones, the changes
  **committed since** the base branch, **all changes since** the base branch, **one commit** of the
  branch, or **a range** (`main..feature`, or `main...feature`, which still shows a branch's changes
  once merged). It opens on the uncommitted changes, or on the committed ones when nothing is
  uncommitted; after that, the view is the one you pick. Split or unified, in bb's code theme, with
  **Hide whitespace** and, in the settings, colour-blind colours (blue and orange). Each file's diff
  loads by itself as it scrolls into view; a very large change starts folded, and a binary or
  oversized file says why it has no line diff.
- **Any file.** *Any file* in the view picker searches the workspace for a file, in the diff or not,
  opens it and takes comments on its lines like the diff does.
- **Viewed**, per file, shared with bb's own diff panel: marking a file folds it, and a file that
  changed since you marked it says so. **Open** shows the file in bb's viewer at the version the view
  shows.
- **Find and go to.** **Find** searches every file of the diff, folded ones too; **Go to** (from the
  palette) jumps to a file, an open comment or another view as you type. The up and down arrows in
  the toolbar, and at the top right of each comment thread, step to the previous or next open
  comment (from the end they wrap around to the start) and highlight it, as *next / previous comment*
  in the palette does. Every toolbar action is a palette command (*Diff Review: …*).
- **Comments where you need them.** Hover a line and click **+**, or drag across lines and click **+**
  for a range. **Comment on file** sits in each file's header, **Comment on the diff** in the toolbar.
  A comment can carry a severity (must fix, suggestion, nit, question) and is written in Markdown.
- **Threads.** Reply, edit or delete your comments, resolve, reopen or dismiss a thread. Resolved and
  dismissed threads fold to one line (dismissing one folds it at once); click one to open it again,
  and it stays as you left it. Each file's header shows how many comment threads it has, open
  and closed, and **Only files with comments** in the toolbar hides the files without any, for going
  through a review's findings; the tab remembers that switch.
- **Nothing is lost by leaving the tab.** Each thread's tab keeps, per view, every comment, reply or
  edit you have not sent yet (with its box open), the files you folded or unfolded, and where you were
  scrolled, across switching threads, a reload or a restart, and on another device.
- **Comments follow the code.** When the lines under a comment move, the comment moves with them.
  When they change or leave the view, the comment is listed at the top under *Not on the current diff*,
  with the code as it read when you commented. A comment notes when its file changed since.
- **Suggested changes.** **Suggest a change** in a new comment starts a suggestion block with the
  commented lines; **Apply suggestion** writes it into the file (in a view of the working copy) and
  resolves the thread.
- **Revert…** in a file's header (uncommitted view) puts back the whole file, or only the changes you
  pick, as last committed. It asks first, and it changes the file only if it is still the version you
  were looking at; symlinks and submodules are left to git.
- **Send to agent.** Pick open threads, add an overall note, and send them to the thread under review,
  queued behind its current turn if it is in one. The agent answers each thread with
  `bb diff-review reply`, `resolve` or `dismiss`; its answers appear in the tab as they land. A thread
  shows *Sent · waiting*, *Agent answered*, or *No reply* (with a link to the thread) when the agent's
  turn ended without a word on it.
- **AI review.** **AI review** in the toolbar starts an agent reviewing the diff, with an optional
  focus (Security, Performance, Correctness, Naming, Tests, Types) and your own instructions. It works
  in a thread of its own in the same workspace — open it to watch or steer — and its comments appear in
  the tab as it leaves them. The same dialog can **Summarize** the change instead (a comment on the
  whole diff), and **Explain** in a file's header, or *Ask AI to explain these lines* in a new comment,
  has an agent explain them in a comment there.
- **Ask the reviewer.** Write @reviewer (or @agent) in a comment or a reply, outside code, and the view's
  AI reviewer answers in the comment thread. It is the latest AI review's thread, which already knows
  the diff and its own comments; the question goes there as a follow-up. If the view has no reviewer
  yet (or it was closed or cleared), one starts and takes the next questions too. It answers and
  recommends; it does not edit. Provider names such as @claude start nothing.
- **Fix in a new thread.** In **Send to agent**, choose *A new thread…* and an agent to have the fixes
  made in a new thread in the same workspace instead of the thread under review.
- **Runs.** Each AI run is a thread under the thread you are reviewing, in the same workspace, listed
  under the toolbar too, with **Open thread** and **Close** (which archives the thread). They start
  with the provider and model in Settings → Plugins → Diff Review (Claude Code and its default model
  unless changed), in bb's *Approve for me* mode unless you choose *Accept edits* there. bb cannot make
  a thread read-only, so an AI review is only asked not to edit; when it ends, the run lists every file
  that changed in the workspace while it ran.
- **Clear review.** Once a view has comments or runs, **Clear review** in the toolbar deletes every
  comment thread in that view, yours and the AI's, open or closed, and closes its runs, archiving
  their threads, so the tab starts fresh. It asks first, since it can't be undone; other views keep
  their comments.
- **The thread under review hears from its runs.** bb tells a thread when one of its child threads
  finishes a turn. Each run's last message opens with "Diff Review status report — no action
  needed", and the thread's agent is told these notices are reports, so it reads them without acting.
- **Leave generated files out.** List gitignore patterns in Settings → Plugins → Diff Review, and
  the workspace's own `.diffityignore` (and `.git/info/diffityignore`, the main repository's in a git worktree) is read too, as diffity does.

- **The Reviews page** in bb's sidebar lists every review with comments, across projects, newest
  first, with the number of open comment threads on its entry; pick one to see it in full. A thread's
  **Info** tab says how many review comments its workspace has open.
- **From the command line**, `bb diff-review open [file] [--view …]` opens a thread's review on a
  view, at a file, in the bb window that shows the thread, and prints the page's address.

Comments are stored by the plugin, per workspace and view, on the bb server; they stay when the tab or
bb closes. The diffs come from bb's Git plugin (turned on by default), and the staged, unstaged and
range views from git itself, run on the machine that holds the workspace.

## What it is not (yet)

- It does not comment inside bb's own diff panel (Mod+D): bb has no hook for that, so the Review tab
  draws its own diff with the same renderer.
- No GitHub pull request review yet ([#64](https://github.com/gpambrozio/bb-plugins/issues/64)).
- Viewed marks cover bb's own views; the staged, unstaged, range and Any file views have none.
- The agent may edit files the way it always can in its thread: Diff Review adds no permission of its
  own. Its AI runs use *Approve for me* (or *Accept edits*, if you set it).

## Install

Needs bb 0.48 or newer, with its Git plugin on (it is unless you turned it off).

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.3.0' --plugin diff-review --tag-prefix diff-review/
```

## For agents

The plugin ships a `diff-review` skill that tells a thread's agent how to answer: `bb diff-review list`,
then `reply`, `resolve` or `dismiss` with the text as base64 through `--text-base64-stdin`; an AI review
(or summary, or explanation) also has `comment`, and `bb diff-review open` opens a review for the user. Answers are accepted only from the thread the comments were sent to (or, for an AI
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
