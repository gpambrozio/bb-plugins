# Learning Exercises: Orient, with a native walkthrough — design

Status: approved in conversation on 2026-11-07, awaiting review of this written spec.
Plugin: `learning-exercises` (0.2.0 → 0.3.0). Upstream: Learning Opportunities commit `3862d2e`,
`orient/skills/orient/SKILL.md` (Dr. Michael Mullarkey, CC BY 4.0) and the "Orientation mode" section of
`learning-opportunities/skills/learning-opportunities/SKILL.md` (Dr. Cat Hicks, CC BY 4.0). Format
reference: [showboat](https://github.com/simonw/showboat) (Simon Willison, Apache-2.0), commit `d531261`.

## 1. Intent

Bring upstream's Orient into the plugin: an agent explores a repository and writes an orientation (one-line
purpose, languages, pipeline stages, key files, core concepts, common gotchas, exactly two read-then-explain
exercises, sources), and an **orientation session** runs those two exercises through the plugin's cards and
closes with "what surprised you?".

Upstream's optional `showboat` path builds a long, linear walkthrough with numbered code listings by
shelling out to `uvx showboat`. **The plugin does not require showboat, uv or any install.** It provides
the same thing natively: a walkthrough document the plugin stores and shows, built block by block through
plugin tools, whose code listings the plugin captures from the real files (never typed by the agent) and
re-checks on demand (showboat's `verify`).

What the user decided:

| Question | Decision |
| --- | --- |
| Where it lives | Plugin storage per project, shown in the plugin's UI; **Export** writes Markdown to the repo |
| Shape | One document, two depths: the summary always, the walkthrough when asked for |
| Blocks besides prose | **File listings only.** The plugin never executes anything |
| Who builds it | A **hidden helper thread** |
| How it starts | **By hand only**, from the Learning tab. No offers |
| Where the session runs | A **new visible thread** (a new session mode) |
| Viewer | The Learning tab's Orientation section; the walkthrough opens as a **panel tab** |
| Approach | Structured blocks in SQLite + `orient_*` tools (approach A) |

Out of scope: running commands or recording their output (showboat `exec`), images (`image`), `extract`,
remote streaming (blocks appear live through the plugin's own invalidation instead), orientation offers,
spaced retrieval and the journal.

## 2. Invariants this keeps, and the two it widens

- **Zero context upfront (invariant 1), widened.** No skill, no `contributeInstructions`. `configure`
  returns tools only to (a) a session thread the store has as open in mode `fork` **or `spawn`**, bound to
  that thread (the existing rule, with `spawn` added; a spawn session also while it is still `starting` and
  unbound), and (b) a thread the store has as the builder of a live orientation (`starting` or `building`),
  bound to it, or the orientation still `starting` and unbound (the builder can resolve its tools before
  `spawn` answers). Every other thread gets `{ tools: [], skills: [] }`.
- **Offers are deterministic (2).** Unchanged: orientation is never offered.
- **Offers only in human threads (3), clarified.** Builder threads are hidden, so `isHumanThread` already
  refuses them. As shipped (R11), `thread.active`, `idle` and `failed` also keep from the offer engine every
  thread bound as a builder and every hidden thread of this plugin, bound or not, so a builder's first turn
  (which bb can report before `spawn` answers) never opens an overlap window that hides commit offers. The
  builder's plugin metadata key is `orientation`; the offer engine does not read it. Orientation session
  threads are this plugin's session threads, already excluded.
- **Who may call what (8).** Every new mutation RPC (start, cancel, rebuild, verify, export, delete) refuses
  another plugin through `experimental_caller`, like the existing ones; reads stay open. The `bb learning
  orient …` commands act only for the builder of a live orientation named by the caller's `BB_THREAD_ID`,
  which scopes cooperatively, as the existing commands do.
- **Nothing executes.** The plugin reads files through `bb.sdk.files.read`; it never runs a command.

## 3. User flow

1. **Start.** The Learning tab gets an **Orientation** section for the thread's project. With no
   orientation: **Orient me to this project**, an **Include a walkthrough** checkbox, and one line saying a
   background agent will read the repo for a few minutes in this checkout, with bb's read-and-edit permission
   (bb's least privileged mode; the builder is told not to edit files).
2. **Build.** A hidden builder thread runs in the source thread's environment with its provider. The section
   shows `Building · N blocks · M min` and **Cancel**. One build per project at a time.
3. **Ready.** The section shows the summary (purpose, languages, stages, key files as file links, concepts,
   gotchas) and **Start orientation session**, **Read walkthrough** (when built), **Verify**,
   **Export to repo…**, **Rebuild**, **Delete**. A rebuild keeps the previous orientation until the new
   one is ready. A failed or cancelled build shows its reason and **Rebuild**: the `orientation` read
   answers it as `last` (R10), the newest failed or cancelled build, only while nothing is live and when it
   started after the ready one was ready.
4. **Walkthrough.** **Read walkthrough** opens the `orientation` panel tab: title, table of contents,
   chapters in reading order; prose links listings ("Listing 3"), and each listing shows its caption, a
   file link at its range, the code, and a state badge: *current*, *moved to 52–84*, *changed since
   `abc1234`* (the captured text stays shown), or *missing*.
5. **Session.** **Start orientation session** spawns a visible top-level thread "Orientation: <project>".
   It asks the two exercises in order through the normal cards (forms, confidence, feedback, drafts all
   unchanged), then the closing question, and suggests a follow-up file or exercise in its finish summary.
   It is listed in the project's session history like any other.
6. **Export.** Asks for a workspace path (default `ORIENTATION.md`), confirms before replacing an existing
   file, and writes Markdown (§8).

## 4. Data model (`server/store.ts`, appended migrations)

New migrations only; `migration.test.ts` pins their SHA-256 like the others. Besides the two tables and
their indexes, 0.3.0 rebuilds `sessions` (R8/R9): SQLite cannot loosen its `mode` CHECK in place to admit
`spawn`, so the statements copy `sessions` and `exercises` aside, delete `exercises`, drop and recreate
`sessions` with the same columns and indexes, and put both back, independent of `foreign_keys`. Then
0.3.0 adds `orientations.verified_at` (§6.3), and last `orientation_putaways` (`thread_id` primary key,
`orientation_id`, `failed_at`): builder threads whose put-away bb has not confirmed (§7), with no foreign
key, so deleting, purging or replacing their orientation does not lose them.

`orientations`

| Column | Notes |
| --- | --- |
| `id` | Random id, also the builder's plugin metadata under the key `orientation` |
| `project_key` | `policy.ts` `projectKey` (the same key the caps and history use) |
| `status` | `starting` → `building` → `ready`, or `failed` / `cancelled` |
| `depth` | `summary` or `walkthrough` |
| `source_thread_id`, `environment_id`, `host_id`, `workspace_path` | Where it was built; listings and verify read here |
| `provider_id` | The builder's provider |
| `builder_thread_id` | Null until bound |
| `head_sha` | HEAD when the build started (Git plugin; null if unknown) |
| `title` | "Repo Orientation: <project name>" |
| `summary` | JSON (§5), null until set |
| `reminded` | 0/1: the one idle reminder was sent |
| `error` | Why it failed or was cancelled |
| `created_at`, `updated_at`, `ready_at` | Epoch ms |
| `verified_at` | Epoch ms of the last verify that reached a checkout, whatever each file's read did; null until one (§6.3) |

A partial unique index allows one row with status `starting` or `building` per `project_key`. When a row
becomes `ready`, older `ready` rows for the project are deleted with their blocks in the same transaction.
The project's orientation is its newest `ready` row.

`orientation_blocks`

| Column | Notes |
| --- | --- |
| `orientation_id`, `ordinal` | Primary key; ordinals rise and are never reused |
| `kind` | `chapter`, `note` or `listing` |
| `text` | Chapter title or note Markdown; null for a listing |
| `listing_no` | 1, 2, … in order of creation; a popped number is not reused |
| `caption`, `path`, `start_line`, `end_line` | Listing only; `path` workspace-relative and normalized (`workspacePath`) |
| `captured`, `captured_sha256`, `captured_ref` | The exact lines read, their hash, HEAD at capture |
| `check_state`, `check_start`, `check_end`, `checked_at` | Last verify: `current`, `moved` (with the new range), `changed`, `missing` |

## 5. The summary (`shared/orientation.ts`)

A zod schema, shared by the tool, the CLI, the RPC reads and the app (the module imports zod only, never the
SDK root, per the root `AGENTS.md`):

- `purpose`: one sentence, ≤ 300 chars.
- `languages`: 1–6 strings, dominant first.
- `stages`: 1–10 one-line strings (or main modules and their relationships when there is no pipeline).
- `keyFiles`: **6–10** `{ path, does, why }`.
- `concepts`: **3–5** `{ name, definition, where }`.
- `gotchas`: **2–3** strings.
- `exercises`: **exactly 2** `{ file, read, question }` — the file to open, what to read in it, and the
  synthesis question to answer afterwards.
- `sources`: 1–40 paths actually read.

Every string is **one line** (no CR, LF, U+2028 or U+2029) and capped: 300 for `purpose`, 500
(`ORIENT_LIMITS.summaryText`) for the other prose (stages, `does`, `why`, definitions, gotchas, `read`,
`question`), 200 (`summaryName`) for names and paths (languages, key file paths, concept names and `where`,
exercise files, sources). The export puts each field on a line of its own or after a list marker, so a line
break would let a field start a line, where showboat reads three backticks as a code block that
`showboat verify` runs; the renderer also escapes a leading backtick or `!` of `purpose`, the one field that
starts a line. A stored summary that fails the schema reads as none. Every text is Markdown rendered through `FileMarkdown`; paths are links. Limits are in one `ORIENT_LIMITS`
object; the schema is flat (no `$ref`), as the answer form's is.

## 6. Building: tools, CLI, verify

### 6.1 Tools (`server/orientation-tools.ts`)

Registered with `bb.agents.registerTool` beside `learning_*`, granted per §2.

| Tool | Input | Behaviour |
| --- | --- | --- |
| `orient_chapter` | `title` | Appends a chapter; the table of contents is the chapters |
| `orient_note` | `markdown` (≤ 8,000) | Appends prose. Refused if it contains a fenced code block (code belongs in listings) or a line that starts with an image, as showboat reads one (R4) |
| `orient_listing` | `path`, `lines` (`"40-72"` or `"40"`), `caption` (≤ 200) | Server reads the file in the orientation's environment, slices the lines, stores text, hash and HEAD, and **returns the captured text** with its number. Refused, with the reason, for: a path outside the workspace, a missing or unreadable or binary file, a file over 1 MiB, a range past the end, more than 200 lines, more than 60 listings |
| `orient_pop` | — | Undoes the last block added (a note, listing or chapter); returns what was removed. A popped listing's number is not reused, so the brief says to use the number each `orient_listing` call returns |
| `orient_summary` | the §5 object | Sets or replaces the summary; refused with zod's reasons |
| `orient_finish` | — | Requires a summary; for `walkthrough`, at least one chapter, every listing referenced as `Listing N` in some note, and no note naming a listing that does not exist. Runs verify and marks `ready`. It does **not** stop the builder (R5): it runs inside the builder's own tool call, so the builder is put away on its next idle (§7). Refused with reasons otherwise |

Each call checks the caller's thread is the bound builder of a `building` orientation (binding from
`starting` on the first call, as sessions do), runs under the orientation's lock, and calls `changed()`
so open views refetch. A summary-depth build refuses `orient_chapter`, `orient_note` and `orient_listing`.

### 6.2 CLI fallback (`server/cli.ts`)

`bb learning orient chapter|note|listing|pop|summary|finish`, same rules. Text arguments go through
`--…-base64-stdin` (one line, ≤ 16 KiB, as `ask` does); the summary through `--summary-base64`. The builder
brief names the tools first and the commands as the fallback for providers whose threads get no tools.

### 6.3 Verify (`server/orientation-verify.ts`)

Pure over a `readFile(path) → string | null` function:

1. Read the file. Gone or unreadable → `missing`.
2. Lines `start..end` hash to `captured_sha256` → `current`.
3. Else search the file for the captured text as a whole-line block; found once → `moved` with its range;
   found several times → the nearest to the old start.
4. Else → `changed`.

It runs at `orient_finish`, when the walkthrough tab opens (at most once per 5 minutes per orientation),
on **Verify**, and before an orientation session starts. The 5-minute window is the orientation's own
`verified_at`, set at the end of every verify that reached a checkout, not each listing's `checked_at`: a
read that fails leaves its listing's state and time as they were, and a window kept per listing would let
one unreadable file make every opening verify again. A verify asks open views to refetch only when a
listing's state or range changed (a refetch of the walkthrough is what verifies on opening), and the tab
reads the walkthrough only while it is visible. It writes `check_*` and `checked_at` and never
changes `captured*`. With the environment gone (an archived source thread's destroyed environment), it
reads the project's checkout on the orientation's host instead; with neither, it leaves the states as they
were and says so.

## 7. The hidden builder's lifecycle (`server/orientation.ts`, `OrientationService`)

The guarantees from issue #11, simpler here because builds are started by hand and one per project:

- **Reserve, then spawn.** Under the project's lock: refuse if a live row exists or the plugin has not
  confirmed it is clean (below); insert `starting`; then `threads.spawn({ projectId, title, visibility:
  "hidden", environment: { type: "reuse", environmentId }, providerId, input: [visible line, builder brief
  as an `agent-only` part], pluginMetadata: { orientation: <id> } })` with no `parentThreadId` (a visible line
  with every agent-only part, invariant 6). On success bind the thread and move to
  `building` (unless already bound by its first tool call, idle or failed turn, which can come first; an
  early idle or failure is then handled as any builder's). On failure → `failed` with the error.
- **Finish and Cancel.** **Cancel** moves the row, then stops the builder and archives it. `orient_finish`
  moves the row and leaves the builder running (R5): it runs inside the builder's own tool call, where a
  stop that waits for the turn would wait for its own answer, so the builder's next `thread.idle` puts it
  away (a reconcile is the fallback). Errors from stop or archive are logged, never thrown into the user's
  action. A put-away bb does not confirm (the thread archived, or gone) is recorded in the store; while any
  is, starts are refused with "Cleaning up an earlier build; try again shortly", and each sweep tries it
  again until it is confirmed.
- **A builder that stops early.** On `thread.idle` of a `building` builder: the first time, send one
  visible line plus an agent-only reminder ("call `orient_finish`, or fix what it refused"); the second time,
  `failed` ("The builder stopped before finishing"), keep its blocks for the message, stop and archive.
  `thread.failed` fails it at once.
- **A cap.** The sweep, every 5 minutes (`*/5 * * * *`), cancels builds older than 30 minutes and deletes `failed` and `cancelled`
  rows older than 7 days.
- **Reload safety, failing closed.** On load, before any start is allowed: each `starting` / `building`
  row is checked against bb — its thread running → kept and bound; otherwise → `failed` ("Interrupted by a
  reload") and its thread put away; a `starting` row with no thread yet is found by its plugin metadata
  (key `orientation`) among this plugin's threads, as `ports.forkOf` does for forks. Threads this plugin
  started (checked by `originPluginId` on every listed row) whose orientation id the store does not have as
  live are archived. If any step cannot complete
  (the thread list unreadable, an archive failing), starts stay refused, the tab says "Cleaning up an
  earlier build; try again shortly", and the sweep retries every 5 minutes. After `dispose()` no
  continuation writes (`alive()`), and every promise the service creates is observed.
- **Delete** removes a `ready`, `failed` or `cancelled` orientation and its blocks; it refuses a live one
  (Cancel first).

### The builder brief (`content/orient-builder.md`, generated into `content.generated.ts`)

Adapted from upstream Orient Steps 2–4 and its showboat path: the language signal table; the exploration
order (README and docs, the directory tree, entry points per language, two or three tests preferring
integration tests, five to eight core modules, `git log --oneline -20` and the most-changed files), each
with its source as in upstream; the summary's rules; and for a walkthrough, plan the chapters and listings
first, then build in reading order, explain *why* not just *what*, reference listings as `Listing N`,
no fenced code in notes. Plus: do not edit or create files, do not commit, use only `orient_*` for output,
call `orient_finish` last. The exercise criteria are upstream's verbatim in substance: read one specific,
short artifact first, then synthesize; never predict without having read; no implementation tracing or
debugging. The orient bibliography moves into `NOTICE.md`'s references, not the brief.

## 8. Export (`shared/orientation-markdown.ts`, `exportOrientation` RPC)

One pure renderer produces:

```markdown
# Repo Orientation: <project>

*<ready_at ISO>* · built at `<head_sha short>`

> Generated by the Learning Exercises plugin. Rebuild it there to update.

## One-line purpose … ## Primary language(s) … ## Pipeline / workflow stages … ## Key files …
## Core concepts … ## Common gotchas … ## Suggested exercise sequence … ## Sources consulted …
```

followed, for a walkthrough, by `## Contents` and each chapter (`## <title>`, its notes), then
`## Code Listings` with, per listing, `### Listing N: <caption>`, an `<a id="listing-N"></a>` anchor, and
showboat's block pair:

````markdown
```bash
sed -n '40,72p' src/retry.ts
```

```output
<captured text>
```
````

That pair is showboat's own `exec` format, so `showboat verify ORIENTATION.md` run from the repo root
re-checks the listings for anyone who has it; the plugin does not need it. Fences are lengthened when the
captured text contains backticks.

The RPC takes `{ orientationId, path, replace, expectedSha256? }`: it normalizes `path` inside the
workspace and reads the current file; if one exists and `replace` is false it answers
`{ exists: true, sha256 }` and the app asks. The replace call sends that hash back as `expectedSha256` (R6),
and the write is `files.write({ content, expectedSha256 })` with the caller's hash (null or absent: the file
must not exist), so a file changed while the user decided is not overwritten. Writing does not commit.

## 9. The orientation session

- `SessionModeSchema` gains `"spawn"`; `TRIGGER_KINDS` gains `"orientation"` (label "an orientation").
- Start (`startOrientationSession`, from the tab): runs verify, then reserves a session under the source
  thread's lock exactly as Start does today (one open session per source thread), and spawns a visible
  top-level thread in the source thread's environment with its provider, title "Orientation: <project>",
  `pluginMetadata: { sessionId }`, and `input: [the visible start line, the brief as an `agent-only`
  part]`.
- The brief: `brief.md` + a new `content/orientation-session.md` (upstream's "Orientation mode"; its
  "summarize and ask whether to proceed" step is the Start button the user already pressed, so the agent
  opens with a one-sentence summary inside the first question; run the two
  exercises in order with all standard techniques; then ask "What's one thing about this codebase that
  surprised you or that you want to dig into further?" and use the answer in the finish summary to suggest a
  follow-up file or exercise) + the summary rendered by §8 as quoted data + verify's drift lines ("Listing 3
  … changed since abc1234") + the existing "How to ask" in fork form. `maxQuestions` = 3 for this session.
- `configure` grants session tools to it as for `fork` (§2). Pause, Resume, Finish, drafts, feedback cards
  and history work unchanged. It never counts toward the source thread's sessions-per-thread cap:
  `store.finishedSessionsFrom` today counts every finished session whose `source_thread_id` is the thread,
  so it gains `AND trigger <> 'orientation'` (a test pins that an orientation session leaves the cap alone).

## 10. The app

- `app/orientation-section.tsx` in the Learning tab: the states of §3; Start with the walkthrough
  checkbox; progress; buttons; the summary through `FileMarkdown`.
- `app/orientation-tab.tsx`: a new `experimental_tab` (`orientation`, thread context, `availability:
  "action"`, a bb icon name checked against `bb-icon-names.ts`), opened through the panel controller with
  `params: { orientationId }`; contents, chapters, listings with `experimental_FileLink` at their range,
  state badges in semantic colours, a **Verify** button, its own scroll container (no `scrollIntoView`).
  Refetches on `LEARNING_TAG`.
- RPCs in `shared/contract.ts`: `orientation` (read: the project's current and live orientation for a
  thread), `orientationDocument` (read: blocks), `startOrientation`, `cancelOrientation`,
  `verifyOrientation`, `exportOrientation`, `deleteOrientation`, `startOrientationSession`.

## 11. Testing

- **Pure:** verify (current, moved once and many times, changed, missing, file grew or shrank, CRLF);
  the Markdown renderer (golden file, backtick-bearing listings, an export parsed back with a small port of
  showboat's block grammar in the test to prove the pairs are well formed); the summary schema's limits.
- **Service over `FakePorts`:** reserve and spawn failure; bind before and after spawn answers; finish
  verifies and archives; reminder then failure; `thread.failed`; cancel; the 30-minute cap; a reload with a
  spawn in flight (the old instance's spawn answering after the new one swept); a sweep that cannot read the
  thread list keeps starts refused; dispose during each await leaves nothing written and no unhandled
  rejection; delete refuses a live build.
- **Server wiring on the fake host:** `configure` is empty for unrelated threads, grants `orient_*` only to
  the bound builder and session tools to a `spawn` session; a build → listing → finish → ready → session
  round trip; listing refusals; the CLI path; offers ignore builder threads; migration hashes pinned.
- **App (jsdom):** the section's states and buttons by accessible name; the tab renders listings and badges;
  export asks before replacing.
- **Live:** a dev bb (root `AGENTS.md`), never the user's: build both depths on this repository, open the
  walkthrough, edit a listed file and verify, run a session, export and run `showboat verify` on the
  export where available.

## 12. Docs and release

- `README.md`, `PLUGIN_OVERVIEW.md` (≤ 4,000 chars), `CHANGELOG.md` `## 0.3.0` for non-technical readers,
  version 0.3.0 (`npm version minor --no-git-tag-version`).
- `AGENTS.md`: invariants 1 and 3 as in §2; a new "Orientation" section (builder lifecycle, verify, export);
  the file table; drop "Orientation" and "Showboat" from the later-phases list.
- `NOTICE.md`: orient (Dr. Michael Mullarkey, CC BY 4.0, commit `3862d2e`) — what was adapted into
  `content/orient-builder.md` and `content/orientation-session.md` and how; its bibliography; showboat
  (Simon Willison, Apache-2.0, commit `d531261`) — its document format and verify behaviour are followed,
  no code is copied.
- `engines` stay at bb 0.48.1 unless the plan finds an API that needs more (hidden `spawn` with
  `reuse` and `files.read`/`write` with `expectedSha256` are in SDK 0.6.104).

## 13. Risks recorded

- **The builder has read-and-edit permission** in the user's checkout (bb has no tool-free thread). It is
  told not to edit, reads only the user's own repository, and the Start line says so. Recorded as a
  decision, per the root `AGENTS.md`.
- **Hidden-thread cost is invisible.** The progress line and the 30-minute cap bound it; the provider is
  the source thread's, so cost follows the user's own choice.
- **Codex forks lack plugin tools**; the builder and the session are *spawned*, which get them, and the CLI
  remains as a fallback.
