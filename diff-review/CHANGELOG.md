# Changelog

Notable changes to `diff-review`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **A Review tab beside each thread** with the diff of the thread's workspace: its uncommitted
  changes, the changes committed since the base branch, all changes since the base branch, or one of
  the branch's commits, split or unified, in bb's code theme. Diffs load on their own as you scroll;
  very large changes start folded.
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
