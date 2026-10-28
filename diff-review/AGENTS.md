# AGENTS.md

A bb plugin that adds a **Review** tab beside each thread: the thread's workspace diff, drawn with the
`@pierre/diffs` bb provides, with comment threads on lines, ranges, files and the whole diff, stored in
the plugin's own SQLite, and **Send to agent**, which puts the open ones in the thread's chat (or a new
thread's). The agent answers each one with `bb diff-review reply|resolve|dismiss` or the
`diff_review_*` tools, and the tab updates live. **AI runs** — an AI review (which then answers
`@reviewer` / `@agent` questions about the view's threads), fixes in a new thread — each run in a
visible thread of their own in the reviewed workspace.
It is a bb take on [diffity](https://github.com/nilbuild/diffity)'s review loop, not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `diff-review`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the settings, the database and its migrations, the RPCs (through `refusing`), the CLI and the `thread.idle` / `thread.failed` listeners. |
| `host.ts`, `host/git.ts` | The host entry: git on the machine that holds a workspace, for the staged, unstaged and range views (diffity's ref grammar and merged fork point). Reads only. |
| `shared/host-contract.ts`, `shared/git-spec.ts` | The host entry's contract (imports the SDK root: never from the app); the views it serves and the revision grammar (no SDK import). |
| `server/git.ts` | bb's Git plugin (`bb--git`) through `bb.sdk.plugins.callRpc`: status, files, patches by revision, Viewed marks; a copy of the shapes read, and the "Git plugin is off" message. |
| `server/host-git.ts` | The server's client of the host entry. |
| `server/edits.ts` | Applying a suggestion and reverting a file or hunks: file reads and writes through bb, checked against what the tab showed (`expectedSha256`). |
| `server/refusal.ts` | `ReviewError`s answered as `experimental_PluginRpcRefusal`, so a caller's mistake is not logged as a crash. |
| `shared/routes.ts` | The Reviews page's addresses (`<thread>/<view>[/<file>]`), and `bb diff-review open`'s realtime request. |
| `shared/suggestion.ts`, `shared/revert.ts` | Suggestion blocks (diffity's) and line replacement; reverting hunks from a file's patch. |
| `server/review.ts` | `ReviewService`: everything the tab, the CLI and the thread events do to reviews — the view, threads and comments, sends, the agent's answers and who may give them, closing out a send after a turn. |
| `server/store.ts` | The SQLite tables (sessions, threads, comments, sends, runs, view states), their append-only `MIGRATIONS`, and every query. |
| `server/diff.ts` | The workspace a thread runs in, its refs (base branch, the branch's commits), and the diff from bb's Git plugin or, for the host views, the host entry, minus ignored files, with each file's revision and Viewed mark. |
| `server/ignore.ts` | Gitignore-style ignore patterns, from the setting and the workspace's diffity ignore files. |
| `server/prompt.ts` | The "Address review comments" message a send puts in the thread (adapted from diffity's prompts, MIT). |
| `server/cli.ts` | `bb diff-review list|reply|resolve|dismiss|comment|open`; base64 text through `--text-base64-stdin`. |
| `server/runs.ts` | `RunService`: AI runs — the pickers' defaults, starting a review, questions to the view's reviewer (follow-up turn or a new reviewer), a fix thread, a run's end (summary, files changed during a review), Close (archive), Clear review, and a review run's comments, checked against the diff. |
| `server/run-prompts.ts` | The first message of each run's thread (adapted from diffity's `review.md`, `thread.md`, `summarize.md` and `explain.md`, MIT). |
| `server/tools.ts`, `server/tool-names.ts` | The `diff_review_*` agent tools; their names and the run-id metadata key `configure` reads. |
| `shared/mentions.ts` | Whether a comment says `@reviewer` or `@agent` (outside code; diffity's rules, ported). |
| `shared/types.ts` | The data model and zod schemas, the realtime channel and its signals. No SDK import, so the app may use it at run time. |
| `shared/contract.ts` | The RPC contract. Imports the SDK root, so the app imports it as a type only. |
| `shared/patch-lines.ts`, `shared/anchors.ts` | A patch's lines by side and number, and where a thread belongs in the current diff (anchored, moved, outdated). |
| `app/review-panel.tsx` | The tab: the view picker, split/unified, *Only files with comments* (remembered in `localStorage` per bb thread, off until a thread turns it on; split/unified is one choice for all), reload, whole-diff comments, the *Not on the current diff* list, the files, the send dialog, the Clear review confirm (`app/clear-dialog.tsx`). |
| `app/file-diff.tsx` | One file: its header (with its thread count while the switch is off), whole-file threads, and Pierre's `PatchDiff` with thread annotations and the gutter "+". |
| `app/patch-loader.ts` | Patches bb did not send with the file list, asked for as files come near the screen and fetched in batches, one request at a time. |
| `app/tab.ts` | The tab's reference and `openReviewTab` through bb's panel controller; `app.tsx` registers the tab, the header thread action, the commands, the Reviews page, the Info row and the open overlay. |
| `app/commands.ts` | The palette commands' bus: a command opens the thread's tab and leaves its action for the tab that shows. |
| `app/find.ts`, `app/find-bar.tsx`, `app/goto-dialog.tsx`, `app/reveal.ts` | Find across the diff (diffity's), Go to, and scrolling a place into view inside Pierre's open shadow root. |
| `app/files-view.tsx` | The "Any file" view: workspace search, Pierre's `File` with the same annotations. |
| `app/suggestion-block.tsx`, `app/revert-dialog.tsx`, `app/range-dialog.tsx` | A suggested change and Apply; Revert…; the range picker. |
| `app/open-file.ts`, `app/palette.ts` | Which version Open previews; the colour-blind colours. |
| `app/git-status.ts` | A zod-free client view of the Git plugin's `workspaceStatus`, watched to reload on changes outside a turn. |
| `app/reviews.ts`, `app/reviews-page.tsx`, `app/thread-info.tsx`, `app/open-overlay.tsx` | The Reviews page (sidebar, title, badge), the thread Info row, and the overlay that answers `bb diff-review open`. |
| `app/thread-card.tsx`, `app/comment-composer.tsx` | A thread and its comments; the box comments are written in. |
| `app/view-state.tsx`, `app/scroll-memory.ts` | What the tab keeps per thread and view (unsent comments, folds, scroll place as file + offset) and its saving; restoring the scroll place while patches load. |
| `app/send-dialog.tsx` | Picking threads and a note for **Send to agent**, to this thread or a new one. |
| `app/ai-review-dialog.tsx`, `app/execution-picker.tsx` | The AI review dialog (focus chips, instructions); bb's provider/model picker, seeded from the settings. |
| `app/runs-list.tsx` | The session's runs under the toolbar: status, files a review changed, Open thread, Close. |
| `app/use-review.ts`, `app/actions.tsx` | The tab's data (RPC + realtime) and the thread actions every card shares. |
| `skills/diff-review/SKILL.md` | What an agent needs to answer: the commands, base64 through stdin, how to write answers. |

`npm test` runs everything. The server tests drive `server.ts` on the SDK's fake plugin host with a
real temporary SQLite; the app tests render the tab with a stand-in for `@pierre/diffs/react`, since
jsdom cannot run its highlighter. `app/annotation-layout.test.ts` checks the comment boxes' layout with the real Pierre in
Chromium (`playwright-core`, the page bundled by `esbuild` from `app/testing/`); it finds a local
Chromium or Chrome (`CHROME_PATH` overrides) and is skipped without one, except in CI.

**The fake host's SQLite needs better-sqlite3's native binding.** npm 12 blocks install scripts, so a
fresh `npm install` there leaves it unbuilt and every server test fails with "Could not locate the
bindings file". Run `npx prebuild-install` inside `node_modules/better-sqlite3` once. npm 11 (CI's,
with Node 24) runs the script itself.

## Decisions

**The fixer is the thread under review**, by default. A send goes to the thread the tab belongs to,
through `threads.send` with `queue-if-active`, so it waits for a running turn instead of steering it;
the agent that wrote the code has the context. *A new thread…* in the send dialog starts a fix run
instead.

**AI runs are visible child threads of the thread under review**, in its workspace (`threads.spawn`
with `parentThreadId` and `environment: { type: "reuse" }`), so they sit under it in the sidebar. The
owner chose this over the plan's root-level threads after trying them. The parent is the thread whose
Review tab started the run (for a reviewer an @reviewer starts, the tab the comment was written in), and only while it
still works in the reviewed workspace; otherwise the run starts at the root. They are never hidden
(the owner watches, steers and approves there, and hidden helpers bring the reload problems of issue
#11). They run in the `aiPermissionMode` setting's mode, **`auto` ("Approve for me") by default**:
`accept-edits` asked the owner to approve most of a review's commands. A provider whose `capabilities.permissionModes` (from `providers.list`) lacks the configured mode runs in `full` instead (`spawnPermissionMode`): bb refuses the spawn otherwise, as it did for opencode, which has no `auto`. The provider and model come
from the per-run picker, seeded from the settings (Claude Code unless changed); a reviewer an
@reviewer starts runs the settings' provider and model, at the provider's default reasoning.

**A child reports to its parent, and that must not turn into work.** bb posts every finished turn of
a child to its parent (`[bb system] @thread:<child> completed: <its final message>`, and a
"needs help" notice when a child waits on an approval), which wakes the parent's agent. Three things
keep the parent from taking a report for a request: every run prompt makes the final message open with
`REPORT_LINE` ("Diff Review status report — no action needed…"), which works on a session already
running; `contributeInstructions` tells a thread with run children (`runs.parent_thread_id`) what the
notices are, from its next session; and the skill says the same. Nothing can loop: the plugin sends
nothing to the parent when a run ends, agents cannot start runs (only the tab's buttons and a
*user's* @reviewer does; an agent's comment never triggers one), and the parent's agent can only
answer threads already sent to it. A notice still costs the parent a short turn. A run's row is written before its thread is
spawned, so a thread bb refuses leaves a *failed* run that says why. **Close** archives the thread.
**Clear review** deletes a session's threads and sends and closes its runs in one transaction, then
archives the runs' threads; closing first means a run still working loses its rights at once (a
closed review run cannot comment, and no send is left to answer). Closed run rows are kept, so
`hasRunChildren` keeps telling the parent what late notices are. Work in flight when a run closes
loses too: a review comment rechecks the run after its awaits, and a thread bb starts for a run
already closed is archived as soon as it exists.
A run ends on its thread's `thread.idle` / `thread.failed`, keeping the agent's last message as the
summary; it is never parsed for answers.

**A review run cannot be read-only, so it is watched.** bb has no tool-free thread. The review prompt
says not to edit; the workspace's uncommitted changes are fingerprinted (each file's change kind, line
counts and patch hash) when the run starts and when it ends, and every file that differs is listed on
the run. Another thread editing the same workspace meanwhile shows up there too, which the tab says.

**A view's reviewer answers @reviewer.** The owner wanted follow-up questions to reach the agent that
already knows the diff, not a fresh one per mention. `@reviewer` or `@agent` (both the same; provider
names like `@claude` start nothing since) in the user's own comment sends that comment thread to the
view's reviewer — its latest review run not closed (`reviewerRun`) — as a follow-up turn
(`threads.send`, `queue-if-active`), and marks the run running. With none (never reviewed, closed,
cleared, or its thread gone), it starts a review run that answers the question first and is the
reviewer from then on. Questions are taken one at a time per view (`asking`), so two at once cannot
start two reviewers, and a comment thread already queued to the reviewer is not queued again: the
follow-up prompt has the agent read the thread as it is when its turn runs. The reviewer is told not to
edit (it recommends changes instead), like any review run. A run's rights last until it is closed, so
follow-up turns keep them; a turn that ends while a question is still queued behind it leaves the run
running. Old `mention` runs stay readable but no new ones start.

**Rights are read where they are used, after every await.** The review loop found each of these
orderings; each has a test:
- An agent's answer (`answer`) awaits bb (author, turn start) first, then reads its rights and writes
  in one step (`answerAsAgent`). A send reassigned or a run closed meanwhile leaves it refused and every
  row as it was. The answer marks a send answered only if that send went to this agent and existed when
  its turn started, so an earlier turn's answer never acknowledges a question queued after it.
- A closed run's thread has no rights at all (`isClosedRunThread`), its sends' included; Close and
  Clear review close in the store before they ask bb to archive.
- A run starts in order (`spawn`): the view's clear count is checked, then the run row and its sends
  (to `pendingRunThread`) are written before anything awaits bb, then bb is asked. A thread calling in
  (tool, CLI, turn end) before `threads.spawn` answers is bound by `bindIfPending`: bb stamped it as
  this plugin's (`originPluginId`) and its metadata names a run still waiting for its thread. Metadata
  alone proves nothing; any client may write it.
- A question to the reviewer is skipped as already queued only while it waits behind a turn that has
  not started; once a turn took it, a new question gets its own.
- A failed send, or a run's start cancelled before bb was asked, restores each thread's previous send
  (`dropSend`). What each send replaced is kept per thread in `send_previous`, not in memory: a send
  rolled back while a later one owns the thread splices itself out of that send's "before", so
  overlapping sends roll back right in either order and never point a thread at a deleted send. A
  turn end marks "no reply" only the very sends it saw (`markNoReply` by send id).
- The workspace key hashes on-demand patches too, fetched up to `FINGERPRINT_MAX_FILES`; past that,
  or when bb does not answer, the key is new each time (reload rather than show a stale diff).

**Questions to the reviewer and fix runs are sends.** They record a send to the run's thread in the
same ledger, so the agent's answers go through the same check as the thread under review's: only the
thread a comment thread was last sent to may answer it. A review run may also act on every thread of
the session it reviews, and only a review run may open new threads (`comment`), each checked to lie
on lines the current diff shows; a refusal lists the lines that are (diffity's `add_comment` checks).

**Tools for runs, the CLI for everyone.** `bb.agents.configure` offers the `diff_review_*` tools only
to threads whose plugin metadata carries a run id, and the `diff-review` skill to every thread
(returning `skills` is required once `configure` exists: a fake host or bb without the skill id fails
the whole selection closed). Metadata grants nothing by itself: each tool call is checked against the
store by the calling thread's id, which bb supplies (unlike the CLI's claimed `ctx.threadId`). Run
prompts name the CLI as the fallback when a tool is missing.

**The agent answers through the CLI, never through its transcript.** `threads.send` is the only way in
and `bb diff-review` the only way back: the plugin never parses the agent's text. A plugin CLI works
in any thread at once, where a `bb.agents.registerTool` tool would reach a thread only from its next
provider session.

**Only the thread a comment was sent to may answer it.** `ReviewService.answer` matches the caller's
`ctx.threadId` against the thread's last send. That id is what the caller's `bb` reports, a claim and
not an identity (root `AGENTS.md`); the check keeps one thread from answering another's review by
mistake, not a hostile local process out. The user's side, the RPCs, is trusted.

**"No reply" is decided from the thread's own turns.** On `thread.idle` or `thread.failed`, threads
still `sent` to that thread are marked `no_reply` only if they were sent before its latest
`turn/started` event (sub-agent turns, which carry a `parentToolCallId`, do not count). A send queued
behind a running turn is therefore not closed out when that earlier turn ends.

**A send is recorded before it is delivered**, so an agent quick enough to answer before
`threads.send` returns is allowed to, and dropped again if bb refuses the message.

**Anchors are read, never rewritten.** A thread keeps the lines and text it was made on. Each load
places it against the current patch (`shared/anchors.ts`): the same text at the same lines, else the
nearest copy of the text on that side (blank anchors are never moved), else *outdated*. What the agent
is told is always the original place and text.

**Sessions are per workspace and view.** `review_sessions` is keyed by environment id and the view's
key (`uncommitted`, `branch:<base>`, `all:<base>`, `commit:<sha>`), as diffity keys them by repository
and ref. Two threads sharing a workspace share its comments; each sends from its own tab.

**The plugin draws its own diff.** bb's diff panel and `experimental_Diff` have no annotation or
line-click hooks (still none in bb 0.48, which added only "Add to chat"), so the tab renders `PatchDiff` from the host-shimmed
`@pierre/diffs` (a type-only devDependency at the host's version). bb's shim passes options through
unchanged, so the plugin sets `theme` and `themeType` from `experimental_useCodeTheme()` itself.

**Which machine.** Nothing is server-Mac-only: the diffs come from bb's Git plugin, the staged,
unstaged and range views from the plugin's own host entry (`host.ts`, git in the checkout), files
from `bb.sdk.files.*`, all on whichever machine holds the workspace, remote hosts included. Raw git a
new feature needs goes in the host entry, which only reads; writes (a suggestion, a revert) go
through `bb.sdk.files.write` with `expectedSha256`, never through git.

**Diffs come from bb's Git plugin.** bb 0.48 moved every git read out of `bb.sdk.environments` into
the bundled plugin `bb--git` (`server/git.ts` calls `workspaceStatus`, `files`, `patches`, `viewed`,
`markViewed`, `clearViewed`). Patches are keyed by the revision `files` returned, so a load asks for
the version it listed; the app sends `{ path, revision }`. A failed call asks `plugins.list` whether
the plugin is off and says so. The contract is not published: the plugin keeps its own non-strict
copy of the shapes it reads. The tab also watches `workspaceStatus` through a zod-free client view
(`app/git-status.ts`, tag `status:<env>`) to reload on changes made outside a turn; that contract is
internal and unversioned, so a failure there only loses the extra reloads.

**Viewed marks are bb's.** They live in the Git plugin per environment, view and revision, shared with
bb's diff panel; a mark at an older revision is "changed since viewed". The host views and Any file
have no marks (`viewable: false`).

**The tab is an `experimental_tab`, the button a header thread action, both opened through the panel
controller.** bb 0.48 retired `threadPanelAction`, `experimental_threadHeaderAction` and
`ctx.openPanel` / `openThreadPanel` from the typings. The tab keeps the id `review` (saved tabs and
their params carry over); the header action is `experimental_threadAction({ placement: "header" })`,
whose `item` gets the panel controller (its `run` does not). A palette command opens the tab and
hands its action to the tab through `app/commands.ts`. A hidden tab (`experimental_useTabVisible`)
defers reloads until it shows.

**Summaries and explanations are review runs with a purpose.** The `runs` table's kind check predates
them and SQLite cannot widen it, so they are stored as `kind = 'review'` with `purpose` set; they read
and comment like a review (watched for edits) but are never the view's reviewer.

**Diffs load without a tap.** bb's `diffFiles` may send no patches up front (it sent none for a
42-file working tree), so every file without one asks for it when it comes within a screen of the
tab's scroll area; the asks are batched (25 paths, one request at a time). Only a change of more than
2,000 lines starts folded, and it loads when unfolded; binary and too-large files say why they have no
line diff. Never put a "Load diff" button back.

**The first view is picked once.** A tab opened without a view sends `autoTarget` on its first
`getReview` only; the server answers with the branch's commits when the uncommitted view is empty and
the branch has some, and the tab's picker adopts that view without loading it again. No later load
(a reload, a realtime signal, a reconnect, the user's pick) sends it, so a choice is never overridden.

## Invariants

- `MIGRATIONS` is append-only; bb checks each applied statement's hash. 0.1.0 shipped indexes 0–6;
  0.2.0 added the `runs` table at 7–9, its `parent_thread_id` at 10 (an `ALTER`, since 7 was
  already applied on installs of the branch), `view_states` at 11 and `send_previous` at 12; 0.3.0
  added `review_threads.file_revision` at 13 and `runs.purpose` at 14.
- The tab's kept state (drafts, file and thread folds, scroll) lives in the plugin's database, keyed by bb thread and
  session, not in `localStorage`: it must survive a restart and follow the user to another device (the
  owner uses bb remotely). Saves are debounced and flushed when the tab unmounts or the page hides; a
  copy per window wins over the server's when it is newer (`savedAt`), so a remount never loses to a
  save in flight; the server keeps an older copy from out of order (by `savedAt`). `getReview` drops
  reply and edit drafts whose thread or comment is gone. A draft is never hidden: a file with one
  opens, the comment filter shows it, a line draft whose lines left the diff sits above the diff, and
  drafts on files no longer in the view are listed apart. Reopening an editor keeps its draft.
- Patches loaded on demand land only on the session and load that asked for them.
- Updates land in place. Pierre redraws a file's whole diff whenever its `lineAnnotations` array is a
  new object, so unchanged threads, runs and files keep their objects across a refresh or reload
  (`shareById`, `mergeView`, `groupByFile`, and `NO_THREADS` rather than a fresh `[]`), and a reply
  redraws only its own file. A reload keeps an on-demand patch on screen while it is fetched again
  (`stalePatches`). The patch loader resets during render, not in an effect: an effect ran after the
  files' own effects had asked for their patches and wiped those asks.
- A turn's end sends the `diff` signal (every tab reloads its whole view) only when the workspace's
  state (`workspaceState`: HEAD, base, uncommitted files and up-front patches, from named fields only)
  changed since the last turn's end or since a tab first loaded it (so the first turn after a plugin
  load does not reload everything); most turns, such as a reviewer's answer and the parent reading its
  notice, change no file. Another agent editing the reviewed workspace does change it, so a reviewer's
  turn ending then reloads, in place. A tab merges triggers: a signal or a reconnect during a load runs
  one more load after it, never a second one beside it.
- **Reading a reload in the log** (`bb plugin logs diff-review`, debug level): each full load says
  `Loading the <kind> view of <thread>'s workspace <env> for tab <id> (<reason>)` (`open`, `view`,
  `diff-signal`, `reconnect`, `manual`, `retry`); each turn end says whether the workspace was
  `unchanged` or `changed from (…) to (…)`. One signal reloads every open tab, so two loads with the
  same reason and different tab ids are two tabs, not a duplicate. A review run's new comment reads the
  ignore files too, after `Reading the diff of <env> to check a review comment`.
- The app never imports the SDK root at run time: the contract is a type import, the schemas and the
  channel name live in `shared/types.ts`.
- `@pierre/diffs` stays a devDependency: bb provides it.
- Text from the CLI is capped at 12,000 bytes, so its base64 fits bb's one stdin line of 16 KiB.
- Nothing the agent writes is trusted as Markdown beyond what the host `Markdown` component renders.

## Roadmap

The open work is https://github.com/gpambrozio/bb-plugins/issues/64 (it merged #47 and #48).

- **Phase 3:** GitHub pull request review (fetch `pull/N/head` through the host entry, sync review
  threads, submit a review with `gh` as the owner, a worktree thread for fixes).
- Not taken: bb's tagged live reads in place of the realtime channel (no user-visible gain), and
  diffity's chaptered guide (the Community `guided-review` plugin covers it).
