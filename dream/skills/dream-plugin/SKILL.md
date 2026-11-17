---
name: dream-plugin
description: Check or act on the Dream plugin's memory consolidation of Claude Code projects with `bb dream` — status, run a dream by hand, apply or discard a dry run, restore a memory backup. Use when the user asks about dreams, memory consolidation, or a project's Claude Code memory folder.
---
# Dream plugin

Dream consolidates each Claude Code project's auto memory (`MEMORY.md` and its topic files) the way
Claude Code's own auto-dream does, in a hidden bb thread that can only read, and write `.md` files in
that one memory folder. It runs on one machine, chosen in the plugin's settings.

## Commands

- `bb dream status [--json]` — per project: the memory folder and where its location comes from,
  file and index counts, the last dream, sessions since, and whether it is due and why. Read this
  first.
- `bb dream run <project> [--dry-run]` — dream one project now, skipping the time, session and busy
  checks (never the lock). Answers once the thread has started; the dream takes minutes.
- `bb dream stop` — stop the running dream; its lock is rolled back, so it does not count.
- `bb dream apply <project> [time]` — apply a dry run's proposal, after a backup. Refused when a file
  the dream changed has changed since.
- `bb dream discard <project> [time]` — drop a dry run's proposal.
- `bb dream restore <project> [time]` — put a backup's `.md` files back; the current ones are backed up
  first, so restoring the newest backup again undoes it.
- `bb dream backups <project>` and `bb dream history [project] [--limit n]` — what there is to restore,
  and past dreams with their summaries.

`<project>` is the bb project's name or id. `[time]` is a stamp such as `20261117T010500000Z`, as
`bb dream backups` lists them; the newest when left out.

## Rules

- Never start a dream, apply, discard or restore unless the user asked for that project. Status,
  backups and history only read.
- A project's first dream is a dry run: it changes nothing until someone applies it. Say so when you
  report one.
- The schedule is the user's to turn on, in Settings → Plugins → Dream. Do not change it.
- Dream never edits CLAUDE.md or AGENTS.md. A dream's summary lists memories that look newer than
  CLAUDE.md under "CLAUDE.md to check"; pass that on rather than editing CLAUDE.md yourself unless asked.
