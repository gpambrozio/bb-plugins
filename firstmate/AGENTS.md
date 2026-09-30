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
| `server.ts` | Wiring only: settings, the RPCs, `bb firstmate`, the watch service, the thread events that publish `fleet`. Every decision lives in `server/`. |
| `shared/contract.ts`, `shared/types.ts` | The RPC contract (zod), the card and fleet shapes, the crew metadata keys, `STATE_DIR`. |
| `server/mate.ts` | Launch, adopt, release, restart, `askMate`; the `mate` lock; the stored id. |
| `server/crew.ts` | Steer, interrupt, end, relaunch, board note. |
| `server/fleet.ts` | The first mate's children joined to backlog items on `task`; the seven columns; `ReportCache`. |
| `server/cli.ts` | `bb firstmate crew spawn` and `bb firstmate tell`. |
| `server/bb-ports.ts`, `server/ports.ts` | The narrow `ThreadsPort` and `ProjectsPort` over `bb.sdk`, so everything else is tested against fakes. Where the machine rule below lives. |
| `server/store.ts` | `bb.storage.kv`: the first mate's thread id and the switched-off watches. Nothing else. |
| `server/settings.ts` | `bb.settings.define`: home directory, crew provider/model/reasoning, board refresh. |
| `server/home.ts`, `charter.ts`, `charter-file.ts` | Preparing the home; rendering `AGENTS.md`; the charter following the plugin until edited. |
| `server/backlog.ts`, `suggestions.ts`, `crew-report.ts` | Parsing `data/backlog.md`, `data/suggestions.md`, and a worker's closing status line. |
| `server/files.ts` | Confinement to the home (through symlinks) and `replaceTextIfUnchanged`. |
| `server/watch-schedule.ts`, `watch-files.ts`, `watch-run.ts`, `watches.ts`, `watch-delivery.ts` | Crontab parsing, which files are watches, one script run, the runner and its queue, and when the queue reaches the first mate. |
| `server/serialize.ts` | One-at-a-time per key. |
| `server/templates.ts`, `templates.generated.ts` | Reading the templates; the generated module. See below. |
| `server/testing/` | `createFakeSdk` and the other fakes. |
| `templates/` | **Everything the plugin writes into the home**, laid out as it lands there, plus `messages/` (what the plugin says to the first mate) and `parts/` (pieces inside other files). The first mate's behaviour is `templates/data/charter.md`. |
| `app.tsx`, `app/` | The `threadPanelAction` "FirstMate" (`panel.tsx` branches on the thread), the board and cards, the settings section, the command palette entries. |
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
- **Restart is refused unless the first mate is idle** (button and server), and clears context on the
  same thread, so crew stay its children and two first mates cannot exist.
- **Launch and adopt run under the `mate` lock**, and a launch that fails after the project exists stores
  no id.
- **Only the first mate spawns crew.** `crew spawn` refuses any other calling thread.
- **Templates are data.** The charter follows the plugin until the captain edits it, detected by
  fingerprint; then a changed plugin charter goes beside it as `data/charter.new.md` with a board notice.
  `captain.md` and `opening.md` are the captain's and never overwritten.
- **File access is confined to the home**, including through symlinks. Writes are a staged rename plus a
  content check.
- **Suggestions are removed by label and prompt**, not position. Nothing in code adds one.
- **Watch output reaches the first mate only between turns**, at most 32,000 characters in one message,
  `<` of anything tag-shaped escaped. Failures are queued once until the watch succeeds.
- **Titles never change; status lives in the section, the status line and `(hold: …)`.** The board's
  columns follow from those, not from the plugin's guesses.
- **Nothing throws into the server's event loop.** Services and listeners catch and log per tick;
  everything is released in `bb.onDispose`.
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
- **Watch notes show in full in chat.** bb's directives render only in assistant messages, so the
  Paseo trick of folding a note to one line has no equivalent.
- **The board is a thread tab, not a nav panel.** The first mate is a normal thread in bb's own chat; the
  Files view was dropped because its workspace is the home, which bb's file panel already opens.
- **End archives.** Immediate when the task is in the backlog's Done; otherwise a confirmation, because
  bb removes the worktree after its grace period and only committed work can be restored.
- **Relaunch is a message to the first mate**, which spawns the replacement with `--environment` set to
  the old worker's environment. The old thread stays stopped, not archived, so the shared worktree lives.

## What bb made moot

Dropped from the Paseo plugin, on purpose:

- `daemon-session.ts`, `cli.ts`, `send.ts`, `crew-seen.ts`, `home-name.ts`, `uploads.ts`,
  `shared/attachments.ts`, `data-dir.ts`, `host-imports.test.ts`, `sdk-types.ts`, `host-types.ts`.
- The heartbeat: bb notifies a parent when a child's turn completes, fails or is interrupted.
- Finding crew by label, the steer relay and its timing rules, clearing attention by raw frame,
  `activeTurnBehavior`, draft persistence on `globalThis`, home and project renaming through the CLI.
- On the client: the chat, transcript, Watch view, permission and question cards, context meter,
  attachments, drafts, keyboard handling, launch picker, Files view, column reordering and the drag split,
  and their pure helpers (`transcript-rows`, `activity-rows`, `questions`, `keys`, `open-file`,
  `file-links`, `markdown-parse`). Compact is bb's own `/compact`.

## What the first checks found

Run against bb 0.44.0 before the design was settled:

- **A turn the captain starts on a child notifies its parent.** The child's turn request records
  `initiator: "user"`, and the parent still receives `[bb system] @thread:<child> completed: …` after it.
  That is why the steer relay is not ported. Every crew turn wakes the first mate, whoever started it.
- **There is no composer slash-command API.** `app.composer.customize` takes only `actions`, `banners`,
  `plusMenu` and `richText`, and the slash typeahead is host-owned (skills only). So there is no `/fm`;
  the CLI (`bb firstmate tell`) and the command palette (FirstMate: open, bearings, ahoy) cover it.

The live run added two: a spawn needs a `hostId` (fixed, see the machine rule), and a crew spawn without
`--title` gets the brief's first line, which is the same "You are a crewmate" line for every brief, so the
charter tells the first mate to always pass `--title`.

## Known gaps

- **A crewmate waiting on a permission or question does not wake the first mate.** bb's parent
  notification covers a completed, failed or interrupted turn. The board shows the card as Blocked, and
  the first mate sees it on its next look (Bearings), not at once.
- **An interrupted turn keeps the previous status line.** `threads.output` returns the last assistant text
  of an earlier turn, so a worker interrupted before writing anything stays where its old line put it
  (say, Parked). Telling "this turn wrote nothing" apart needs the timeline.
- **Changing the crew settings does not re-render the first mate's `AGENTS.md`** until the next launch,
  restart or plugin reload. Settings changes do not reload a plugin.
- **Board read failures are logged with `console.error`**, not `bb.log`, so they do not appear in
  `bb plugin logs firstmate`. A failed metadata or interactions read on the board is silent to the user.
- **`fleet.load` returns the whole plugin charter template** (about 30 KB) on every poll, for a field only
  Compare uses.
- **The board UI has not yet been looked at** wide and narrow, light and dark. The live run had no display;
  everything behind it was driven over RPC.
- **A stored first-mate id that no longer resolves** ("first mate gone") and a captain-edited outdated
  charter were not staged live; both are unit-tested.

## Working here

```bash
cd firstmate
npm install --include=dev --cache "$TMPDIR/npm-cache"
npm run gen:templates            # after any change under templates/
npx vitest run
npx tsc --noEmit
bb plugin build
bb plugin reload firstmate       # read the exit code; a failed reload keeps the old instance
```

Test against the running bb from a scratch home (`bb plugin config firstmate set homeDirectory <path>`),
never `~/FirstMate`, and reset the setting afterwards. `bb plugin rpc call firstmate <method>` reaches
every RPC (`list` shows only discoverable ones). Never restart the bb server.
