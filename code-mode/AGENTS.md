# code-mode — notes for agents

A per-thread choice to run a bb Claude Code thread in Claude Code's experimental Code Mode. New here,
not a Paseo port. The design came from a scout of the options (a plugin provider, a provider setting,
a global wrapper, get-bb); this is the one that works today with no bb change, no `bb-app env set` and
no restart. Read the repository's `AGENTS.md` first.

## How it works

- Claude Code takes the Code Mode opt-in for an Agent SDK session only from the `env` block of
  `--settings` (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE="1"`); a process variable is ignored, and bb's
  provider settings have no `env`. So a wrapper is needed.
- `bb.providers.experimental_contributeEnv("claude-code", resolve)` adds variables to bb's built-in
  Claude Code provider per command (start, resume, fork, turn), with `{ threadId, projectId, hostId }`.
  The bridge reads `BB_CLAUDE_CODE_EXECUTABLE` from that per-thread env, so returning the wrapper's
  path routes one thread through it (`server/policy.ts`, `resolveEnv`).
- The `message.dispatch` hook records the choice on a thread's first message (`server/policy.ts`,
  `dispatchHook`; the rules are `server/decide.ts`), from `composer.submit({ experimental_data })`
  ("Send in Code Mode", `app/send-menu.ts`), the project default, the spawned-threads setting, or the
  fork source. The record is this plugin's thread metadata (`shared/record.ts`).
- The host entry writes the wrapper into `<daemon data dir>/plugins/code-mode/host-data/` on each machine
  (`host/install.ts`): `bb-claude-code-mode`, a `/bin/sh` launcher, and `code-mode-wrapper.mjs`, run with
  the daemon's own Node (`process.execPath`; bb.app's is Electron's binary, hence
  `ELECTRON_RUN_AS_NODE=1` on that one command). The script prints a plan and the launcher `exec`s the
  real claude, so bb's signals and exit status reach claude unchanged. No Python.
- `wrapper/code-mode-wrapper.mjs` is the source; `host/wrapper.generated.ts` carries it into the host
  bundle (the plugin's folder is not reachable at run time). Run `npm run gen:wrapper` after editing it;
  a test fails while they differ.

## Invariants

- **A thread's answer never changes.** A session started in Code Mode can resume only in Code Mode, and
  bb keeps the executable it picked until the thread stops. The record is written once
  (`records.decideOnce`, serialized per thread) and never updated; the cache needs no invalidation.
  Never add a way to switch an existing thread.
- **Threads without a record that predate the plugin, or that already finished a turn, get nothing**, and
  nothing is written on them. `installedAt` (kv) marks the first load.
- **The resolver must be fast and must not throw.** bb gives it five seconds and contributes nothing on an
  error or timeout, which breaks a Code Mode thread's resume. It answers from memory after the first
  read; a machine's wrapper path is kept in memory and kv and re-checked in the background
  (`server/wrappers.ts`); only a never-checked machine waits, for at most three seconds.
- **"Send now" on a queued message skips every dispatch hook**, so the resolver decides a thread with no
  record by the defaults (`decideAtStart`). It never sees `experimental_data`, so "Send in Code Mode"
  can't reach it; that data is delivered only on a send's first dispatch attempt.
- **Project switches are keyed by project name, not id** (`shared/config.ts`, the owner's choice): bb
  often has one project per machine, or two checkouts, under one name, and they share one switch, which
  a project added later with that name follows. The hook reads the name from its context
  (`ctx.project.name`); the resolver's fallback looks it up (`projects.get`). A pre-release build stored
  switches by id; `server/config-store.ts` turns those into names on the first read. Renaming a project
  moves it to the other name's switch.
- **Select all on Machines turns on only machines whose wrapper check passes** (`app/select-all.ts`), so
  it never quietly turns on one where Code Mode can't start; the rest stay off with their reason shown.
- **A thread is recorded as Code Mode only where the wrapper is ready** (`requireWrapper` in
  `server/decide.ts`): an explicit send is refused with the machine's name and the reason, a default
  leaves the thread off. A record without the wrapper would start with the ordinary tools.
- **The Send-menu rows read a module store** (`app/composer-facts.tsx`): bb asks a row's `disabled`
  synchronously with only the composer, and fixes its label and description at registration, so a
  `ComposerFacts` composer contribution that draws nothing keeps the switches, the machines' wrapper
  statuses (`hosts.status`, tag `hosts`) and the names there. A row can be greyed out, never hidden, and
  its reason can't be shown in the menu (SDK 0.6.157). The composer's `selection.environment` names the
  machine (`host` or `provider` environments; checked live, "Project checkout" included).
- **No host call from the factory.** bb refuses host calls while a plugin loads ("host plugin calls are
  unavailable during factory registration"). The load-time wrapper check once ran from the factory, failed
  on every machine, and was kept as each machine's status, so after any reload both Send-menu rows were
  greyed out on a machine that was on. The checks run in the `machine-checks` background service
  (`server/machine-checks.ts`), which also re-checks machines that are on but not ready every five
  minutes. `server.test.ts`'s fake refuses host calls while loading.
- **The machine switch gates new decisions only.** A Code Mode thread keeps getting the wrapper after its
  machine is turned off; the wrapper is written on demand.
- **The dispatch hook runs under bb's server-wide dispatch lock**: no slow work there. Config is cached in
  memory (`server/config-store.ts`), settings through `onChange`.
- **The model guard** refuses, on every message to a Code Mode thread, a model `shared/model.ts` knows
  can't run Code Mode; an id it can't parse (an alias) goes through, for Claude Code to decide.
- **The wrapper never logs arguments or environment values**; prompts and tokens live there.

## What the live run showed (bb 0.50.1, Claude Code 2.1.332)

- Thread sent with "Send in Code Mode": `repl-mode: true` in its transcript and `REPL` calls; an ordinary
  thread in the same project never touched the wrapper. Stop and a follow-up resumed in Code Mode; the
  model guard refused `claude-opus-5` with its message.
- **A fork's transcript has no Code Mode marker.** bb forks through the Agent SDK, which copies the
  conversation (REPL calls included) and later adds a `derived-from` entry, but no `repl-mode` entry, and
  the first launch sees neither. With the flag set, Claude Code turns Code Mode on for such a session. So
  the wrapper adds the flag to every resumed session except one whose last marker says `replMode: false`.
  An earlier rule ("no marker means it started without Code Mode") left forks on ordinary tools.
- Context-breakdown probes (`--resume … --fork-session --no-session-persistence`) also launch through the
  wrapper; expect one or two extra log lines per turn.

## Testing

- `npm test`: the rules (`server/decide.test.ts`, `shared/model.test.ts`), the sticky record, the wrapper
  paths, the server through the SDK's fake host (`server.test.ts`: hook and resolver together, forks,
  host opt-in, the fallback, reloads), the wrapper's decisions and the launcher run for real through
  `/bin/sh` with a fake claude (`host/wrapper.test.ts`), and the app's pieces.
- `shots/shots.mjs` (run from `tools/shots`) takes the Send menu and the settings page. The screenshot dev
  bb's Claude Code is a stub, so `docs/screenshots/thread-menu.png` and `send-in-code-mode.gif` came from a
  dev bb running the real Claude Code instead (its own data dir and ports, started under `env -i`: a
  Claude Code session's own `CLAUDE_CODE_*` variables make Code Mode refuse). Such a run writes
  transcripts into `~/.claude/projects/<scratch folder>` and `~/.claude/session-env/<session id>`; delete
  them afterwards.
