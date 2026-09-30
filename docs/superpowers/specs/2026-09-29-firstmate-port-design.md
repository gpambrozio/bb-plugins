# FirstMate port to bb — design

Issue: [#6 Port firstmate to bb](https://github.com/gpambrozio/bb-plugins/issues/6).
Source: `gpambrozio/paseo-plugins/firstmate` (its `README.md` and `AGENTS.md` are the behavioural spec).
Checked against bb 0.44.0 and `@get-bb/plugin-sdk` 0.5.29.

## Intent

You talk to one "first mate" agent; it runs a crew of worker threads, each in its own worktree, and
brings back finished work and only the decisions that are yours. The plugin never decides what a worker
does — the first mate does, following a charter in its home. The port keeps that behaviour and drops
everything that existed only because Paseo lacked native supervision or a chat UI a plugin could reuse.

## Decisions

| Question | Decision |
| --- | --- |
| Where the first mate and board live | **bb-native, thin.** The first mate is an ordinary pinned bb thread you chat with in bb's own chat. The board is a `threadPanelAction` tab. No dedicated nav panel. |
| Files view | **Dropped.** The first mate's workspace is the home, so bb's own file panel opens and edits it. |
| Crew dispatch | **A plugin CLI** — `bb firstmate crew spawn` — for the one crew-specific step; plain `bb thread …` for everything else. |
| Restart | `threads.clearContext` on the same thread, then the opening + restart note. |
| End on a card | Archives. Immediate when the task is in the backlog's Done; otherwise a confirmation naming the worktree's removal. |
| Watches | Plugin-owned runner (built-in automations run a stored snapshot and do not deliver output to a thread). |
| `bb.host` | Not used. The home and watch scripts live on the bb server's machine. Recorded in `firstmate/AGENTS.md`. |

## What bb already gives (not ported)

- **Supervision.** A child thread notifies its parent when a turn completes, fails or is interrupted —
  Paseo's `notifyOnFinish`, and the reason the heartbeat goes.
- **Restart keeps the crew.** Clearing context keeps the thread id, so children stay children.
- **Crew operations.** `tell` (steers by default), `stop`, `compact`, `markRead`, context usage,
  interactions (questions, permissions, plans), attachments.
- **The chat.** Transcript, composer, question forms, the context meter, a worker's live view.

So these Paseo parts are dropped: `daemon-session.ts`, `cli.ts`, `send.ts`, `crew-seen.ts`,
`home-name.ts`, `uploads.ts`, `shared/attachments.ts`, `data-dir.ts`, `host-imports.test.ts`,
`sdk-types.ts`, `host-types.ts`, and on the client the chat, transcript, Watch view, permission and
question cards, context meter, attachments, drafts, keyboard handling, launch picker, Files view and
their pure helpers (`transcript-rows`, `activity-rows`, `questions`, `keys`, `open-file`,
`file-links`, `markdown-parse`). The issue lists some of those helpers under "carry over"; the thin UI
makes them moot, and the issue is to be updated to say so.

## Architecture

### Where things live

- **Home** — a directory holding the charter, records and `watches/`, registered as a bb project named
  **FirstMate**. Default `~/FirstMate`, set in the plugin's settings. Outside bb's plugin data on
  purpose: `bb plugin remove` deletes that, and the home is the captain's records.
- **First mate** — a visible, pinned bb thread in the FirstMate project, working in the home's checkout.
  Found **only** by the id stored in `bb.storage.kv` (`mateThreadId`). It is seeded with
  `pluginMetadata {role: "first-mate"}` for display, never for lookup, so a released first mate stays
  released.
- **Crew** — child threads of the first mate (`parentThreadId`), each created in its target project in a
  new worktree, seeded with `pluginMetadata {role: "crew", task, kind, project}`. Visible in bb's sidebar
  under the first mate.

### Server — `server.ts` and `server/`

Carried from Paseo with their tests, Paseo wiring removed:

| Module | Owns |
| --- | --- |
| `backlog` | `data/backlog.md` → items. Lenient. |
| `suggestions` | `data/suggestions.md` → suggestions; removal by label and prompt via one scanner. |
| `crew-report` | A worker's closing status line → state and text. |
| `charter`, `charter-file` | Rendering `AGENTS.md`; `data/charter.md` following the plugin until edited (fingerprint), `charter.new.md`, acknowledge. |
| `templates` | Reading `templates/`; the `TEMPLATES` list; `fill` and `withoutNotes`. |
| `home` | Preparing the home: write-once records, charter sync, `icon.svg`. |
| `files` (subset) | Home confinement (through symlinks) and `replaceTextIfUnchanged` (staged rename, content check). |
| `watch-schedule`, `watch-files`, `watch-run`, `watches` | Crontab parsing, which files are watches and seeding built-ins, one script run (process group, timeout, capped stdout), the runner and its queue. |
| `serialize` | One-at-a-time per key. |

New:

| Module | Owns |
| --- | --- |
| `fleet` | Lists the first mate's children (`threads.list({ parentThreadId })`), reads their metadata and closing text, joins them to backlog items on `task` (items with no worker, and workers with no item, are cards of their own), assigns columns. |
| `mate` | Launch, adopt, release, restart; the lock; the stored id. |
| `crew` | Steer (`threads.send`), interrupt (`threads.stop`), end (`threads.archive`), relaunch (a message to the first mate), board note. |
| `cli` | `bb firstmate crew spawn`, `bb firstmate tell`. |
| `watch-delivery` | When and how the watch queue reaches the first mate. |
| `settings` | `bb.settings.define`: home directory, crew provider/model/reasoning (optional), board refresh interval. |

RPC contract (`defineRpcContract`, zod): `fleet.load`, `mate.launch`, `mate.adopt`, `mate.release`,
`mate.restart`, `mate.command` (bearings/ahoy with optional words), `mate.ask` (a suggestion or note),
`crew.steer`, `crew.interrupt`, `crew.end`, `crew.relaunch`, `crew.note`, `suggestion.remove`,
`charter.compare`, `charter.acknowledge`, `watch.toggle`.

### App — `app.tsx`

- **`threadPanelAction` "FirstMate"**, one component that branches on the thread:
  - the first mate → **the board** (below);
  - a crew thread → that worker's card with its actions and a note box that tells the first mate
    something about it;
  - any other thread → "No first mate" with **Adopt this thread** (or, with a first mate aboard, a link
    to it).
- **`settingsSection`** — first mate status; `experimental_ProviderModelPicker` + **Launch**; **Release**;
  **Restart** (with confirmation).
- **`app.commands.register`** — FirstMate: open, bearings, ahoy.
- No `/fm` composer slash command: `app.composer.customize` has no slash registration (see *Open
  items*). The CLI and the command palette cover it.

Styling uses semantic Tailwind classes only; checked wide and narrow, light and dark.

## Lifecycle

### Launch

Under the `mate` lock; refused when a stored first mate still resolves.

1. Prepare the home: create missing records, sync `data/charter.md`, render `AGENTS.md`, seed watches,
   write `icon.svg` if missing.
2. Find the project whose root is the home, or create it named **FirstMate**.
3. `threads.spawn` in the home checkout with the picked provider/model, title "First mate",
   `pluginMetadata {role: "first-mate"}`, and `data/opening.md` (notes stripped; template wording if
   empty) as the prompt.
4. Pin it; store its id.

**Adopt** stores the id of an existing thread (after preparing the home). **Release** forgets the id;
the thread and its crew are untouched.

### Restart

Refused unless the first mate is idle (button and server both). `threads.clearContext`, then send the
opening followed by `messages/restart-note.md`. Same thread id: crew stay its children and keep
notifying it, and two first mates cannot exist. The old conversation stays above bb's "Context cleared"
boundary.

### Compact

Not the plugin's; bb's composer has `/compact`.

## Data flow

1. The captain writes in the first mate's bb chat. It reads its charter, writes the backlog.
2. It runs `bb firstmate crew spawn --task <id> --project <project> --prompt-file data/<task>/brief.md
   [--kind <kind>] [--environment <env>] [--provider … --model …]`.
3. The plugin refuses unless the calling thread is the stored first mate; applies the crew
   provider/model from settings unless flags override; `threads.spawn` with `parentThreadId` = first
   mate, `--new-environment worktree` (or the given environment, for a relaunch), and the crew metadata.
   Prints the new thread id.
4. bb notifies the first mate when the worker finishes a turn or fails. The first mate reads the status
   line, updates backlog and suggestions.
5. `bb.events` `thread.created` / `thread.idle` / `thread.failed` for the first mate or any of its
   children → `bb.realtime.publish("fleet")`; the open board re-fetches. A poll at the settings interval
   covers backlog and suggestion edits, which raise no event.

### Card actions

- **Steer** — `threads.send` to the worker (steer mode). Its finished turn notifies the first mate
  natively, so the Paseo steer relay is not ported.
- **Interrupt** — `threads.stop`.
- **Relaunch** — `messages/relaunch.md` to the first mate with the captain's note and the worker's
  environment; the first mate spawns a fresh worker there.
- **End** — `threads.archive`. Immediate when the task is in the backlog's Done; otherwise a confirmation
  that the worktree will be removed after bb's grace window and only committed work can be restored.
- **Open thread** — `useBbNavigate().toThread`.

## Board

- Columns and their rules come across unchanged from `server/fleet.ts`: a pending interaction →
  Blocked, an error → Failed, a running turn → Working; after the turn the status line decides; an ended
  turn with no status line, or a `done:`/`resolved:` one, → Idle (the card keeps the status line and any
  hold); Done only for items the backlog records as Done; Queued and Parked from the backlog.
- Laid out as **stacked foldable sections** in Paseo's default order (Queued, Working, Blocked, Parked,
  Done, Failed, Idle), empty ones hidden, folds remembered in
  `localStorage`. No column reordering, no side-by-side columns, no drag split.
- A card: title, the worker's last word, PR link, "Captain's call" hold, actions.
- Above the columns: the charter notice (Compare opens `data/charter.new.md` in bb's file viewer; Done
  acknowledges), Bearings and Ahoy buttons, the suggestions card. Below: the Watches card.

## Suggestions

`data/suggestions.md`, `- <label> :: <prompt>`, parsed on every fleet load. Pressing one sends its
prompt to the first mate with `mode: "auto"` (steers a live turn, starts one when idle — never
interrupts). The trash removes it by label and prompt through `replaceTextIfUnchanged`, retrying on a
concurrent write up to `REMOVE_ATTEMPTS`; `suggestion-removals` (pure) gates double presses. Nothing in
code adds a suggestion.

## Watches

- A watch is an executable in the home's `watches/` with `# schedule: <crontab>` near the top, in the
  server's local time. `pr-watch` ships built in and follows the plugin until edited (fingerprint).
- A `bb.background.service` ticks on each minute boundary and runs what is due, enabled and valid. A run
  is its own process group with a timeout, SIGTERM then SIGKILL; a stop aborts runs and starts none
  after. A watch still running when due again is skipped.
- Non-empty stdout is queued, `<` of anything tag-shaped escaped; a failure is queued once with stderr's
  tail and marks the watch failing until it succeeds.
- **Delivery:** when the queue is non-empty and the first mate is idle (on its `thread.idle` event or a
  tick), send **one** message — `watch-*.md` blocks, oldest first, newest always kept, at most 32,000
  characters, `<firstmate-watch-dropped count="N"/>` leading when some were dropped — with
  `mode: "queue-if-active"`, so a turn that started meanwhile holds it rather than being steered into.
- `disabledWatches` lives in `bb.storage.kv`, toggled under `serialize`. The runner's queue and last-run
  state stay a file, `<home>/.firstmate/watches.json`, with each script's state directory under
  `<home>/.firstmate/watch-state/<name>/`: the queue can reach 20 × 16,000 characters, past kv's 256 KB
  per value, and the state belongs with the home it describes.
- Watch notes show in full in bb's chat (Paseo folded them to a line; bb's directives render only in
  assistant messages).

## Charter and templates

- `templates/` is data, not code: the files are the source of truth, laid out as they land in the home.
  bb compiles `server.ts` into its own cache and names no plugin folder, so `npm run gen:templates`
  writes them into a checked-in `server/templates.generated.ts`, and a test fails when the two differ.
- `templates/data/charter.md` is **rewritten** for bb: §0 says it lives in bb and names the vocabulary —
  `bb project list`, `bb thread list --parent-thread $BB_THREAD_ID`, `bb firstmate crew spawn`,
  `bb thread tell|show|output|stop`. The heartbeat is removed. The hard rules stay: never write to a
  project, never merge without the captain's word (or `+yolo`), never throw away unlanded work; titles
  never change; status lives in the section, the status line and `(hold: …)`.
- Kept: `captain.md` and `opening.md` are the captain's and never overwritten; the charter follows the
  plugin until edited, `charter.new.md` + board notice when it moves on; an emptied charter goes back to
  the plugin's.
- Messages: `bearings`, `ahoy` (each with an `-args` form), `relaunch`, `restart-note`, `watch-output`,
  `watch-failed`, `watch-dropped`, and a new `board-note`. `fill` stays single-pass.

## Invariants carried over

- The first mate is found by its stored id, never by metadata or title.
- Sends never interrupt: `auto`/`steer` for the captain's words, `queue-if-active` for watch output.
- Restart is refused mid-turn and cannot produce two first mates.
- Templates are data; the charter follows the plugin until edited, detected by fingerprint.
- File access is confined to the home, including through symlinks.
- Writes are an atomic rename plus a content or mtime check.
- Suggestions are removed by label and prompt, not position.
- Watch output reaches the first mate only between turns, capped at 32k characters, tag-like `<`
  escaped.

Dropped as moot: finding crew by label, the steer-relay timing rules,
crew-seen, clearing attention by raw frame, `activeTurnBehavior`, uploads, draft persistence on
`globalThis`, home and project renaming via CLI.

## Error handling

- Handlers fail fast with a sentence the panel shows as-is, naming what to do next.
- Nothing throws into the server's event loop: services catch and log per tick; every service,
  listener, timer and child process is released in `bb.onDispose`.
- A stored first-mate id that no longer resolves shows as "first mate gone" with Launch/Adopt; there is
  no fallback lookup.
- A failed launch after the project exists leaves no stored id and says which step failed.

## Testing

- vitest, `"test": "vitest run"`; `npx tsc --noEmit`.
- Ported tests for every carried module, including `templates` (folder ↔ list parity; `package.json`
  ships the folder) and `pr-watch` against a stand-in `gh`.
- New tests with `createFakePluginHost()`: fleet columns over fake threads and metadata; `mate` launch
  lock, idle-only restart, stored-id-only lookup; `crew spawn` caller check, defaults and metadata;
  watch delivery (idle → one `queue` send; busy → hold; cap and drop marker).
- Manual, against the running bb: `bb plugin install path:… --plugin firstmate` → `running`; launch a
  first mate; register a scratch `local-only` repo; ask for a one-line change; watch a card go
  Queued → Working → Idle with `done: ready in branch fm/…`; look at the tab wide and narrow, light and
  dark.

## Open items

Resolved while planning:

- Templates: generated module (see *Charter and templates*).
- The first mate's workspace: `environment: { type: "host", workspace: { type: "unmanaged", path: home } }`,
  so the home need not be a git repository.
- The CLI handler gets the calling thread from `PluginCliContext.threadId`.
- Status lines: `thread.idle` carries `lastAssistantText`; `threads.output` covers a cold start.

Checked first in the plan (2026-09-29, bb 0.44.0, SDK 0.5.29):

1. **A captain-started turn on a child does notify its parent: yes.** Experiment: a hidden parent thread
   and a child spawned with `--parent-thread`; a tell to the child with no thread origin (the child's
   turn request recorded `initiator: "user"`, `senderThreadId: null`) made the parent receive a new turn
   `[bb system]\n\n@thread:<child> completed:\n\n<child's last text>` (turn request
   `systemMessageKind: "child-completed"`, `initiator: "system"`). It fires after every child turn,
   whoever started it, so the Paseo steer relay is not ported: Task 8 skips `CaptainSteers`, `relayText`
   and the `steer-relay*.md` templates.
2. **A composer slash command for `/fm`: no.** `app.composer.customize` takes only `actions`, `banners`,
   `plusMenu` (rows in the composer's `+` menu) and `richText` (read-only paint and draft observation);
   there is no command or slash registration, and the slash typeahead is host-owned (skills only). Task 12
   does not register `/fm`; the CLI and `app.commands.register` (bb's plugin command palette) cover it.

## Done when

The issue's checklist: `firstmate/` as `@gpambrozio/bb-plugin-firstmate` from `bb plugin new` with the
example removed; tests and typecheck pass; `bb plugin build` succeeds and the install runs; UI checked
wide/narrow and light/dark; `.bb/plugins.json` entry and README status; `firstmate/AGENTS.md`,
`README.md`, `CHANGELOG.md`, `PLUGIN_OVERVIEW.md`; root `AGENTS.md` corrected where the port proves it
wrong; the issue updated with the scope above.
