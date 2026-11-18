# Changelog

Notable changes to `dream`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **Nightly memory consolidation for every Claude Code project**, the way Claude Code's own auto-dream
  does it, which never runs in bb. **The schedule is off until you turn it on** in the plugin's settings.
- **A dream that can only write memory.** Each dream is a hidden thread that may read anything but write
  only `.md` files in that project's memory folder; everything else is refused without asking. The
  thread is stopped and archived when it ends. Before each dream sees anything, a startup check proves those
  limits are in force; if it fails, the dream does not run.
- **A dry run first.** A project's first dream proposes its changes on a copy; you apply or discard them.
  After one is applied, that project's dreams edit its memory in place.
- **See a dry run's changes before applying them**: every memory file it would add, change or delete,
  shown line by line against your memory as it is now, with a warning when your memory has changed
  since the dry run.
- **Backups and restore.** The memory is backed up before every change, the 20 newest kept per project.
- **The Dream page**: each project's memory folder, last dream, sessions since and whether it is due,
  with a switch per project, *Dream now*, *Dry run*, *Apply* and *Discard*, and filters for projects with
  or without memory and those the schedule would dream; and the history of dreams with their summaries.
- **Settings** for the window (01:00–06:00), the thresholds (72 hours, 5 sessions on 2 days, 30 quiet
  minutes), backups, the push notification, the machine dreams run on and the model.
- **Thorough by default**: each dream runs on the most capable Claude model bb offers (Fable 5.2, high
  reasoning; a setting), is told it has up to 45 minutes and no rush, must look at every session since
  the last dream and check each memory against the code, and says in its summary what it covered.
- **`bb dream`**: `status`, `run`, `stop`, `apply`, `discard`, `restore`, `backups` and `history`.
- **One push notification** after a dream that changed files, naming the project and the counts.
