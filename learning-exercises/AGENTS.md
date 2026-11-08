# learning-exercises — notes for agents

An event-driven take on Dr. Cat Hicks's
[Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities) (CC BY 4.0; see
`NOTICE.md`). The design is the first mate's scout report v2 (`report-v2.md`, decisions D1–D16) with one
change: sessions are placed by provider capability, not by provider id. The phase 0 spike that shaped
it ran in an isolated dev bb (`spike.md` beside the report). This is phase 1: features #1–#10 of the
report's §6.1, plus Orient (0.3.0, below). Resume in a new thread, the sidebar journal, "Quiz me on
this" and spaced retrieval are later phases.

## The invariants

1. **Zero context upfront.** No `skills/` folder (`server.test.ts` checks), no `contributeInstructions`,
   and `configure` returns `{ tools: [], skills: [] }` unless the thread is (a) a session thread the
   store has as open, in mode `fork` **or `spawn`**, bound to that thread (or not bound yet: in fork mode,
   forked from the session's source thread; in spawn mode, while the session is still `starting`), or (b)
   the builder of a live orientation (`starting` or `building`), bound to that thread, or still `starting`
   and not yet bound (a thread can resolve its tools before `spawn` answers). A builder gets the
   orientation tools, a spawn session the session tools; a failed, cancelled or finished builder gets
   nothing. The CLI shows up only in bb's generic `plugin-commands` skill body. Do not add a skill, an
   instruction or a tool that reaches threads with no session or builder.
2. **Offers are deterministic.** No model decides an offer or writes a topic. Topics are commit
   subjects, paths and pull request titles, quoted. The exercise type is the agent's choice inside an
   accepted session.
3. **Offers only in human threads** (`policy.ts` `isHumanThread`): top level, no lifecycle owner,
   visible, not archived, and not started by a plugin on the never-offer list.
   - **Builders.** Builder threads are hidden, so this refuses them already. The event wiring
     (`server.ts`) also keeps from the offer engine every thread bound as a builder (`isBuilderThread`)
     and, since the pre-bind window (R11), any hidden thread of this plugin (`originPluginId` is this
     plugin and `visibility` is hidden), so a builder never opens an overlap that suppresses commit
     offers. Neither check reads the builder's metadata (key `orientation`).
   - **Plugin-started threads.** One is kept out only when it is a child (as every child is) or its
     plugin is listed: the `noOfferPlugins` setting (default `automations`, one id per line) plus this
     plugin, whose session threads never get offers whatever the setting says. A top-level thread another
     plugin started is the user's work: a GitHub board card's thread (thr_58q9ui4bvc got no offer for its
     first-turn commit under the old "no `originPluginId`" rule), a diff-review run, a Reclaim clean-up, a
     voice thread. bb marks nothing else on a background thread (every spawn's `initiator` is `"user"`),
     so a plugin that starts top-level background work belongs on that list.
   - **Changing the list.** Adding a plugin there expires the live offers in its threads
     (`dropIneligible`, on the settings change), and `offerSeen` and `answerOffer` re-check the thread
     first, so a client holding the offer from before cannot show or answer it; a manual start from the
     Learning tab still runs (it drops the offer).
   - **Other background threads.** Side chats and code-review workers are hidden and owned, crews are
     children, and workflows set a lifecycle owner, so the other checks keep them out.
   - **Manual starts are wider** (`canStartByHand`): any visible, unarchived thread except this plugin's
     own session threads, so a sub-agent thread can be a session's source.
   - **The Learning tab.** The fixed "Learning" tab is on the tab bar of every thread the sidebar lists
     (hidden threads are not listed), session threads included, where it shows the session with Pause and
     Finish but no Start. Earlier builds offered it in sub-agent threads only as the action tab
     `learning-on-demand`, from the side panel's launcher; bb keeps an action tab's open instances with the
     thread, so that tab stays registered, never offered, and `useOneLearningTab` (run by the
     always-mounted composer banner and by that tab) closes every instance, selecting the fixed tab first
     when one was selected: never two Learning tabs.
   - `ThreadView.eligible` says offers are made there, `canStart` that Start is shown. Never let offers,
     the banner or the thread menu's offer choice follow `canStart`.
4. **The caps live in the server** (`policy.ts`), and count *answered* offers only. An offer nobody
   answers, shown or not, counts toward nothing: not the daily limit or the gap (`answeredAt`, stored
   under its own key so the `seenAt` of earlier builds counts for nothing), not the snooze or the
   back-off (set by Later), not sessions per thread (finished sessions), and not the streak, whose count
   restarts on an answer, not when an offer is made. So several offers in quiet threads can show at once
   until one is answered. The caps are applied three times: when an offer is made, when it is about to
   show, and when it is answered, seen or not (`answer` checks them synchronously before recording, so two
   offers on screen cannot both be answered past a one-a-day cap). An answer that fills the cap, starts the
   gap or begins a back-off expires every other live offer the caps now hold back, seen or not
   (`expireCapped`), and a late answer on one fails as "no longer open". The last migration seeds
   `answeredAt` once from 0.1.0's answered offers (`answered_at`), so an upgrade keeps today's cap. Views read the offer through `OfferEngine.visibleOffer` (an unseen offer shows only while the
   caps would let it), and the banner or the tab claims it with `offerSeen` → `claim`, which re-checks the
   gate and the caps synchronously and marks it seen, charging nothing. The app draws an unseen offer only
   after that claim answers `visible: true`, so an offer the caps now hold back is never drawn from a
   stale read; one already seen keeps showing. A session starting, running or waiting for an answer
   elsewhere in the project hides every offer in it, seen or not, without ending it (`suppressed`). Every read, claim and answer also re-checks what can end an offer at any time
   (`offerStanding`: offers off, Never for the project, the thread opted out, a session open, a day old).
   An offer nobody answered expires at the next turn or after 24 h and never counted. The banner's Start
   and the tab's Start both answer through `OfferEngine.answer`, and a tab Start with no offer still
   resets the run of Laters (`accepted`).
5. **Session state moves only from the state a step expects.** Start, Ask and Resume run under a per-key
   lock (`SessionService.exclusive`) and reserve their state before any await; later steps use
   `store.transition(id, from, to)`, so a pause, an early tool call from a fork, or another copy of the
   plugin is never overwritten. A partial unique index (migration 9) allows one open session per source
   thread. Stores from before it (e54db75) may hold duplicates, so `reconcileOpenSessions` runs before
   `bb.storage.migrate` and keeps the most progressed one, marking the rest abandoned with their answers.
   `migration.test.ts` pins the migrations bb has already recorded by their SHA-256 (bb's statement hash):
   never edit or reorder them. After
   `dispose()`, no continuation of that copy writes anything (`alive()`); a fork whose id never reached
   the store is found again on Resume (`ports.forkOf`). A card that fails to open, or whose caller went,
   pauses the session so Resume can show the question again.
6. **Every send has a visible line.** A `threads.send` with only an agent-only part shows the reply with
   no user message above it (spike S5). `ports.send` always takes both.
7. **The brief is agent-only and is the only instruction text.** It reaches the fork as
   `agentContextSeed`, or the work thread as the agent-only part of one send. The standing
   `SESSION_INVARIANT` from `configure` survives a compaction in forks.

8. **Who may call what.** The app's RPC mutations refuse another plugin (`experimental_caller` is
   verified by bb); reads stay open. The `bb learning` commands act on the open session in the thread
   the caller's `BB_THREAD_ID` names, and bb's CLI context carries no verified identity, so this scopes
   cooperatively and does not authenticate: a process that names another session thread can act there.
   That is within bb's model (agents and plugins on the machine are trusted); do not describe it as more.

## How it fits together

| File | Role |
| --- | --- |
| `server/offers.ts` | `thread.active` notes HEAD and expires the thread's unanswered offer; `thread.idle` gathers the turn's facts and asks `policy.ts`; the hourly sweep expires offers, abandons month-old pauses and reads pull requests |
| `server/signals.ts` | Triggers T1–T5 from facts; `relativize` and gitignore-style `PathRules` |
| `server/policy.ts` | The gate, the caps, the snooze, the back-off, `projectKey` |
| `server/sessions.ts` | Start (fork or here), the card (tool or CLI), verdicts, pause / resume / finish, reload safety |
| `server/tools.ts`, `server/cli.ts` | `learning_ask` / `learning_feedback` / `learning_finish`, and `bb learning ask|feedback|finish|principles` |
| `server/bb-ports.ts` | Everything from bb behind `Ports` (`server/ports.ts`); tests use `server/testing/fake-ports.ts` |
| `server/store.ts` | SQLite: offers, sessions, exercises, per-thread state, global values. Migrations are append-only |
| `server/content.ts` | The brief from `content/` through `server/content.generated.ts` (`npm run gen:content`; a test fails when they differ) |
| `app/banner.tsx`, `app/offer-card.tsx` | The composer banner (thread scope; only while idle) |
| `app/card.tsx`, `app/settled-row.tsx` | The `exercise` pending interaction and its timeline row |
| `app/feedback.tsx` | The agent's feedback as a card above the last message of the turn that recorded it (below) |
| `app/draft.ts` | The card's unsent answer: restored on mount, saved as the learner types (below) |
| `app/tab.tsx` | The "Learning" tab, on the tab bar of every listed thread; the retired on-demand tab's clean-up |
| `app/file-refs.tsx` | File references as links that open the file in bb, at a line or range (below) |
| `server/question.ts` | What the server checks of a question before showing it: its length and that its code blocks close |
| `shared/answer-form.ts`, `app/answer-form.tsx` | Answer forms: the schema, its checks and limits, reading and summarising an answer; the controls in the card and the read-only view (below) |
| `app/thread-action.ts`, `app/settings-section.tsx` | "Learning offers" in the thread menu; the never-list under settings |
| `shared/orientation.ts`, `shared/workspace-path.ts` | The orientation summary schema and its limits; the workspace-path rules shared by server and app (no SDK root import) |
| `server/orientation.ts`, `server/orientation-store.ts` | `OrientationService` (start, cancel, rebuild, verify, export, reconcile, builder events) and its SQLite access |
| `server/orientation-tools.ts`, `server/orientation-verify.ts`, `server/orientation-markdown.ts`, `server/orientation-api.ts` | The builder's tools (`orient_*`) and `bb learning orient …`; verify; the showboat-format export; the orientation RPCs |
| `app/orientation-section.tsx`, `app/orientation-tab.tsx`, `app/export-dialog.tsx` | The Learning tab's Orientation section; the walkthrough tab; the export dialog |
| `app/scroll-within.ts`, `app/orientation-ids.ts` | Scrolling inside the walkthrough's own container; the tab id |
| `content/orient-builder.md`, `content/orientation-session.md` | The builder's brief and the orientation session's instructions (generated into `server/content.generated.ts`) |

## Orientation

Orient (0.3.0) builds a repository guide with a hidden builder thread; spec:
`docs/superpowers/specs/2026-11-07-learning-exercises-orient-design.md`. Decisions not to break (R = rulings
made while implementing):

- **Reserve, then spawn; one live build per project.** `start` reserves the row (`starting`) under the
  project's lock before the spawn, so two starts cannot both spawn. A builder is told apart by the
  orientation row, the plugin metadata on its thread (key `orientation`) and `originPluginId`. It is bound
  when the spawn answers, on its first tool call or its first idle or failed turn (when one comes first),
  or by a reconcile (a `starting` row and the thread bb made for it, found by that metadata). An early idle
  or failure binds under the orientation's lock as a first tool call does (same metadata and
  `originPluginId` checks, only a live row with no builder) and is then handled as any builder's (PR #104
  review, finding 3; it used to be lost until the 30-minute cap): a failure fails the build and puts the
  thread away at once, and an idle counts only once a turn is known to have run. A late (stray) thread,
  one this plugin started for a row that is not live (spawn answered after the row ended), is put away by
  its first tool call, idle or failed turn.
- **An idle spends the one reminder only after a turn** (PR #104 review pass 2, finding 7). bb can report a
  builder idle before its first turn starts, with the brief still queued; `onIdle` reads `currentTurn`
  first and does nothing (no reminder, no failure) when it is null. The first idle with a turn known sends
  the reminder, the next fails the build. `currentTurn` also answers null when the read fails, so a builder
  whose turns can never be read is never reminded or failed by its idles: the 30-minute cap is the
  backstop there. A failed turn still fails at once.
- **`clean` starts false** and only a fully successful `reconcile()` sets it. Until then `start` is refused
  (R1), so a sweep can never fail this instance's own in-flight spawn. Reconcile runs **only at load and
  from the 5-minute sweep (`*/5 * * * *`, not hourly as spec §7 first said)**, and the sweep reconciles
  only when not clean. Reconcile keeps a builder that is active, pending or starting, or idle with a
  current turn; any other leftover is archived. Put-away of a gone or archived builder must not make
  reconcile unclean (R7).
- **A put-away that bb does not confirm keeps starts refused** (PR #104 review, finding 1). Every put-away
  (Cancel, a failed build, the cap, the idle after a finish, a stray, a reconcile) stops, then archives,
  and is done only when both worked or bb confirms the thread archived, or gone (no thread by its id and
  none of this plugin's unarchived threads lists it). A stop that failed before an archive that answered is
  done only once a read shows it archived. Anything else is recorded in `orientation_putaways` (migration
  0.3.0, by thread, no foreign key: Delete, the purge and a newer ready build do not lose it), `clean` is
  false while a record exists (`start` and the tab's "Cleaning up" read it), and the sweep retries each
  under its orientation's lock (a reconcile does so first). This does not make reconcile run again: that
  stays load-and-unclean only, so it never meets this copy's own in-flight spawn (R1).
- **`finish` does not put its own builder away (R5).** It runs inside the builder's own tool call and marks
  the row ready; stopping or archiving that thread from there may deadlock or drop the tool result. The
  builder's next `thread.idle` puts it away (row ready, failed or cancelled and thread bound), with
  reconcile as the fallback. `cancel`, a user action from another thread, awaits the put-away.
- **Hidden threads of this plugin never reach the offer engine (R11)**, whether or not the row is bound
  yet; `thread.active`, `idle` and `failed` skip them.
- **Listings are captured by the server**, from `files.read`, at the file and line range the builder names;
  the agent never types code. The plugin runs nothing. A file missing or unreadable is a refusal the
  builder sees. `isNotFound` in `bb-ports.ts` is a heuristic (code `not_found`/`ENOENT` or the message).
  bb 0.49.0 answers a missing file with "HTTP 404: Path does not exist: <absolute path>" (code `ENOENT` in
  the CLI's JSON), and the builder sees "`path` does not exist in the workspace.", not the retry text.
- **Notes refuse fenced code and lines starting with an image (R4)**, so the export stays
  showboat-verifiable: a fence would be parsed as a block, and a line starting with `![…](…)` (a non-empty
  target) as an image block, whatever text follows it on the line (showboat drops that text). An image
  after other text on the line is commentary and allowed. The rule is showboat's own `parseImageRef` line
  test, `isShowboatImageLine` in `server/orientation-markdown.ts`, which the note check and the grammar port
  both import; a test exports every note the service accepts and finds no image block. Summary strings are held to one line
  each by the schema (no CR, LF, U+2028 or U+2029) and capped, so no field can start a line of the export
  with a fence that `showboat verify` would run; the renderer escapes a leading backtick or `!` of the
  purpose, the only field that starts a line. The test-only `server/testing/showboat-grammar.ts` ports
  showboat's block rules and checks the exporter against them.
- **Verify** reads each listing's file again and records one of `current`, `moved` (with the new range),
  `changed` or `missing`; a failed read leaves that listing's state as it was. Opening the walkthrough
  (`orientationDocument`) verifies only when the orientation's `verified_at` (migration 0.3.0, set at the
  end of every verify that reached a checkout, whatever each file's read did) is more than 5 minutes old
  or unset; never in between, so one unreadable file cannot make each opening check again. A verify calls
  `changed()` only when a listing's state or range changed (`changed()` refetches the tab, which would
  verify again), and the tab reads the walkthrough only while it is visible (`experimental_useTabVisible`).
- **`finish` checks the walkthrough's listing references**: at least one chapter, every listing named as
  `Listing N` in some note, and no note naming a listing that does not exist. A pop leaves a gap in the
  numbers (they are never reused), so the brief says to use the number each `orient_listing` call
  returns, and `orient_pop` is described as undoing the last block added (an early brief called it
  "close the chapter", and a live builder popped a listing that way).
- **Export** writes `<path>` in the repository through `files.write`. An existing file answers
  `{ exists: true, sha256 }` and nothing is written; the dialog then sends that sha256 back as
  `expectedSha256` with `replace` (R6), so a file that changed during the confirmation is not overwritten.
  Null or absent means the file must not exist.
- **The `"spawn"` session mode.** An orientation session is a *spawned* thread (Codex forks lack plugin
  tools) with at most 3 questions, and it does not count toward the per-thread cap of finished sessions.
  `startSession` refuses the orientation trigger; only `startOrientationSession` makes one. **Known gap:**
  Resume cannot recover a spawn session whose thread id never reached the store: `forkOf` cannot find a
  spawned thread, so it is abandoned (harmless, not a recovery).
- **Migration 0.3.0 rebuilds `sessions`** (R8, R9). SQLite cannot loosen a CHECK in place, and the new
  `mode` values need `CHECK mode IN ('fork','here','spawn')`. The rebuild copies sessions and exercises
  aside, drops, recreates and restores; `bb.storage.migrate` applies unapplied statements in one
  transaction, so a crash rolls back; the columns match the 0.2.0 schema exactly. It is independent of
  `foreign_keys` (it deletes `exercises` before dropping `sessions` rather than relying on the cascade).
  `migration.test.ts` pins it. Never edit it after release.
- **Mutations refuse other plugins** (`experimental_caller`); orientation RPCs answer refusals with code
  `conflict`. The `orientation` read also returns `last` (R10): the newest failed or cancelled build when it
  is newer than `current` and nothing is live, so the tab can show its reason and Rebuild.
- **The builder has permission to read and edit** in the user's checkout (bb has no tool-free thread). It is
  told not to edit, the brief treats repository text as data, and Start says so. A recorded decision.
- **Checked live on bb 0.49.0** (a dev bb, Claude Code builders). A hidden builder is `starting` right
  after the spawn and `active` during its first turn; a reconcile was observed keeping only an `active`
  one (a `starting` one is kept by the same rule, not seen live). The walkthrough tab's UI had not been
  opened live as of the Task 15 check (its data was read through `orientationDocument`); a later live UI
  check will update this. After `orient_finish` its turn
  ends and it is archived within half a second. `threads.list` filters on `originPluginId` and
  `archived: false`. A 0.2.0 store with a paused session upgrades with no log error and the session is
  still listed. A file exported twice asks to replace it, and `uvx showboat verify` passes on the export.
- **A reload mid-build does not end the build.** On bb 0.49.0 the new copy's reconcile finds the builder
  `active` and keeps it. The builder's next `orient_*` call in the same session reaches the new copy, and
  the row became `ready`. "Interrupted by a reload." is only for a builder that is not working (stopped,
  errored, or a `starting` row with no thread).
- **Checked live on bb 0.48.1 too** (an isolated dev bb, 2026-11-08), the minimum: `threads.list({
  originPluginId, includeHidden, archived: false })` filters as on 0.49 (this plugin's threads only,
  hidden ones included, archived ones excluded); `experimental_listPluginMetadata` returns the
  `orientation` key for a hidden builder; a hidden spawn with a reused environment, then stop and archive,
  works; and a reload mid-build keeps the active builder with `cleaning: false`. So `engines.bb >=0.48.1`
  stands.

## File references

Every file reference the plugin shows opens the file in bb's preview. bb's `Markdown` links a Markdown
link to a workspace path and an inline-code path (`src/a.ts`, `src/a.ts:42`, `src/a.ts:40-60`, and the
`#L42-L60` form) only where it knows the workspace: a chat message knows its thread's, a plugin's card or
tab does not, so `FileMarkdown` passes `experimental_document` (a file at the workspace root; bb 0.48.1's
`PluginMarkdown` resolves relative links from its folder and opens them with the line range). The server
puts the workspace (environment and absolute folder, `workspaceOf`) on the card, its settled row, the
thread view and a session's detail; history falls back to the source thread once the session thread's
environment is destroyed. A card's `files` go through `experimental_FileLink` with the suffix parsed into
`location`, and the path normalized first (`workspacePath`): bb leaves a workspace target with `.` or
`..` segments inert, so `./src/a.ts` becomes `src/a.ts` and a path climbing out of the workspace stays
code. Offer and session topics quote commit subjects verbatim, so they are not Markdown: only their
backticked paths become links (`TextWithFileRefs`). Topic choices and session titles sit inside a radio
label or a toggle button, where a link would fight the click, and stay plain text. The brief, the tool
and the CLI tell the agent to write references that way.

## Answer forms

A question can carry an answer form (`shared/answer-form.ts`): `learning_ask`'s `form` and `bb learning
ask --form-base64` take the same JSON. The card is this plugin's own `pendingInteraction` renderer, so
bb's `requestInput` hosts it as it is; no other surface is involved.

- **Flat, not nested.** A form is a list of items; `section` and `note` are items, and `width` (`half`,
  `third`) puts fields side by side. Containers of fields would make the schema recursive, and bb
  rejects a tool schema with a recursive `$ref` (some providers then refuse the whole tool list). The
  tool's JSON Schema is about 16 KB with no `$ref`; a test keeps it so.
- **The server checks every form when asked** (`parseAnswerForm`: the zod shape, then `checkForm` for
  unique ids, ranges, defaults and the limits in `FORM_LIMITS`) and refuses a bad one with its reasons,
  before anything is stored or shown. The card reads the payload's `form` with `readAnswerForm` and
  falls back to the plain text box when it cannot, so a form never breaks the card; `CardPayload`
  types it as JSON for that reason.
- **The server never trusts the card's answer.** It re-reads `fields` against the stored form
  (`sanitizeValues`: wrong shapes become no answer, numbers are clamped, texts cut, unknown keys
  dropped) and writes its own summary (`summarizeAnswer`) as the exercise's `answer`, so history,
  counts and the agent read the same thing. The agent gets the summary and the fields as JSON, both
  quoted as data. An answer with no `fields` (the fallback text box) is taken as text.
- **Untouched is not an answer, and the first state can be one.** A ranking starts `null` and becomes
  the answer when the learner moves an item or presses *Keep this order* (the order shown first may be
  the right one). A table's checkbox cells start `null`; ticking or unticking any box, or *Confirm
  unticked boxes*, decides them all (`checkboxesDecided`), and the boxes left alone then read as
  unticked (`confirmUnticked`), so "none of them" is an answer. `isAnswered`, `fieldProblem`,
  `hasAnyAnswer`, `sanitizeValues` and the summary all use that one rule, and the card sends the
  sanitized values, so readiness, the JSON, the summary and the history never disagree.
- **Agent text is text.** Labels and option names are rendered as React text, `help` and `note` through
  bb's `Markdown` (with `FileMarkdown`'s workspace), never as HTML.
- **The CLI's form is an argument, not stdin**: the question already uses the command's one stdin line,
  and base64 keeps the JSON away from the shell.
- Stored in two columns added to `exercises` (`form`, `fields`; migrations 11 and 12). The settled row
  carries the form and the fields so the transcript shows the answer part by part (`AnswerView`).
- Controls are native elements with bb's theme tokens (`accent-foreground`, `border-input`), so they
  are keyboard-operable and labelled without a component library; the grid collapses under a
  container query (`@md`, 28rem of card width), not the window's width. A live look in a dev bb has not
  been done yet: the checks are jsdom tests and the compiled CSS.

## The agent's feedback in the chat

A second real session (thread thr_9fuduh4nry) showed the captured reply was not enough: the feedback on
the last answer was a message in the turn that finished the session, folded into "Worked for" with the
rest of it, and only the closing line ("Thanks for working through these…") stayed in view. No next card
existed to carry it.

- **The feedback travels with the verdict.** `learning_feedback`'s `feedback` (Markdown, at most
  `FEEDBACK_MAX_CHARS`, 8,000) and `bb learning feedback --feedback-base64-stdin` take it, and the brief,
  the answer the agent gets back, the tool, the CLI and `SESSION_INVARIANT` say to put it there and not in
  a message. It is optional in the schema: a skip needs none, and an agent briefed before the argument
  existed (a session under way at the upgrade) passes none and still writes a message, which the log
  capture below keeps reading. Stored as `exercises.feedback` (migration 18); `Exercise.reply` is the
  feedback when there is one, else the captured reply, so the next card's `previous`, the history and the
  chat read one value. A question with feedback is never read from the log again (`readReply`,
  `unreadReplies`).
- **Where the card goes.** bb draws a plugin nowhere below a message and gives no plugin-written row, and
  the question card's own row is no help: a `bb.ui.requestInput` form's row is a work row placed where the
  form opened (bb 0.48.1 `buildPluginFormLifecycleMessage`, upserted by interaction id, never moved), so it
  folds with the turn too. What stays in view of a finished turn is its prompt and its last message. So
  `feedback()` stores the id of the turn it runs in (`feedback_turn`, migration 19; `ports.currentTurn`, the
  newest `turn/started` row's `scope.turnId`, which is the `turnId` bb gives message metadata), and
  `app/feedback.tsx` draws the card through `experimental_messageMetadata` ("above") on that turn's newest
  message on screen. Every message of a turn with a card registers in a module-level map (counted, since
  two panes can show one message); the newest assistant message wins, the turn's prompt only when the
  turn wrote none. While the turn runs the card follows its newest message; once it folds, only the last
  message is mounted (an expanded fold mounts older ones, which never win).
- **It survives a reload** and shows on every device: the card is the stored feedback and bb's own turn
  ids, read through `feedbackCards` (a read, tagged `LEARNING_TAG`, so `feedback()`'s `changed()` brings
  it at once). A verdict whose turn could not be read has no card; the next card and the history still
  have the feedback. A later verdict on the same question replaces the text and the turn it passes.
- **The finish summary stays a message.** It is the turn's last message, so it is what the last card
  sits above.

## The agent's replies, and questions that stand on their own

A real session (thread thr_f6iewpgi7a) lost its feedback: the agent wrote it as a message mid-turn, then
asked the next question, and when that turn ended bb folded the turn's earlier messages into the turn,
so only "I'm waiting for your answer" stayed in view. Its next question then said "the earlier version
… shown above" about code no message held.

- **A reply is what the agent wrote between an answer and the next question**, now only the fallback for
  feedback passed with no text (above). `exercises.reply`
  (migration 13) keeps it, read from the thread's event log (`ports.agentMessages`: `item/completed`
  rows of type `agentMessage`, paged newest first by `beforeSeq` in pages of 100, the most bb takes), from the exercise's `answered_at` to
  the next one's `asked_at`. It is read when the verdict is recorded, when the next question is asked
  (and goes on that card as `previous`, shown open above the question), and when the session finishes.
  It is the log, not live streaming, so it survives a reload, and Resume puts it back on a reopened card.
- **Replies no read kept are backfilled** (`backfillReplies`, from `sessionDetail` and Resume): a store
  from before replies were kept, or a read that failed. `agentMessages` answers null when the log cannot
  be read, which is not "no messages"; a closed window with no messages is stored as `""` so it is read
  once, and the app sees `""` as no reply. A session already under way when this build is installed gets
  its feedback back with no new message: the history at once, the card on Resume.
- **bb caps an event page at 100 rows.** bb 0.48.1 answers a larger `limit` with "HTTP 400: Thread event
  limit cannot exceed 100", and the first build of this asked for 200: every read failed in the live
  session, so no reply was kept. `EVENT_PAGE` is 100, both event reads page (`turnFileChanges` too, at
  most 3 pages), a failed read is a warning in the plugin log, and the tests' event log
  (`server/testing/event-log.ts`) refuses a larger page the same way.
- **Only a complete read is a reply.** A read is at most `REPLY_READ_PAGES` pages (20, so 2,000 rows), and says
  whether it reached the window's start (`complete`) or stopped on its budget, with the seq to go on
  below. An incomplete read is never stored as the reply, empty or shortened: a capture keeps what an
  earlier read kept, and the backfill leaves the question unread and saves where it stopped and the
  messages found so far (`reply_progress`, migration 14), so the next call goes on from there. One
  backfill call shares one budget across its questions, newest first. Saved progress is bounded like
  the reply: its messages joined oldest first and cut to `REPLY_MAX_CHARS` with a `truncated` mark, since
  only the start of a reply is kept; a stored value of another shape or size reads as none.
- **One history open finishes the job.** `sessionDetail` calls `recoverReplies`: one budget in the
  request, and when that read stopped short, a background continuation (one per session) of at most
  `REPLY_READ_CHUNKS` more budgets, which stops on an unreadable log or a reload and calls `changed()`
  when it kept a reply, so the open history refetches and shows it. This only matters for sessions
  recorded before replies were kept; do not grow it further.
- **A question must stand on its own.** The card is all the learner sees while answering, so the brief,
  the tool's description and parameter, the CLI and `SESSION_INVARIANT` say to put any code a question
  relies on inside it as a fenced block (above all code the files do not hold now) and never to point
  "above". Whether a question leans on something it lacks cannot be told from its text, so the server
  checks only what it can (`server/question.ts`): at most `QUESTION_MAX_CHARS` (8,000, room for code)
  and no code fence left open, refusing before anything is stored or shown. Fences are found by
  micromark, the CommonMark parser bb's own Markdown is built on, so fences in list items and block quotes
  are read with their container's indentation; a block with one `codeFencedFence` token never closed.

## Unsent answers

Leaving a thread unmounts its card, and a reload or a restart cancels it, so what the learner has typed
lives on the server with the question (`exercises.draft`, migration 15), not in the card.

- **The card saves its whole answer state** (the text box, or the form's values by field id, and the
  confidence) 500 ms after the last edit, and at once when it unmounts, the page is hidden
  (`visibilitychange`: a backgrounded mobile app sends no `pagehide`) or unloaded (`app/draft.ts`).
- **One question's saves go one at a time, in order.** A module-level queue per session and question
  (so it holds across mounts of the card) keeps one `saveDraft` in flight and only the latest snapshot
  waiting. The server stores whatever arrives and answers `saved`, false once the question is closed:
  the last save wins. Two devices typing into one question at once is out of scope; the last save wins.
  Do not bring back a client-side revision clock (an earlier round had one: clocks and counters disagreed
  across devices and remounts).
- **A backup of the newest edit lives in `localStorage`** (`draftStorageKey`, every access in try/catch)
  from the edit until a save of it is confirmed. An entry holds the snapshot, the mount that wrote it and
  when; a confirmation removes it only if storage still holds exactly that snapshot from that mount, so a
  late callback of an old card never removes a newer edit.
- **The server knows which browser saved last.** Each browser has a stable random writer id (`writerId`,
  in `localStorage`; one per page when storage fails), sent with every save and stored with the draft
  (`draft_writer`, migration 17) beside its token (the saved-at time, rising per question;
  `draft_saved_at`, migration 16); `cardDraft` answers both. On mount the card prunes by age and count,
  then reads the server first. A backup exists only while unconfirmed, so it is at least as new as
  anything this browser sent: it wins (restored, sent again) over no draft and over a draft this browser
  saved last, an own save that landed with its answer lost included. Only over another browser's draft
  does the backup's `base` count: the token of the draft its card read on mount. Still that token, the
  backup is newer and wins; moved on, the other browser's draft wins and the backup goes. An edit made
  before the read returns beats both, and when the read arrives this mount's own backup takes its token
  as base (another mount's backup, or a stopped card's, is left alone). Do not track tokens through acknowledgments or the queue: an
  earlier round did, and this page's own saves kept looking like another device's.
- **Backups are swept** (`sweepDrafts`, when a card or the Learning tab mounts): unreadable ones, ones
  older than 7 days, all but the newest 20 (a card does this part before choosing its backup), then
  those `openQuestions` says are closed; a failed read
  drops nothing more. Finishing or deleting a session in the tab drops its backups at once
  (`forgetSessionDrafts`).
- **A draft is read against the stored form like an answer**, when saved and again when handed back
  (`draftValues`: `sanitizeValues`, then a text field or list left empty starts as on a fresh card). A
  question without a form keeps only text, cut at `ANSWER_MAX_CHARS`; the RPC input is capped too.
- **It goes with the question.** `recordAnswer` clears it on an answer, a skip and "more specific"; a save
  for a question answered or skipped, or a session that is over, is ignored, so a save in flight when the
  learner submits leaves nothing. A pause keeps it (the card saves first), and Resume's card gets it back.
- `saveDraft` is a change, so another plugin is refused; `cardDraft` and `openQuestions` are reads and
  stay open, like the history's answers. Neither invalidates `LEARNING_TAG`: typing must not refetch every view.

## What bb 0.48.1 does that this relies on (the spike's evidence)

- **The minimum is bb 0.48.1 (SDK 0.6.104).** bb 0.48.0 ships SDK 0.6.94 (0.6.88 was never published):
  it has `experimental_FileLink` with `location` and `Markdown`'s `experimental_document`, but not
  `experimental_usePanelTabs` or the panel controller's `getTabs` / `closeTab`, which
  `useOneLearningTab` calls from the composer banner.

- **Codex forks get no plugin tools** (spike S2): `configure` runs and returns them, but a Codex fork's
  agent has none, even after a session restart. A spawned Codex thread does get them. So the brief in
  a fork names the tools first and the `bb learning` commands as the fallback, and `bb learning ask`
  opens the same card from the server and forwards the answer with a send. Do not remove that path
  until a bb fixes Codex forks. Claude Code, acp-omp and acp-hermes-agent forks get the tools.
- **Placement is by capability:** `providers.list()` `supportsFork` → fork, otherwise "here". No
  provider is listed by id. acp-cursor (no fork) and pi could not run on the spike machine; the gate
  handles them without a special case.
- **A card dies with a reload or restart** (S3): the old instance's `requestInput` is cancelled. On load
  `pauseOrphanedCards` pauses every `awaiting-answer` session, and Resume reopens the stored question
  from the server. After `dispose()`, `SessionService` touches neither the store nor the `bb` handle.
- **A detached card does not hold the thread** for SDK and CLI sends (S3, S8), but in the app it takes
  the composer's place, so the card carries Skip and Pause. Each card fires `interaction.pending`, so
  push notifications and Herald announce it; there is no API to mute that.
- **Commits come from the Git plugin, not the event log.** `workspaceStatus` with `mergeBaseBranch` set
  to the SHA noted at `thread.active` lists exactly the turn's commits (oldest first) and the files they
  touched with `A`/`M` status (S4). Matching `git commit` in command text is unreliable (report v2 §1.2)
  and is not used. A commit made while another thread in the same environment had a turn running is
  not attributed (S4 reproduced the misattribution).
- **A branch's commits need the default branch named.** `workspaceStatus` without `mergeBaseBranch`
  answers `mergeBase: null`, and `HEAD~1` is refused, so the tab's "last commit" topic compares a feature
  branch with `branch.defaultBranch`; on the default branch it uses the commits the thread's own turns
  made (recorded in `thread_state.last_commits`).
- **`fileChange` paths are absolute,** and Claude Code reports `/private/var/…` for a workspace bb knows
  as `/var/…`; `relativize` tries both.
- **`configure` runs on a fork before `threads.fork` returns,** so the session is not bound to the fork's
  id yet. `configure` accepts an unbound fork session whose source thread matches, and
  `SessionService.sessionIn` binds it from the thread's metadata on the first tool or CLI call.

## Testing

`npm test` runs the pure logic (`signals`, `policy`), the engine and the sessions over `FakePorts` and an
in-memory SQLite, the server wiring over the SDK's fake host with the real `bb-ports` (the zero-context
checks, a commit → offer → fork → card round trip, the "here" path through the CLI, both with and
without an answer form), the form schema (`shared/answer-form.test.ts`), and the app in jsdom
(`app/answer-form.test.tsx` drives every control by its accessible name). Live checks run in a dev bb (see the root `AGENTS.md`), never in the owner's.
