# Dream

Consolidates each Claude Code project's memory overnight, the way Claude Code's own auto-dream does,
for every project bb knows. Claude Code's auto-dream never runs in bb: bb runs Claude Code as SDK
sessions, which auto-dream skips. Dream runs the same four-phase pass (orient, gather recent signal,
consolidate, prune and index) from bb, on a schedule you choose, in a hidden thread that can read
anything but write only that project's memory folder.

**The schedule ships off.** Nothing dreams until you turn on *Dream on a schedule* in Settings →
Plugins → Dream. Until then the page and `bb dream status` only read.

## What a dream does

Each dream is a hidden Claude Code thread, given Claude Code 2.1.326's dream prompt with three
additions: a list of the sessions since the last dream across all the project's folders, the path of
the project's checkout, and Claude Code's own rules for memories that contradict `CLAUDE.md` (delete
or rewrite what `CLAUDE.md` supersedes, annotate and report what looks newer, never edit `CLAUDE.md`
or `AGENTS.md`). It keeps `MEMORY.md` an index under 200 lines and about 25 KB. When it ends, the
thread is stopped and archived, and its summary goes into the Dream page's history.

- **Held to memory-only writes.** The thread may use Read, Glob and Grep; `ls`, `find`, `grep`, `cat`,
  `stat`, `wc`, `head` and `tail` in the shell; Write and Edit of `.md` files in the memory folder; and
  `rm -f` of `.md` files there. Everything else is denied without asking, as in Claude Code's own dream.
- **The limits are proven before every dream.** Each dream thread's first turn is a startup check that
  shows the guard is running and that a failing guard blocks the call. If it does not pass (hooks
  switched off in your Claude Code settings, say), the dream never sees your memory or transcripts and
  ends as failed. Dream also refuses to start when your settings visibly turn hooks off.
- **The first dream is a dry run.** It works on a copy of the memory and leaves a proposal. Apply it
  from the page or with `bb dream apply <project>` (refused if a session changed one of those files
  since), or discard it. Once one is applied, the project's dreams edit its memory in place.
- **A backup before every change.** The memory folder is archived before each dream, apply and restore;
  the 20 newest per project are kept. `bb dream restore <project> [time]` puts one back, and backs up
  what it replaces, so it can be undone the same way.
- **The same lock as Claude Code.** `<memory>/.consolidate-lock` holds the dream's process id while it
  runs; its modification time is the last dream, a failed dream sets it back, and it goes stale after an
  hour. Two copies of this plugin cannot take it at once, and it reads the lock back after taking it, so
  it steps aside for a native auto-dream that started at the same moment.
- **One push notification** after a dream that changed files, naming the project and the counts, or
  after a dry run that proposes changes. Nothing when nothing was due or nothing changed.

## When a project is due

By default, every night from 01:00 to 06:00 on the bb server's clock, Dream takes the most overdue
project, dreams it, then the next, one at a time, until none is due or the window closes. A project is
due when

- at least 72 hours have passed since its last dream,
- at least 5 Claude Code sessions ran in it since then, on at least 2 different days, and
- nobody is working in it: its memory did not change, and no session ran in it, in the last 30 minutes.

A project with no memory files, with a dry run waiting, or switched off on the page is skipped. Every
number is a setting. Sessions are counted in the checkout's own transcript folder, in every bb worktree
of the project (bb tells which project a worktree's thread belongs to; for a thread bb no longer knows,
the folder's repository name decides when only one project has it) and in Claude Code's own
`.claude/worktrees`. Dream's own threads never count.

## Memory folders

Each project's memory folder is found the way Claude Code 2.1.326 finds it:
`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, then `autoMemoryDirectory` from managed, local, project and user
settings (with `~` expanded), then `~/.claude/projects/<the main checkout>/memory`. The page shows where
the folder came from, and warns, without touching anything, when an old default folder still holds
files beside a custom one, or when the custom folder is set only in `settings.local.json`, which the
project's worktrees do not have.

## Using it

- **The Dream page** in the sidebar: the dream machine, the schedule, each project with its switch,
  memory folder, last dream, sessions since and why it is or is not due, with *Dream now*, *Dry run*,
  and *Apply* / *Discard* for a waiting dry run; and the history of dreams with their summaries.
- **Settings → Plugins → Dream**: the schedule, its window, the thresholds, backups and the
  notification; and below them the dream machine and the model (bb's own model picker; Sonnet 5.5 at
  medium effort to start with).
- **`bb dream`** for scripts and agents:

  ```text
  bb dream status [--json]
  bb dream run <project> [--dry-run]
  bb dream stop
  bb dream apply <project> [time]
  bb dream discard <project> [time]
  bb dream restore <project> [time]
  bb dream backups <project>
  bb dream history [project] [--limit n]
  ```

Dreams run on one machine, chosen in the settings (the bb server's machine to start with), for the
projects with a checkout there. The machine needs Claude Code signed in, as for any Claude Code
thread in bb. Each dream costs one model run on your Claude Code account.

## Where its files are

On the dream machine, in the plugin's own data folder (`~/.bb/plugins/dream/host-data/` on a default
install): `state.json` (per project: whether it edits in place yet, its dreams' thread and session
ids, and its last runs), `backups/<project id>/<time>.tar.gz`, `proposals/<project id>/<time>/` and
the dream workspaces. Nothing is written in `~/.claude` except the memory folders themselves and
Claude Code's own transcripts of the dream threads.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin dream --tag-prefix dream/
```

Needs bb 0.49 or newer, a machine running macOS or Linux, and Claude Code as one of bb's providers.
