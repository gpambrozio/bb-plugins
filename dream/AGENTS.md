# AGENTS.md

A bb plugin that runs Claude Code's auto-dream (memory consolidation) for every project bb knows, on
a schedule that ships **off**. New here, not a Paseo port. The repository root `AGENTS.md` covers what
every plugin shares; this file covers what is specific to `dream`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Settings, the machine and model choices (kv `choices`), and the ports that bind `server/service.ts` to bb. |
| `server/service.ts` | One dream from start to end, the nightly sweep, recovery after a reload. Reaches bb only through `DreamPorts`. |
| `server/projects.ts` | Projects with a checkout on the dream machine, and which bb worktree transcript folders are theirs. |
| `server/prompt.ts`, `server/dream-skill.ts` | The dream prompt: `skills/dream/SKILL.md`, embedded, with one run's facts filled in. |
| `server/cli.ts`, `server/history.ts` | `bb dream`, and the run log in kv. |
| `host.ts`, `host/dreams.ts` | Everything on the dream machine: status, prepare and finish a run, apply, discard, restore. |
| `host/memory.ts`, `host/slug.ts` | Claude Code 2.1.326's memory-folder resolution and project-folder naming. |
| `host/transcripts.ts` | Transcript folders and session files; titles from `ai-title` / `custom-title` lines. |
| `host/lock.ts`, `host/snapshot.ts`, `host/proposals.ts`, `host/state.ts` | The `.consolidate-lock`, backups, dry runs and `state.json`. |
| `host/workspace.ts`, `guard/guard.mjs` | The dream thread's working directory, and the PreToolUse hook that limits its tools. |
| `shared/gate.ts`, `shared/window.ts` | When a project is due, and the nightly window. Pure. |
| `app/dream-page.tsx`, `app/settings-section.tsx` | The page, and the machine and model choices. |

`npm test` runs everything. Generated files: `host/guard-source.ts` and `server/dream-skill.ts`; run
`npm run embed` after changing `guard/guard.mjs` or `skills/dream/SKILL.md` (a test fails until you do).

## Matching Claude Code 2.1.326

These follow Claude Code 2.1.326's bundle (read with `strings`; the scout report has the lines) and must
be re-checked when Claude Code changes them:

- **Project folders** (`host/slug.ts`): non-alphanumerics become `-`; over 200 characters, cut and add
  the base-36 absolute value of a Java-style string hash.
- **Memory folder** (`host/memory.ts`): `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` (no `~` expansion), then the
  first `autoMemoryDirectory` in policy, local, project, user settings (the first that sets the key
  decides even when its value is unusable), then `<CLAUDE_CODE_REMOTE_MEMORY_DIR or config>/projects/<slug
  of the canonical git root>/memory`. Flag settings, MDM and server-managed policy are not visible here.
- **The lock** (`host/lock.ts`): PID body, mtime is the last consolidation, held while under an hour old
  and its PID alive, rolled back (mtime restored, or removed) on failure, left in place on success.
- **The prompt** (`skills/dream/SKILL.md`): native's text, changed only where a bb dream differs — the
  transcripts are a manifest over several folders, the checkout is outside the working directory, and
  `CLAUDE.md` is read from the checkout rather than the system prompt. Native's "Reconcile memories
  against CLAUDE.md" section, which 2.1.326 ships but does not put in its prompt, is in, with AGENTS.md
  added beside CLAUDE.md. The team-memory section is not.

## Holding a bb thread to a dream's tool limits

bb's Claude Code provider has no per-thread tool list and no dontAsk mode: its least privileged mode is
accept-edits. But it starts sessions with the user, project and local settings sources, so a thread's
*working directory* decides its project settings. A dream therefore runs in its own workspace
(`<host data>/workspaces/<project id>/`), spawned as an unmanaged workspace of the project, whose
`.claude/settings.json` carries a PreToolUse hook on every tool. The hook, `guard.mjs`, answers allow or
deny and never ask, which is native's dontAsk dream. Do not move the dream into the checkout: writing
`settings.local.json` there would change the user's own sessions.

- **The guard fails closed.** Bad input, a missing policy or a crash answers deny with exit 2. It must
  also *answer*: a hook that prints nothing lets Claude Code fall back to its own permission check,
  which in accept-edits asks. Its main-script check compares real paths for that reason (run through
  macOS's `/var` symlink, a plain URL comparison silently skipped `main()`; a test runs it through a
  symlink).
- **Behind it**, anything that does ask is stopped: the watcher ends a dream whose thread has a pending
  interaction, as a failure, within one poll.
- **The hook runs on the host daemon's own Node** (`process.execPath`); bb.app's is Electron, so the
  command sets `ELECTRON_RUN_AS_NODE=1` when `process.versions.electron` is set.
- `autoMemoryDirectory` in the workspace settings makes the session's auto-memory section name the folder
  the dream writes, which the prompt defers to for the memory format. An `Edit(//<memory>/**)` allow rule
  and the folder as an additional directory let bb's Bash sandbox through for `rm -f`.
- **What was verified live** (bb 0.49.0, Claude Code 2.1.326, isolated dev bb): a thread in a generated
  workspace was denied Write and Edit in the repository and in the workspace itself, `>>`, `touch`, `cp`,
  `find -delete`, `rm -f` outside memory and ToolSearch, with no approval prompt, and allowed reads, a
  memory write and a memory `rm -f`.

## Dreams are sessions too

A dream's transcript lands in `~/.claude/projects/<slug of its workspace>/`, which belongs to no project,
so it can never count. Belt and braces: `finish` records the dream thread's id and its session ids in
`state.json`, and status leaves out any worktree folder of a dream thread and any session of a dream.

## A run's life

`prepare` (host, under one-at-a-time `exclusive`): lock, then backup (a dream) or copy (a dry run), then
workspace, then `state.runs[runId]`, and a worker lease so the host worker outlives the five-minute idle stop. The
server records `active-run` in kv before spawning and the thread id after. The watcher polls every 10 s
until the turn ends, the thread fails, asks for anything, is stopped by hand (`stop-requested` in kv), or
45 minutes pass. Then: stop the thread, `finish` on the host (changes, or rollback), archive, log,
notify.

- **The lock's PID is the host worker's.** After a successful dream it stays for the lock's hour, as
  native's does, so *other* processes see it held. The plugin itself treats a lock holding its own PID
  with no run of its own in progress as free; otherwise a restore right after a bad dream was refused.
- **A dry run** never moves the lock unless it proposes nothing (then it counts as a dream). Applying moves
  it to the dry run's start and makes the project edit in place; discarding moves it there too, so the
  next proposal waits for new sessions instead of coming back the next night.
- **Reloads.** The new copy of the plugin runs `recover` before its first sweep: it watches and finishes a
  run left in `active-run`, ends one cut short while spawning (no thread id after two minutes), and ends
  host runs nobody watches once they are older than a dream can be. The old copy's watcher stops on
  dispose without finishing anything.
- **The sweep** tries each project once per window, so a failing one cannot loop, and starts nothing
  once the window has closed; a dream already running finishes.

## Off by default, and generic

- `scheduleEnabled` defaults to false. Never turn it on in a test bb or anyone's bb. Per-project switches
  default on, because the first dream of every project is a dry run that changes no memory.
- Nothing names a user, machine, path or project. Projects, checkouts and machines come from bb; the
  home folder, Claude Code's config folder and its environment overrides come from the dream machine.
- Data lives in the host data directory bb gives the plugin, not `~/.claude/dream-sweep/`: bb has a proper
  per-machine data folder, and the only writes in `~/.claude` are the memory itself and Claude Code's
  transcripts of dream threads.

## Testing against reality

Never dream a real project. A live check uses an isolated dev bb (root `AGENTS.md`) with a throwaway
repository whose tracked `.claude/settings.json` sets `autoMemoryDirectory` to a temp folder, so the
default `~/.claude/projects/<repo>/memory` is never created. Dream threads still write their transcripts
under `~/.claude/projects/`; delete the workspace folders you created when done. In the dev bb's first-run
screen, uncheck every project before *Continue*: importing real projects there would let its Dream
plugin see them.
