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
| `host/code.ts` | The code a dream reads: the newest local default-branch commit, exported read-only, or the checkout. |
| `host/links.ts` | The links a dream left pointing at a memory that is gone. |
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
  Native takes it by write-and-read-back, which is not exclusive; the plugin adds an O_EXCL
  `.consolidate-lock.claim` around its check-and-write (exclusive between plugin processes) and reads
  the lock again after `SETTLE_MS`, giving up if a racing native dream rewrote it. That narrows the race
  with native to native's own read-back, it does not close it: a native contender that saw the lock free
  and stalls past the settle delay can still write after the plugin proceeded. Native auto-dream never
  runs in bb's SDK sessions and is behind a server flag, so the residual risk is an interactive Claude
  Code session dreaming the same repository at the same moment. **The owner accepted this residual risk
  (review pass 2, option a): do not build anything more for it**, such as requiring
  `autoDreamEnabled: false` or a lock heuristic, without asking. Rollback and marking only touch a lock
  that still holds the PID recorded with the run (`lockPid`), so a replacement host worker can still
  roll back what its predecessor took, and a rollback that finds another holder is reported in the run's
  log, never silently dropped.
- **The prompt** (`skills/dream/SKILL.md`): native's text, changed only where a bb dream differs — the
  transcripts are a manifest over several folders, the checkout is outside the working directory, and
  `CLAUDE.md` is read from the checkout rather than the system prompt. Native's "Reconcile memories
  against CLAUDE.md" section, which 2.1.326 ships but does not put in its prompt, is in, with AGENTS.md
  added beside CLAUDE.md. The team-memory section is not.

## Holding a bb thread to a dream's tool limits

bb's Claude Code provider has no per-thread tool list and no dontAsk mode: its least privileged mode is
accept-edits. But it starts sessions with the user, project and local settings sources, so a thread's
*working directory* decides its project settings. A dream therefore runs in its own workspace
(`<platform cache>/bb-dream/workspaces/<project id>/`, `host/workspace-root.ts`; never inside bb's data
folder, where bb 0.49 refuses a thread workspace with a 409, and `prepare` refuses rather than spawn
there), spawned as an unmanaged workspace of the project, whose
`.claude/settings.json` carries a PreToolUse hook on every tool. The hook, `guard.mjs`, answers allow or
deny and never ask, which is native's dontAsk dream. Do not move the dream into the checkout: writing
`settings.local.json` there would change the user's own sessions.

- **The guard fails closed.** Bad input, a missing policy or a crash answers deny with exit 2. It must
  also *answer*: a hook that prints nothing lets Claude Code fall back to its own permission check,
  which in accept-edits allows workspace writes and asks for the rest. Its main-script check compares
  real paths for that reason (run through macOS's `/var` symlink, a plain URL comparison silently
  skipped `main()`; a test runs it through a symlink).
- **Both hooks are `onFailure: "block"`**, so a guard that cannot start, crashes or times out blocks the
  call. Claude Code before the option ignores it, and `disableAllHooks` (restrictive: any source's
  `true` wins over the workspace's `false`), managed `allowManagedHooksOnly`,
  `CLAUDE_CODE_PERSONAL_HOOKS_OFF` and `CLAUDE_CODE_SIMPLE` switch hooks off. So:
  - `prepare` refuses (`no-guard`) when it can see any of those (`hookBlockers` in `host/memory.ts`);
  - **the session never loads memory at start.** Claude Code puts a session's memory index in its
    context before any hook runs, so `autoMemoryDirectory` points at the workspace's empty
    `startup-memory/` for the whole session, and the guard's policy starts *unarmed* (its memory folder is
    that empty one). The dream reads the real memory with tools, under the guard, once it is armed.
    `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` and a managed `autoMemoryDirectory` beat the workspace's
    setting, so `prepare` resolves the workspace's *effective* memory folder with the same resolver and
    refuses (`no-guard`) unless it is that empty folder (verified live: with the override set, a session
    quoted the real index despite the empty setting). Flag settings are not visible here;
  - **every dream starts with a canary turn**, before the thread sees any transcript or memory: Write
    `<workspace>/.dream-canary.md`. The guard allows that one path and logs it to `runs/<run id>.log`;
    a companion hook (`guard.mjs --canary-fail`, matcher `Write`) fails on it. The proof has two halves,
    both required: bb's record of that failed Write must carry the companion's own error, naming
    `--canary-fail` and `onFailure is "block"` (`blockedByCompanion`, so another hook's denial, which
    leaves its own error, cannot stand in for it), and the host must find the guard's log entry and no
    file (`checkCanary`). The host's verdict is stored with the run the first time and never changes, and
    the evidence stays until `finish`, so asking again cannot turn a failure into a pass. Only a pass arms
    the policy and sends the dream prompt, as a second turn. A pass is armed before it is stored and
    again on every repeat, so it is never answered unarmed. The send is fenced like a state write: the
    coordinator re-reads the run, records `running` first, and sends only if it still owns the run in
    `checking`, so a copy disposed while its proof was in flight sends nothing. A rewording of Claude
    Code's message fails the check, which fails closed.
- **Behind it**, anything that asks is stopped: the watcher ends a dream whose thread has a pending
  interaction, as a failure, within one poll.
- **Symlinks.** The guard walks a target with `lstat` and refuses a symlink it cannot resolve (a dangling
  link would create its destination, wherever it is). A dry run's copy holds regular files only, never
  links. Apply and restore never pass through the guard, so they check every target with
  `containedPath` (`host/snapshot.ts`): no symlink on the way, nothing outside the folder, before and as
  each file changes. `.git` and `agents` are protected at any depth and without case, in the guard and
  in the file walk alike.
- **The hook runs on the host daemon's own Node** (`process.execPath`); bb.app's is Electron, so the
  command sets `ELECTRON_RUN_AS_NODE=1` when `process.versions.electron` is set.
- `autoMemoryDirectory` in the workspace settings makes the session's auto-memory section name the folder
  the dream writes, which the prompt defers to for the memory format. An `Edit(//<memory>/**)` allow rule
  and the folder as an additional directory let bb's Bash sandbox through for `rm -f`.
- **What was verified live** (bb 0.49.0, Claude Code 2.1.326, isolated dev bb): a thread in a generated
  workspace was denied Write and Edit in the repository and in the workspace itself, `>>`, `touch`, `cp`,
  `find -delete`, `rm -f` outside memory and ToolSearch, with no approval prompt, and allowed reads, a
  memory write and a memory `rm -f`. A guard whose executable is missing, and one that times out, both
  blocked a workspace Write and a `touch` ("blocking because onFailure is block"). With `disableAllHooks`
  in a settings layer, the canary Write went through with nothing logged, which `checkCanary` refuses;
  with hooks on it was blocked and logged. A plugin dream ran its canary turn, then its dream turn.

## The code a dream reads

A checkout can be months behind its project (the owner's was: worktrees fetch and move
`origin/main`, the checkout's `main` stays put), so a dream checking memories against it deletes or
rewrites facts that are still true. `host/code.ts` picks the newest commit among the default branch's
local branch, its upstream and `origin/<branch>` (a descendant beats its ancestor; diverged ones go by
commit time), and the dream reads the checkout when HEAD is that commit, else a copy of the commit's tree in
`<platform cache>/bb-dream/code/<project id>/tree-<commit>/` (`host/tree-copy.ts`). Invariants:

- **No network.** Nothing fetches: no credential prompt, no surprise for a repository with no remote, no
  writes to the repository's refs. The copy is as fresh as the last fetch by anything (bb fetches when it
  makes a worktree). Do not add a fetch without asking: it is a product choice, not a fix.
- **The repository is only read**: `symbolic-ref`, `rev-parse`, `merge-base`, `log`, `ls-tree`,
  `cat-file`, with `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`. No `worktree add` (it writes
  `.git/worktrees`), no checkout, no pull.
- **A faithful copy, not `git archive`** (review pass 1): archive applies the repository's
  `.gitattributes`, so `export-ignore` dropped tracked files (a `docs/`, a `CLAUDE.md`) and
  `export-subst` grew 29 KB in git into 10 MB on disk past a limit counted from blob sizes. The copy
  lists the tree (`ls-tree -r -l -z --full-tree`) and reads raw blobs (`cat-file --batch`), which apply
  no attribute or filter; that also keeps Git LFS's smudge filter from running, which archive ran (a
  134-byte pointer became a 122 MB file, and smudge may download). LFS files stay pointers. Copies are
  named `tree-<commit>`, so a bare-`<commit>` folder an archive made is removed, never reused. Do not go back to archive, and do not add `--worktree-attributes`-style
  filtering.
- **The limit is on bytes written**, `MAX_CODE_BYTES` and `MAX_CODE_FILES`, checked as each chunk is
  written, not only from the listing; past it git is killed and the partial copy deleted, and the dream
  reads the checkout. Paths with an empty, `.`, `..` or `.git` part are refused, folders are made one at
  a time and checked to be real, files are created `wx`, and symlinks are made last, so no write goes
  through a link.
- **It never fails a dream.** Anything unexpected reads the checkout, and the prompt says why.
- The guard is unchanged: reads were never limited, and the copy is outside the memory folder, so the
  dream cannot write it.

## Links left dangling

`finish` scans the result (the memory, or a dry run's copy) for links to memory that is gone and records
them with the run (`danglingLinks`, host history, kv run log, notification, the proposal view). A
`[[name]]` counts only when `name` was a memory's file name or front matter `name:` when the run began
(`namesBefore`, kept with the run, since an in-place dream overwrites the evidence): Claude Code's memory
format allows a `[[name]]` with no memory yet. A Markdown link to a missing `.md` file always counts.
Links in code are examples and are skipped. The check reports; it never edits memory.

## Dreams are sessions too

A dream's transcript lands in `~/.claude/projects/<slug of its workspace>/`, which belongs to no project,
so it can never count. Belt and braces: `finish` records the dream thread's id and its session ids in
`state.json`, and status leaves out any worktree folder of a dream thread and any session of a dream.

## A run's life

A run is a state machine kept in kv (`active-run`, an `ActiveState`), saved at every step, so any copy
of the plugin carries it on; `loop` calls `recover` every minute, which drives it one more step:

- **preparing** (host, under one-at-a-time `exclusive`): lock, then backup (a dream) or copy (a dry run),
  workspace, `state.runs[runId]`, and a worker lease (released by `finish`, or after two hours) so the
  host worker outlives the five-minute idle stop. Saved *before* the host call, so a run is never
  invisible to the next copy.
- **spawning**: the thread starts with the canary prompt only. If the plugin was disposed while the spawn
  was in flight, the old copy stops the thread itself.
- **checking**: the first turn's end, then `checkCanary`, then the dream prompt (`threads.send`).
- **running**: the second turn, polled every 10 s until it ends, the thread fails, asks for anything, is
  stopped by hand (`stop-requested`), or 45 minutes from the start pass.
- **stopping**: `stop`, then wait for bb to say the thread is idle, failed or gone. Not confirmed: the run
  stays here, keeping the lock, and the next tick tries again. A writer that may still be alive never
  has its lock released.
- **finishing**: host `finish`, which is idempotent (a repeat answers what it recorded; an unknown run
  answers `found: false`). The marker is cleared only after it answers; then the log, the archive (a
  failed archive goes to `to-archive` and is retried, without holding anything) and the notification.

- **Two copies at once.** bb loads a new copy before it disposes the old one, so both may drive one run.
  Every write of the kv marker is fenced: never from a disposed copy, never over another run's marker,
  and a finalizer clears only its own run's marker and stop request. A late answer to the old copy cannot
  touch a run the new one started since.
- **Orphans.** An open thread of this plugin that cannot be confirmed stopped sets `orphans-unconfirmed`,
  which blocks the host's clean-up of unwatched runs (their locks stay) and every new start until a later
  tick confirms it.
- A run still **preparing or spawning** `START_GRACE_MS` after it began was left by a copy that went
  away: `recover` stops every open thread of this plugin (`threads.list` by `originPluginId`, hidden
  included), and only once all are confirmed stopped ends the run as failed. With **no run in kv**, any
  open thread of this plugin is an orphan and is stopped and archived the same way.
- **The lock's PID is the host worker's.** After a successful dream it stays for the lock's hour, as
  native's does, so *other* processes see it held. The plugin itself treats a lock holding its own PID
  with no run of its own in progress as free; otherwise a restore right after a bad dream was refused.
- **A dry run that is not applied never counts as a dream** (the owner's rule): not for the gate's
  baseline, not for the sessions the next prompt lists, not for due-ness. Its lock is always rolled back,
  whether it failed, proposed changes or proposed nothing, and discarding touches neither the memory nor
  the lock. Only applying (which moves the lock to the dry run's start and makes the project edit in
  place) or a real dream moves the baseline. So a project whose dry runs propose nothing, or are
  discarded, is dry-run again when it is next due.
- **The local-settings warning is for git repositories only.** `autoMemoryDirectory` set only in
  `settings.local.json` is reported because a git worktree checks out tracked files only. A folder
  outside git (`canonicalGitRoot` finds no `.git` folder or `.git` file up its parents, read without
  running git) has no worktrees, so every session reads that file and nothing is reported. Nor is it
  when bb copies the file into each new worktree: `worktreesGetLocalSettings` decides that as bb 0.49's
  git-worktree environment does (a `.worktreeinclude` in the checkout, committed or not, with a pattern
  line; `git ls-files --others --ignored --exclude-from=.worktreeinclude` lists the file; not a
  symlink). Use git's own matcher, never a hand-written gitignore one: negation and folder patterns are
  where they differ.
- **That check runs on every status read, so it may run no code and never block.** `.worktreeinclude` is
  opened no-follow and non-blocking, must be a regular file of at most 64 KB, and is read once with a
  bound; git gets a private copy of those bytes, never the checkout's path, which could be swapped for a
  FIFO or device. git runs with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, since a
  repository's fsmonitor program would otherwise run while it reads the index. Anything else, and the
  warning stays.
- **Always dry run** (a setting, off by default) is applied in the server's `beginOne`: it forces
  `mode: "dry-run"` for every run, scheduled, by hand or from the CLI, before the host is asked. Nothing
  else changes: the host's gate still refuses a project with a dry run waiting (manual runs too), and an
  unapplied dry run still never counts as a dream. The overview carries it, so the page and `bb dream
  status` say it.
- **The model is saved only by its Save button, and the saved one is always shown.** bb's
  `experimental_ProviderModelPicker` changes its own selection, and calls `onChange`, when the saved model
  or reasoning level is not one the machine's Claude Code lists (on mount, on a rerender, on a machine
  change; the screenshot dev bb's stub lists no reasoning levels, so it shows Low), so what it shows is not
  always what is saved and its `onChange` cannot tell the user's pick from its own. `app/settings-section.tsx`
  shows the saved model id and reasoning level as text, keeps a picker selection that differs as a draft
  with a "Not saved" notice and a Save button, and calls `setChoices` from that button only. Saving from
  `onChange` would change the user's model just by opening the settings; hiding the saved value behind the
  picker would leave them unable to tell what dreams use.
- **The sidebar badge** (`app/waiting-badge.ts`, `experimental_useBadge`) counts waiting dry runs from
  the host's `waiting` read: the proposal folders' `proposal.json` files only, no memory or transcript.
  The app asks once, on every `DREAM_CHANGED` (every end of a run, apply and discard goes through the
  server, which publishes it) and after a reconnect; never on a timer, which would keep the dream
  machine's host worker awake for good. Proposals of projects bb no longer has are left out. The server
  also publishes `DREAM_CHANGED` when bb says the dream machine connected or went away (`bb.sdk.subscribe`,
  `host:changed`), since a window whose own link never dropped has no other way to learn that a remote
  machine is back. A machine that cannot be asked answers `reachable: false`, which is not a count of none:
  the badge keeps its count until the machine answers, but only for that same machine. The answer names
  the dream machine (`hostId`), and a count from another one (the user picked a machine that is offline)
  is dropped, since Dream cannot apply that machine's dry runs.
- **Never dreamed means every session counts.** The last dream is the later of the lock's mtime (this
  plugin's dreams and native's) and `lastDreamAt` in the host state, which only an applied dry run (its
  start) or a real dream that did not fail sets, so a removed lock does not erase it. With neither, the
  project has never dreamed and nothing is left out, as native treats a missing lock. Never take the
  memory's newest `.md` as a baseline: Claude Code sessions write memory themselves, so it is only the
  last session that saved one, and hid nearly every session of real projects. A long backlog is bounded by
  `MAX_LISTED_SESSIONS` in the prompt instead. The newest `.md` (never the folder's mtime, which the
  lock's own coming and going changes) still drives the quiet-period check. Every gate reason says what
  it counts from.
- **The sweep** tries each project once per window, so a failing one cannot loop. It hands `begin` the
  window's end, which is checked again after `prepare` and before the spawn: a scan or a backup that
  runs past the end starts nothing, and a prepared run is ended (lock rolled back). A dream already
  running finishes.

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
