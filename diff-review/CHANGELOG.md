# Changelog

Notable changes to `diff-review`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.1

### Fixed

- **Comments fit the pane.** A comment on a line of a wide file no longer stretches past the edge of
  the Review tab: comments, replies and the new-comment box are as wide as the visible diff, their text
  wraps, and a long word or code block in a comment no longer makes the code scroll sideways.
- **"Only files with comments" starts off in every thread.** Turning it on in one thread no longer
  turns it on in the next thread you open; each thread remembers its own choice.

## 0.2.0

### Added

- **AI review.** Ask an agent to review the diff, with an optional focus (security, performance,
  correctness, naming, tests, types) and your own instructions. It runs in a thread of its own in the
  same workspace, under the thread being reviewed, which you can watch and steer, and leaves its
  comments in the Review tab as it goes, with a summary comment on the whole diff.
- **Ask the reviewer in a comment.** Writing @reviewer (or @agent) in a comment or a reply asks the AI
  reviewer of that view, which already knows the diff and its own comments, and its answer appears in
  the same comment thread. When there is no reviewer yet, one starts and answers the next questions too.
- **Fix in a new thread.** Send to agent can now start a new thread in the same workspace instead of
  sending to the thread under review, with the provider and model you pick.
- **The runs, listed in the tab**, with a link to each thread and Close, which archives it. An AI review
  that ended while files in the workspace changed lists them, since bb cannot stop a review from
  editing.
- **Settings** for the provider and model AI runs start with (Claude Code and its default model unless
  you change them; each run can pick another) and for how they run: *Approve for me* unless you choose
  *Accept edits*.
- **Runs appear under the thread they review**, and their reports to it say that nothing needs doing.
- **Only files with comments.** A switch in the toolbar hides the files without comments, so you can go
  through a review's findings file by file; the tab remembers it. With the switch off, each file's
  header shows how many comment threads it has, open and closed.
- **The tab remembers where you were.** Leaving it (another thread, a reload, a restart) no longer
  loses unsent comments, replies or edits, which come back as typed with their box open, nor the files
  and comment threads you folded or opened, nor the place you were scrolled to, kept separately for each thread and view.
- **Clear review.** Deletes every comment thread in the view and closes its AI runs, archiving their
  threads, so you can start over. It asks first, since it can't be undone.

## 0.1.0

### Added

- **A Review tab beside each thread** with the diff of the thread's workspace: its uncommitted
  changes, the changes committed since the base branch, all changes since the base branch, or one of
  the branch's commits, split or unified, in bb's code theme. It opens on the uncommitted changes, or,
  when there are none, on the changes committed since the base branch. Diffs load on their own as you
  scroll; very large changes start folded.
- **A Review button in the thread's title bar** that opens the tab.
- **Comments on a line, a range of lines, a whole file or the whole diff**, with an optional severity
  (must fix, suggestion, nit, question), in Markdown. Reply, edit, delete, resolve, reopen and
  dismiss.
- **Comments follow the code they are on** as it moves; a comment whose code changed or left the view
  is listed apart, with the code as it read when you commented.
- **Send to agent:** pick open comment threads, add a note, and send them to the thread under review,
  queued behind its current turn. Its agent answers each thread, and the tab shows the answers as they
  arrive, or *No reply* when its turn ended without one.
- **Ignore patterns** for generated files, in the plugin's settings and in the workspace's own
  `.diffityignore`.
