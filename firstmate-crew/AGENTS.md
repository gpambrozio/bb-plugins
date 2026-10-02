# AGENTS.md

A bb plugin: **FirstMate**. The captain talks to one "first mate" agent, an ordinary pinned bb thread, and it
runs a crew of worker threads, each in its own worktree. The plugin adds a board of the crew, a few
commands, a watch runner, and the charter the first mate follows. It is a port of the Paseo `firstmate`
plugin in `gpambrozio/paseo-plugins`; the design and its decisions are in
`docs/superpowers/specs/2026-09-29-firstmate-port-design.md`.

The repo root `AGENTS.md` covers what every plugin here shares: the per-folder npm layout, the commands,
the SDK surface, the dependency rules. This file covers only what is specific to `firstmate`. Checked
against bb 0.44.0 and `@get-bb/plugin-sdk` 0.5.29.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring only: settings, the RPCs, `bb firstmate-crew`, the watch service, the thread events that publish `fleet` (created, active, idle, failed, archived, and a pending interaction). Every decision lives in `server/`. |
| `shared/contract.ts`, `shared/types.ts` | The RPC contract (zod), the card and fleet shapes, the crew metadata keys, `STATE_DIR`. |
| `server/mate.ts` | Launch, adopt, release, restart, compact, `askMate`; the `mate` lock; the stored id. |
| `server/crew.ts` | Steer, interrupt, end, relaunch, board note. |
| `server/fleet.ts` | The first mate's children joined to backlog items on `task`; the seven columns; `ReportCache`. |
| `server/cli.ts` | `bb firstmate-crew crew spawn` and `bb firstmate-crew tell` (words or `--message-base64`, always under the relay line). |
| `server/bb-ports.ts`, `server/ports.ts` | The narrow `ThreadsPort` and `ProjectsPort` over `bb.sdk`, so everything else is tested against fakes. Where the machine rule below lives. |
| `server/store.ts` | `bb.storage.kv`: the first mate's thread id and the switched-off watches. Nothing else. |
| `server/settings.ts` | `bb.settings.define`: home directory, crew provider/model/reasoning, board refresh. |
| `server/home.ts`, `charter.ts`, `charter-file.ts` | Preparing the home; rendering `AGENTS.md`; the charter following the plugin until edited. |
| `server/backlog.ts`, `suggestions.ts`, `crew-report.ts` | Parsing `data/backlog.md`, `data/suggestions.md`, and a worker's closing status line. |
| `server/files.ts` | Confinement to the home (through symlinks) and `replaceTextIfUnchanged`. |
| `server/watch-schedule.ts`, `watch-files.ts`, `watch-run.ts`, `watches.ts`, `watch-delivery.ts`, `watch-notes.ts` | Crontab parsing, which files are watches, one script run, the runner and its queue, when the queue reaches the first mate, and the line the captain sees with the saved note behind it. |
| `server/serialize.ts` | One-at-a-time per key. |
| `server/log.ts` | The `Log` every server module logs through, wired to `bb.log` in `server.ts`. |
| `server/templates.ts`, `templates.generated.ts` | Reading the templates; the generated module. See below. |
| `server/testing/` | `createFakeSdk` and the other fakes. |
| `skills/fm/` | The `/fm` skill bb puts in every thread: it pipes the user's request, base64, into `tell --message-base64-stdin`. Its test is `server/fm-skill.test.ts`, because bb copies the skill's folder into threads whole. |
| `templates/` | **Everything the plugin writes into the home**, laid out as it lands there, plus `messages/` (what the plugin says to the first mate) and `parts/` (pieces inside other files). The first mate's behaviour is `templates/data/charter.md`. |
| `app.tsx`, `app/` | The `threadPanelAction` "FirstMate" (`panel.tsx` branches on the thread), the board and cards, the settings section, the command palette entries, and the overlay that expands watch notes in chat. |
| `components/ui/`, `lib/`, `hooks/` | Vendored shadcn components and helpers. |
| `scripts/gen-templates.mjs` | Writes `server/templates.generated.ts` from `templates/`. |

## Invariants

Do not break these; each was paid for.

- **The first mate is found only by `Store.mateThreadId()`.** Never by metadata, title or a list. Its
  `pluginMetadata {role: "first-mate"}` is for display, so a released first mate stays released.
- **Sends never interrupt.** The captain's words go with mode `"auto"` (crew steer: `"steer"`); watch
  output goes with `"queue-if-active"`, so a turn that started meanwhile holds it.
- **One message to the first mate in flight at a time** from the app (the board's buttons, suggestions and
  the command palette share `app/send-gate.ts`), so a double press sends once.
- **Restart and Compact are refused while the first mate is mid-turn** — they go only when the first mate
  is idle or errored (buttons and server). Restart clears context on the same thread, so crew stay its
  children and two first mates cannot exist.
- **Launch and adopt run under the `mate` lock**, and a launch that fails after the project exists stores
  no id.
- **Only a thread whose workspace is the home can be adopted** (compared by real path, on the bb server's
  machine). The charter is the home's `AGENTS.md`, and the board opens home files through the first
  mate's environment, so a first mate working elsewhere would see neither.
- **Only the first mate spawns crew.** `crew spawn` refuses any other calling thread.
- **A relayed message is a request, never the captain's word.** Every message `tell` delivers opens with
  `Relayed by bb firstmate-crew tell, from …:` (`RELAY_PREFIX` in `server/cli.ts`, named in the charter;
  a test ties the two). The thread it names is `ctx.threadId`, which the caller's `BB_THREAD_ID` sets, so
  the line says "as the sender claims"; project and branch are bb's for that id, on one line. Nothing
  authenticates the person behind a relay, so the charter limits what one can do instead: the first mate
  may start or steer work for it, but merges, anything destructive or irreversible, publishing,
  credentials and settings need the captain in its own chat. Messages from the board and the command
  palette are not relays and go unmarked.
- **`tell` never reads a file.** Text arrives as words or as `--message-base64` (the skill uses bb's
  `--message-base64-stdin`, read on the caller's machine), strict base64 of at most 12 KiB of UTF-8, sent
  exactly as decoded. A server-side file read would let a sandboxed caller relay any file the server can
  read, and would only work on the server's machine.
- **`/fm` is the user's to start.** `tell` speaks for the captain, so the skill is hidden
  from the model (`disable-model-invocation: true` for Claude Code, `agents/openai.yaml`
  `allow_implicit_invocation: false` for Codex) and its description says it is user-triggered. bb keeps
  frontmatter keys it does not know and copies the folder as it is.
- **Templates are data.** The charter follows the plugin until the captain edits it, detected by
  fingerprint; then a changed plugin charter goes beside it as `data/charter.new.md` with a board notice.
  `captain.md` and `opening.md` are the captain's and never overwritten.
- **File access is confined to the home**, including through symlinks. Every read, write and delete the
  plugin makes there goes through `server/files.ts` (`resolveInHome` and the `*InHome` helpers): preparing
  the home, the charter, the built-in watches, `watches.json` and `watch-state/`, and the notes. A folder
  the plugin lists, runs or prunes by name — `watches/` and `.firstmate/watch-notes/` — must also be a
  plain folder at its place (`plainFolderInHome`), so a link cannot send it to any other folder. A link
  that leads out is refused, never followed. Writes are a staged rename (which replaces a link rather
  than writing through it) queued per path as written, before it is resolved; creations are exclusive;
  edits of files the first mate or the captain also write add a content check. The automatic updates
  of `data/charter.md` and the built-in watches go through `updateInHome`: a copy that changes between
  being assessed and replaced is read and assessed again, so an edit saved meanwhile is kept. The runner's saves go in the order
  they are asked for, each taking its snapshot when its turn comes.
- **One watch runner at a time, drained before the next.** `WatchRunner.stop()` resolves only once its
  ticks, runs, deliveries and saves have settled, and `server.ts` changes runners through `syncRunner`,
  one change at a time, so a delivery still sending cannot overwrite what a new runner saved.
- **Suggestions are removed by label and prompt**, not position. Nothing in code adds one.
- **Watch output reaches the first mate only between turns**, at most 32,000 characters in one message,
  `<` of anything tag-shaped escaped. Failures are queued once until the watch succeeds.
- **Titles never change; status lives in the section, the status line and `(hold: …)`.** The board's
  columns follow from those, not from the plugin's guesses.
- **Nothing throws into the server's event loop.** Services and listeners catch and log per tick;
  everything is released in `bb.onDispose`.
- **Server code logs only through the injected `Log` (`server/log.ts`), wired to `bb.log`**, never
  `console`, whose output does not reach `bb plugin logs firstmate-crew`.
- Colour only through semantic Tailwind classes.

## Decisions to keep

- **No `bb.host`.** The home and the watch scripts live on the machine running the bb server, and the
  plugin reads and writes them from `server.ts`. That is wrong the day the captain wants the first mate's
  home on another enrolled machine; it was chosen because the first mate's home is a local directory
  registered as a project, and every crew spawn resolves to the server's machine anyway (below). Watches
  run only while bb does, on that machine, in its local time.
- **The machine rule for spawns.** bb 0.44 rejects a spawn into a host workspace without a `hostId`
  (only `personal` is exempt). The home gets the server's primary host (`system.config().primaryHostId`).
  A crew worktree gets the host of the project's source on the server's host if it has one, else the
  project's default source, else the first source. Reusing an environment names no machine. A project
  with no machine fails with a sentence that says so. All in `server/bb-ports.ts`.
- **Why the templates are generated.** `bb plugin build` compiles the server into one script in bb's
  cache, and nothing at run time names the plugin's folder. So `templates/` is the source of truth and
  `npm run gen:templates` writes it into `server/templates.generated.ts`, which is checked in. A test
  fails when the two differ byte for byte; run the script after any change under `templates/`.
- **Changing the charter changes a pinned fingerprint.** Every untouched home follows the plugin's
  charter and every edited one is offered the new one, so a charter change is deliberate:
  `server/charter-file.test.ts` pins the fingerprint of `templates/data/charter.md` with a history
  comment. Change the charter, run `npm run gen:templates`, run the tests, read the new fingerprint from
  the failure, repin it and add a line to the history.
- **Watch state is files, not kv.** The runner's queue and each watch's last run are
  `<home>/.firstmate/watches.json`, and each script's own state is `<home>/.firstmate/watch-state/<name>/`.
  The queue can reach 20 runs of 16,000 characters, past kv's 256 KB per value, and the state belongs with
  the home it describes. Only `disabledWatches` (a short list of names) is in kv.
- **Watches are plugin-owned, not bb automations.** bb's automations run a stored snapshot and do not
  deliver a run's output to a thread.
- **A watch note is a line for the captain and the whole message for the agent.** bb's directives render
  only in assistant messages and a plugin cannot restyle a user message, so the note is sent as two text
  inputs: a visible line ending in a path mention (the "full note" chip) to the message saved in
  `<home>/.firstmate/watch-notes/`, and the whole message with `visibility: "agent-only"`. The first
  mate's workspace is the home, so the mention's workspace-relative path opens there. A note that cannot
  be saved goes whole, as a plain message, with a warning in the log.
- **The chip expands in place through an app overlay** (`app/watch-note-expander.tsx`). It catches clicks
  on chips whose `data-prompt-mention-resource` names a note, stops bb opening the file, and portals the
  note — read back into runs by the `watch.note` RPC — after the chip's block. That attribute is bb's
  markup, not the SDK's contract: if it changes, the chip falls back to opening the file, and the first
  mate is unaffected. Check it after a bb upgrade.
- **While a first mate is aboard, its own workspace is the home** (`activeHome` in `server/mate.ts`). The
  board, End's check, suggestions, the charter, restart, the watches and the notes all use it; the home
  setting names only where the next launch or adoption goes. So changing the setting mid-voyage cannot
  mix another home's backlog, charter or watches with this crew. With no first mate, the setting is
  the home.
- **The board is a thread tab, not a nav panel.** The first mate is a normal thread in bb's own chat; the
  Files view was dropped because its workspace is the home, which bb's file panel already opens.
- **End archives.** Immediate when the task is in the backlog's Done; otherwise a confirmation, because
  bb removes the worktree after its grace period and only committed work can be restored.
- **The board's gear opens `/settings/plugins/firstmate-crew` by pushing that route.** The panel SDK hands
  `openSettings()` only to sidebar-footer actions; bb 0.44's app routes plugin settings there and uses
  react-router browser history, so `app/open-plugin-settings.ts` pushes the route with the router's
  `{ usr, key, idx }` state and dispatches `popstate`. It is an internal route: if a bb upgrade moves it,
  the gear lands on a not-found page, and this is the place to fix.
- **Relaunch is a message to the first mate**, which spawns the replacement with `--environment` set to
  the old worker's environment. The old thread stays stopped, not archived, so the shared worktree lives.

## What bb made moot

Dropped from the Paseo plugin, on purpose:

- `daemon-session.ts`, `cli.ts`, `send.ts`, `crew-seen.ts`, `home-name.ts`, `uploads.ts`,
  `shared/attachments.ts`, `data-dir.ts`, `host-imports.test.ts`, `sdk-types.ts`, `host-types.ts`.
- The heartbeat: bb notifies a parent when a child's turn completes, fails or is interrupted, and when
  the child needs attention (blocked on a permission or a question).
- Finding crew by label, the steer relay and its timing rules, clearing attention by raw frame,
  `activeTurnBehavior`, draft persistence on `globalThis`, home and project renaming through the CLI.
- On the client: the chat, transcript, Watch view, permission and question cards, context meter,
  attachments, drafts, keyboard handling, launch picker, Files view and the drag split,
  and their pure helpers (`transcript-rows`, `activity-rows`, `questions`, `keys`, `open-file`,
  `file-links`, `markdown-parse`). Compact asks bb for its own `/compact` turn (`threads.compact`).

## What the first checks found

Run against bb 0.44.0 before the design was settled:

- **A turn the captain starts on a child notifies its parent.** The child's turn request records
  `initiator: "user"`, and the parent still receives `[bb system] @thread:<child> completed: …` after it.
  That is why the steer relay is not ported. Every crew turn wakes the first mate, whoever started it.
- **There is no composer slash-command API.** `app.composer.customize` takes only `actions`, `banners`,
  `plusMenu` and `richText`, and the slash typeahead is host-owned: it lists skills. So `/fm` is a skill
  (`skills/fm/`), which bb imports into every thread; Claude Code receives the typed `/fm …` as is.

- **A crewmate blocked on a permission wakes the first mate.** bb sends the parent a system message
  (`systemMessageKind: "child-needs-attention"`): `@thread:<child> needs help. Blocked on file-change
  approval: …`, and the live run's first mate approved it from there. Questions go through the same
  pending-interaction path but were not staged live.

The live run added two: a spawn needs a `hostId` (fixed, see the machine rule), and a crew spawn without
`--title` gets the brief's first line, which is the same "You are a crewmate" line for every brief, so the
charter tells the first mate to always pass `--title`.

## Known gaps

- **A `/fm` request is capped at 12 KiB.** bb 0.44's `--<flag>-stdin` takes one line of at most 16 KiB,
  which base64 makes 12 KiB of text. The multi-line `--stdin` that `bb guide plugins` describes is not in
  0.44's CLI; it could lift the cap when it is.
- **`/fm` has not been run in a live thread.** It was built without reloading the plugin, which the
  running first mate depends on. That bb passes Claude Code the typed `/fm …` unchanged was read from bb
  0.44's provider code. `agents/openai.yaml` is Codex's skill policy and is untested here.

- **An interrupted turn keeps the previous status line.** `threads.output` returns the last assistant text
  of an earlier turn, so a worker interrupted before writing anything stays where its old line put it
  (say, Parked). Telling "this turn wrote nothing" apart needs the timeline.
- **Changing the crew settings does not re-render the first mate's `AGENTS.md`** until the next launch,
  restart or plugin reload. Settings changes do not reload a plugin.
- **The board UI has not yet been looked at** wide and narrow, light and dark. The live run had no display;
  everything behind it was driven over RPC.
- **A stored first-mate id that no longer resolves** ("first mate gone") and a captain-edited outdated
  charter were not staged live; both are unit-tested.

## Working here

```bash
cd firstmate-crew
npm install --include=dev --cache "$TMPDIR/npm-cache"
npm run gen:templates            # after any change under templates/
npx vitest run
npx tsc --noEmit
bb plugin build
bb plugin reload firstmate-crew       # read the exit code; a failed reload keeps the old instance
```

Test against the running bb from a scratch home (`bb plugin config firstmate-crew set homeDirectory <path>`),
never `~/FirstMate`, and reset the setting afterwards. `bb plugin rpc call firstmate-crew <method>` reaches
every RPC (`list` shows only discoverable ones). Never restart the bb server.
