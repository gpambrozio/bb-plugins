# learning-exercises — notes for agents

An event-driven take on Dr. Cat Hicks's
[Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities) (CC BY 4.0; see
`NOTICE.md`). The design is the first mate's scout report v2 (`report-v2.md`, decisions D1–D16) with one
change: sessions are placed by provider capability, not by provider id. The phase 0 spike that shaped
it ran in an isolated dev bb (`spike.md` beside the report). This is phase 1: features #1–#10 of the
report's §6.1. Orientation, resume in a new thread, the sidebar journal, "Quiz me on this", spaced
retrieval and Showboat are later phases.

## The invariants

1. **Zero context upfront.** No `skills/` folder (`server.test.ts` checks), no `contributeInstructions`,
   and `configure` returns `{ tools: [], skills: [] }` unless the thread's metadata names a session
   the store has as open, in fork mode, bound to that thread (or not bound yet and forked from the
   session's source thread). The CLI shows up only in bb's generic `plugin-commands` skill body. Do not
   add a skill, an instruction or a tool that reaches threads with no session.
2. **Offers are deterministic.** No model decides an offer or writes a topic. Topics are commit
   subjects, paths and pull request titles, quoted. The exercise type is the agent's choice inside an
   accepted session.
3. **Offers only in human threads** (`policy.ts` `isHumanThread`): top level, no `originPluginId`, no
   lifecycle owner, visible, not archived. That excludes crews, automations, diff-review runs, side
   chats and this plugin's own sessions. **Manual starts are wider** (`canStartByHand`): any visible,
   unarchived thread except this plugin's own session threads, so a sub-agent thread can be a session's
   source. The fixed "Learning" tab is on the tab bar of every thread the sidebar lists (hidden threads are
   not listed), session threads included, where it shows the session with Pause and Finish but no Start.
   Earlier builds offered it in sub-agent threads only as the action tab `learning-on-demand`, from the
   side panel's launcher; bb keeps an action tab's open instances with the thread, so that tab stays
   registered, never offered, and `useOneLearningTab` (run by the always-mounted composer banner and by
   that tab) closes every instance, selecting the fixed tab first when one was selected: never two
   Learning tabs. `ThreadView.eligible` says offers are made there, `canStart` that Start is shown. Never
   let offers, the banner or the thread menu's offer choice follow `canStart`.
4. **The caps live in the server** (`policy.ts`), and count *seen* offers only. They are applied twice:
   when an offer is made, and again when it is about to show. Views read the offer through
   `OfferEngine.visibleOffer` (an unseen offer shows only while the caps would let it), and the banner or
   the tab claims it with `offerSeen` → `claim`, which re-checks the gate and the caps synchronously and
   charges it once. The app draws an unseen offer only after that claim answers `visible: true`, so two
   panes that read different queued offers never both show one. A session starting, running or waiting
   for an answer elsewhere in the project hides every offer in it, seen or not, without ending or
   charging it (`suppressed`); only the caps' accounting is skipped for an offer already seen. Every read, claim and answer also re-checks what can end an offer at any time
   (`offerStanding`: offers off, Never for the project, the thread opted out, a session open, a day old).
   An offer nobody looked at expires at the next turn or after 24 h and never counted. The banner's Start
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
| `app/tab.tsx` | The "Learning" tab, on the tab bar of every listed thread; the retired on-demand tab's clean-up |
| `app/file-refs.tsx` | File references as links that open the file in bb, at a line or range (below) |
| `app/thread-action.ts`, `app/settings-section.tsx` | "Learning offers" in the thread menu; the never-list under settings |

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
checks, a commit → offer → fork → card round trip, the "here" path through the CLI), and the app in
jsdom. Live checks run in a dev bb (see the root `AGENTS.md`), never in the owner's.
