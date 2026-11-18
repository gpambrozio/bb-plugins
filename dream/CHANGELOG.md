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
- **A dry run you do not apply never counts as a dream**: the next one is given every session since the
  last real dream, whether the dry run was discarded or proposed nothing.
- **A badge on Dream's sidebar entry** counts the dry runs waiting for you to apply or discard, and
  clears when none waits.
- **Always dry run**, a setting, off by default: when on, every dream, scheduled or by hand, is a dry
  run that waits for your review, not only a project's first. The page and `bb dream status` say
  which.
- **No false warning for a project folder outside git**: a custom memory folder set only in your local
  settings is flagged only in a git repository, whose worktrees do not see that file, and not when the
  repository's `.worktreeinclude` has bb copy that file into each new worktree.
- **A project that has never dreamed counts all its sessions**, even when a session saved a memory
  yesterday, and the Dream page says what its sessions are counted from: the last dream, or "never
  dreamed".
- **Backups and restore.** The memory is backed up before every change, the 20 newest kept per project.
- **The Dream page**: each project's memory folder, last dream, sessions since and whether it is due,
  with a switch per project, *Dream now*, *Dry run*, *Apply* and *Discard*, and filters for projects with
  or without memory and those the schedule would dream; and the history of dreams with their summaries.
- **Settings** for the window (01:00–06:00), the thresholds (72 hours, 5 sessions on 2 days, 30 quiet
  minutes), backups, the push notification, the machine dreams run on and the model.
- **Thorough by default**: each dream runs on Opus 5.5 at high reasoning (a setting), is told it has
  up to 45 minutes and no rush, must look at every session since the last dream and check each memory
  against the code, and says in its summary what it covered.
- **Checks memories against your newest code**, not an old checkout: each dream reads the newest copy of
  the project's main branch your repository already has (a read-only copy, made without fetching or
  touching your checkout), and falls back to the checkout, saying so, when there is none.
- **No links left pointing at nothing**: a dream that deletes, merges or renames a memory fixes the links
  to it, and any it leaves behind are listed with the run, on the dry run's view and in its notification.
- **`bb dream`**: `status`, `run`, `stop`, `apply`, `discard`, `restore`, `backups` and `history`.
- **One push notification** after a dream that changed files, naming the project and the counts.
