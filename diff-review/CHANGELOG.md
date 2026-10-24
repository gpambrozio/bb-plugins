# Changelog

Notable changes to `diff-review`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Added

- **AI review.** Ask an agent to review the diff, with an optional focus (security, performance,
  correctness, naming, tests, types) and your own instructions. It runs in a thread of its own in the
  same workspace, under the thread being reviewed, which you can watch and steer, and leaves its
  comments in the Review tab as it goes, with a summary comment on the whole diff.
- **Mention an agent in a comment.** Writing @claude, @codex or @opencode in a comment or a reply
  gets that agent's answer in the same comment thread, from a thread of its own; mentioning it again
  in that comment thread continues the same conversation.
- **Fix in a new thread.** Send to agent can now start a new thread in the same workspace instead of
  sending to the thread under review, with the provider and model you pick.
- **The runs, listed in the tab**, with a link to each thread and Close, which archives it. An AI review
  that ended while files in the workspace changed lists them, since bb cannot stop a review from
  editing.
- **Settings** for the provider and model AI runs start with (Claude Code and its default model unless
  you change them; each run can pick another) and for how they run: *Approve for me* unless you choose
  *Accept edits*.
- **Runs appear under the thread they review**, and their reports to it say that nothing needs doing.

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
