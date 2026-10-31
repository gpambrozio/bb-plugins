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
| `host.ts`, `host/git.ts` | The host entry: git on the machine that holds a workspace, for the staged, unstaged and range views (diffity's ref grammar and merged fork point) the index's fingerprint, and a pull request fetched into private refs. |
| `host/revert.ts` | Revert, on the workspace's machine: bb's Git plugin revision recomputed and checked, symlinks and submodules refused, the last check synchronous before the rename or removal. |
| `shared/host-contract.ts`, `shared/git-spec.ts` | The host entry's contract (imports the SDK root: never from the app); the views it serves and the revision grammar (no SDK import). |
| `server/git.ts` | bb's Git plugin (`bb--git`) through `bb.sdk.plugins.callRpc`: status, files, patches by revision, Viewed marks; a copy of the shapes read, and the "Git plugin is off" message. |
| `server/host-git.ts` | The server's client of the host entry. |
| `server/edits.ts` | Applying a suggestion (bb's file read and `expectedSha256` write, its lines checked against what the tab showed) and handing a revert to the host entry. |
| `server/github.ts`, `server/pull-requests.ts` | `gh api graphql` (diffity's queries) and the `pr` view: load (host fetch, range diff, the account's Viewed marks), mirror review threads, reply / resolve and Viewed on GitHub, the review plan and Submit. |
| `server/testing/github-schema.ts` | The slice of GitHub's GraphQL schema the Viewed requests use, recorded from introspection, and the checker the tests' fake `gh` runs on them. |
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
| `app/tab.ts` | The tab's reference and `openReviewTab` through bb's panel controller; `app.tsx` registers the tab, the header button, the commands, the Reviews page, the Info row and the open overlay. |
| `app/header-action.tsx` | The header's Review icon button (the old header slot, see below) and the one-control registration, with its fallback. |
| `app/commands.ts` | The palette commands' bus: a command opens the thread's tab and leaves its action for the tab that shows. |
| `app/find.ts`, `app/find-bar.tsx`, `app/goto-dialog.tsx`, `app/reveal.ts` | Find across the diff (diffity's), Go to, and scrolling a place into view inside Pierre's open shadow root. |
| `app/comment-nav.tsx` | Previous/next comment: the toolbar's and each thread's arrows, the palette's commands and Go to share one list of stops, each at the place its card is drawn (the top sections — whole diff, then "Not on the current diff" — then each file's whole-file threads under its header and its line threads by line), wrapping at the ends; a step brings that place into view, marks the card as the current one (a programmatic focus shows no ring after a click) and focuses it. A line thread whose file's patch has not loaded is a `pending` stop: a step to it waits for the patch. A folded thread's one-line button carries the same `data-thread-id` and current marker as a card, so it is a place to land too. Only the latest focus job on a scroll area may scroll or focus (`focusThread`): an older one waiting for a late card gives up, as does one the user takes over with a wheel, touch or click (not a key, which may be the very shortcut that started it). Every jump goes through `show`, which also drops a step still waiting for its file's diff (`awaitedComment`), so that diff arriving later lands nowhere. A jump that reveals no file (a comment in the top sections, or one waiting for its diff) and the same take-over also drop the last `reveal`: a file reveals itself again when its diff arrives, and would pull the view back to it. |
| `app/files-view.tsx` | The "Any file" view: workspace search, Pierre's `File` with the same annotations. |
| `app/suggestion-block.tsx`, `app/revert-dialog.tsx`, `app/range-dialog.tsx` | A suggested change and Apply; Revert…; the range picker. |
| `app/open-file.ts`, `app/palette.ts` | Which version Open previews; the colour-blind colours. |
| `app/pull-bar.tsx`, `app/pull-dialog.tsx`, `app/submit-dialog.tsx` | A pull request's bar (Sync, Open on GitHub, Submit), picking one by address, and the Submit dialog with the verdict. |
| `app/reviews.ts`, `app/reviews-page.tsx`, `app/thread-info.tsx`, `app/open-overlay.tsx` | The Reviews page (sidebar, title, badge), the thread Info row, and the overlay that answers `bb diff-review open`. The badge counts exactly the reviews the page lists (`counts(null)` sums `listReviews`), so a review whose workspace is archived, which the page leaves out because it can no longer be loaded, is not counted; the store keeps it. The badge's every refresh costs what the page's does (a `threads.get` per listed review). `app/orphans.tsx`: the reviews the page leaves out *and* whose workspace bb says is destroyed (`orphanReviews`), counted under the list with Delete…, which confirms first. Deletion is only ever the user's: `deleteOrphanReviews` checks each id again and deletes only those still orphans that the page offered (`deleteSession`, which takes every table's rows; open runs close and their threads are archived). A workspace bb cannot be asked about is not taken for gone. A review keeps any run (not closed) that still has a worker, in any workspace: one still starting (running, no thread yet; a start that failed before it had a thread is no worker), or a thread not archived (a fixer in a worktree of its own), so the delete never cancels live work. The delete checks each review afresh right before its own delete (`orphanCheck`, workers asked last), never from one scan of them all, and skips it when its runs changed while it was checked (no await between that check and `deleteSession`). A start whose run row is gone when bb is asked, or when bb answers, refuses and archives the thread it got. |
| `app/thread-card.tsx`, `app/comment-composer.tsx` | A thread and its comments; the box comments are written in. |
| `app/view-memory.ts` | The view picked in a thread's Review tab, kept in `localStorage` per bb thread with the `params` target the tab was opened on: bb mounts the tab anew whenever its thread is opened, so without it the picker went back to the default. A tab opened on another view starts there; a kept view the server can no longer read (`unavailable`), or a pull request's that is no longer open (`keptViewGone`), is forgotten and the tab starts over on the default. The first load's own pick is not kept. |
| `app/view-state.tsx`, `app/scroll-memory.ts` | What the tab keeps per thread and view (unsent comments, folds, scroll place as file + offset) and its saving; restoring the scroll place while patches load (`app/scroll-within.ts`'s hold). |
| `app/send-dialog.tsx` | Picking threads and a note for **Send to agent**, to this thread or a new one. |
| `app/ai-review-dialog.tsx`, `app/execution-picker.tsx` | The AI review dialog (focus chips, instructions); bb's provider/model picker, seeded from the settings. |
| `app/runs-list.tsx` | The session's runs under the toolbar: status, files a review changed, Open thread, Close. |
| `app/use-review.ts`, `app/actions.tsx` | The tab's data (RPC + realtime) and the thread actions every card shares. A load of a view other than the one on screen is a switch: the state keeps the previous view with `pending` (the request, and its error if it failed), the panel shows the pick in the picker, dims and `inert`s the old toolbar and content under bb's `Spinner` (or the error with Try again), and only the latest load's answer or failure lands (`generation`). |
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
new feature needs goes in the host entry, which reads (but for Revert, below, and fetching a pull
request into the plugin's own refs); a suggestion is written through
`bb.sdk.files.write` with `expectedSha256`. **An AI run on a range view is told the two commits the tab
compares** (`rangeCommits` on the host, the same `plan` as the diff), never `git diff a..b`: the tab
diffs `a..b` from the merge base, and a merged `a...b` from where it forked, which a raw `git diff
a...b` shows as empty. With Hide whitespace, git leaves a whitespace-only file out of the patch
altogether, so the host view drops a listed file with no section. A suggestion block's `code` is the
text between its fences as written; `suggestedLines` reads it, so a blank last line counts and an
empty block (remove the lines) differs from one holding a blank line. A thread's lines as text (`linesText`: joined with "\n", no terminator) always hold one line at least, so "" is one blank line, and *Suggest a change* puts that text between the fences whole: a blank last line stays in the seeded block. **Revert is the host entry's** (`host/revert.ts`): bb's file
reads and writes follow symlinks, so a revert through them wrote the old link text into the link's
target, and `expectedSha256` taken after the reads guarded only the moment after them. The host reads
the working file's bytes once and hashes them as bb does (`git hash-object --stdin --path`, attributes
and line-ending rules applied), whatever blob git's diff reported, and refuses unless that revision
(`oldMode:oldBlob:newMode:newBlob`) is the tab's. It takes the checkout's real path and
folder identity once, before anything is awaited, builds every path on it, and every check confirms the
checkout is still that folder (a checkout swapped for a link during `cat-file` otherwise led the write
outside it). Every folder on the way must be a real folder inside the checkout (a symlinked folder led a
restore outside it); a deleted file's missing folders are made when it is put back. Symlinks and
submodules are refused. The new bytes go into a random-named temporary file created with `wx` and
written through its own descriptor (a predictable name was a planted-symlink target), all of them:
`writeAll` goes on after a short write and refuses on an error or no progress, so a full disk or a
file-size limit never renames a truncated file over the original. A deleted file is put back the
same way, staged in full and then hard-linked to its name (`link` fails when anything is there now),
so no failure path ever removes or overwrites the destination: cleanup only removes Revert's own
temporary file, and only while the checkout and its folders still check out. The folder checks
run in the same synchronous step, with no await, as the temporary file's creation, and again with the
byte comparison right before the rename or the removal. A save landing in that same instant from another process is the one change it can still
miss.

**Diffs come from bb's Git plugin.** bb 0.48 moved every git read out of `bb.sdk.environments` into
the bundled plugin `bb--git` (`server/git.ts` calls `workspaceStatus`, `files`, `patches`, `viewed`,
`markViewed`, `clearViewed`). Patches are keyed by the revision `files` returned, so a load asks for
the version it listed; the app sends `{ path, revision }`. A failed call asks `plugins.list` whether
the plugin is off and says so. The contract is not published: the plugin keeps its own non-strict
copy of the shapes it reads.

**Reads nobody waits for are abandoned, but only reads that fill a view in.** `loadPatches` and
`getReview` hand the RPC handler's `experimental_signal` (bb 0.48.1; absent on 0.48.0, so it stays
optional) to the Git plugin's `patches` calls and to the GitHub PR Status read (`branchPull`), through
`callRpc`'s `signal`, and to a pull request's Viewed read, whose `gh` it kills. That ends this plugin's wait and the patch batches not yet sent, not the work
already started: in bb 0.48.1 the Git plugin's `patches` and PR Status's `pullRequests` handlers ignore
their request signal, so a host read under way runs to the end. Stopping it needs bb to pass the signal
on, and PR Status to keep a lookup another caller shares. bb aborts it when this plugin copy is reloaded, disabled or removed, or the
caller's HTTP request disconnects (a window closing mid-load); the app's `useRpc().call` takes no
signal, so the app cannot abort one itself. A call abandoned that way does not ask `plugins.list` whether Git is off, and the
commented files' patches it cut short are left to load on demand without a warning. The rest of
`getReview` (status, files, the session and the GitHub sync) runs whatever the signal says, because it
writes the session; cutting it short half way would leave a session half written. `refusing` passes
the handler's context through.

**Changes outside a turn reload by content, not by counts, and only for tabs that show.** bb's status
lists paths, letters and line counts, so a same-size edit leaves it equal. A showing tab holds a lease
on its workspace (`watchWorkspace`, renewed every 30 s, lapsing after 90 s, given back when it hides or
closes). The server subscribes to bb's `environment:changed`; for a workspace with a lease it coalesces
the events (400 ms, at most 2 s) and compares the same content-sensitive state a turn's end does (every
uncommitted patch's hash), plus the index's fingerprint from the host entry when a leased view is
staged or unstaged; only a change sends `diff`. For a workspace no tab shows, an event only marks it,
and the first lease taken after that has it checked once. The check reads only, so it cannot set off
another.

**Viewed marks are bb's, or GitHub's on a pull request.** They live in the Git plugin per environment,
view and revision, shared with bb's diff panel; a mark at an older revision is "changed since viewed".
The host views and Any file have no marks (`viewable: false`). A `pr` view's marks are the `gh`
account's own on GitHub (`PullRequest.files { path viewerViewedState }`, 100 a page, up to GitHub's
3,000 files), read beside the fetch on every load; `DISMISSED` (GitHub's reset when a file changes
after it was viewed) is "changed since viewed". The box calls `markFileAsViewed` /
`unmarkFileAsViewed` with the pull request's node id and the path, a file of the last load only; the
tab already updates first and rolls back with a toast. GitHub keeps one mark per file, not per
revision: a push between the load and the tick marks the new version viewed (the next load shows it),
so the file's `revision` is not sent. A read that fails gives the view no boxes and the bar's
`viewedError`, never a failed load; it is the one GitHub read `getReview`'s signal abandons, since it
writes nothing. The fake `gh` checks these requests against `server/testing/github-schema.ts`;
re-record that slice by introspection (`__type(name: …)`, read only) when a request changes.

**The tab is an `experimental_tab`, the button the old `experimental_threadHeaderAction` slot, both
opened through the panel controller.** bb 0.48 retired `threadPanelAction`,
`experimental_threadHeaderAction` and `ctx.openPanel` / `openThreadPanel` from the typings. The tab
keeps the id `review` (saved tabs and their params carry over). The header button is *not*
`experimental_threadAction({ placement: "header" })`, the slot that replaced the old one: bb 0.48 draws
every plugin's header thread actions as one shared split button (`ThreadDetailHeader.tsx`: the first
action is the label, the rest sit in its dropdown), so with Herald installed Review became an entry in
a "Herald" dropdown. The old slot, which bb 0.48 still mounts but no longer types, draws each plugin's
component as its own control, inside the thread's panel controller, so the icon button toggles the tab
with `experimental_useAppPanel().toggleTab`. `app/header-action.tsx` reaches the slot through an
untyped cast and registers exactly one control: the old slot when `app.slots` has it, else a header
thread action. **A future bb may drop the old slot**; the fallback then takes over by itself, back in
the shared split button — check the header after every bb release. A palette command opens the tab
and hands its action to the tab through `app/commands.ts`. A hidden tab (`experimental_useTabVisible`)
defers reloads until it shows.

**Pull requests are reviewed read only, and posted only by the user.** The `pr` view's diff comes
from the host entry's `fetchPull` and its `base...head` range. It fetches the head and base into
`refs/diff-review/pull/<owner>/<repo>/<n>/…` of the workspace's repository (never a branch, the index
or the working tree; decision 6), named by the pull request's repository and fetched-and-resolved one
at a time per repository (its git common dir, so linked worktrees share the queue): two views fetching
`a/x#7` and `b/x#7` at once otherwise read each other's commits. GitHub is read and written with
`gh api graphql --input -` (the JSON body on stdin, so a mutation's `input` keeps its types; `-F` would
send strings) on the **bb server's Mac**, where `gh` is signed in (decision 8); a remote workspace still
fetches on its own machine.

Review threads are mirrored into the session on every load by GitHub id (`github_thread_id`; GitHub's
comments are `github_comment_id` rows, shown as `github`, never editable here). A `FILE` thread is a
whole-file one. A thread GitHub marks outdated, or with no current line, keeps its original lines and
the text it was made on, from its first comment's `diffHunk`, so it is placed by that text or listed as
not on the current diff; it is never pinned to whatever sits at its old line now. A mirror GitHub no
longer has is deleted, unless it holds the plugin's own comments, which unlinks it instead. The user's
reply, resolve or reopen on a mirror goes to GitHub, then reads it back; dismiss has no GitHub meaning.
A reply that mentions `@reviewer` or `@agent` is the exception: it stays the plugin's own comment and
asks the reviewer, since on GitHub it would notify the accounts of those names (the sync keeps a
mirror's own comments). The Submit dialog draws every row from the plan it read, each entry with its
`location`, never from the tab's threads, which may lag behind it: whatever Submit posts is on screen.

**Submit** is the only path that posts a review (decision 5); an agent's `reply` on a mirror stays in
the tab.
- It posts exactly what the dialog showed: the plan carries each comment's text, the dialog sends it
  back, and a comment changed since is refused before anything is posted. The dialog fixes the head
  when it opens and sends that one; a load of new commits while it is open closes it (and the
  verdict is chosen again on the next opening), so an approval is never carried to a commit it was
  not made on.
- It checks the pull request's head before the first request and again just before the last (the
  submit), deleting the pending review on a push. One request's time between that read and GitHub
  taking the submit is the race left.
- It deletes nothing. A line comment becomes the mirror of the thread it made: GitHub's copy of its
  first comment takes that comment's place when unedited, and its replies, an agent's answers and
  anything written during the submission stay, unposted. A whole-file or whole-diff comment, now in the
  review's body, is resolved.

An AI run's comments on a pull request are checked against its fetched range (`PullRequests.filesFor`,
the view's last load or a fresh fetch). A fix run for a pull request starts in a new managed worktree
told to `gh pr checkout`.

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
  added `review_threads.file_revision` at 13 and `runs.purpose` at 14; 0.4.0 added
  `review_threads.github_thread_id` at 15 and `review_comments.github_comment_id` at 16. `docs.test.ts`
  keeps the README's install range on the package's minor version.
- The tab's kept state (drafts, file and thread folds, scroll) lives in the plugin's database, keyed by bb thread and
  session, not in `localStorage`: it must survive a restart and follow the user to another device (the
  owner uses bb remotely). Saves are debounced and flushed when the tab unmounts or the page hides; a
  copy per window wins over the server's when it is newer (`savedAt`), so a remount never loses to a
  save in flight; the server keeps an older copy from out of order (by `savedAt`). `getReview` drops
  reply and edit drafts whose thread or comment is gone. A draft is never hidden: a file with one
  opens, the comment filter shows it, a line draft whose lines left the diff sits above the diff, and
  drafts on files no longer in the view are listed apart. Reopening an editor keeps its draft.
- Patches loaded on demand land only on the session and load that asked for them.
- Where a line thread is drawn (at its line, or under *Not on the current diff*) depends on its file's
  patch, and bb sends most patches only on demand (all 79 files of a real branch view came without
  one). So `getReview` sends the patches of files with a line thread (`withThreadPatches`, up to
  `THREAD_PATCH_MAX_FILES`), and the tab asks at once, wherever the file is, for any commented file
  still without one (a thread an AI review added since). Without that, threads moved to the top as
  files were scrolled into view, and next/previous stepped to places that changed under them. A step to
  a thread whose file's patch is still loading waits for it and lands where the thread turns out to be.
- Scroll the tab's own area only (`app/scroll-within.ts`), never `scrollIntoView`: it scrolls every
  ancestor that can scroll, bb's clipping containers included, and pushed the tab's toolbar out of
  sight in a real panel (the Chromium test shows it). A place it scrolls to is held while the layout
  settles (`holdWithin`): lazily loaded files keep drawing around it, and Chromium's own scroll
  anchoring picks a node inside the file above when that file is partly in view, so its diff drawing
  pushed a comment just stepped to out of sight. The hold ends when the user scrolls, clicks or types
  in the area, when another scroll starts one, or once nothing has moved the place for a few seconds;
  the scroll memory's restore is the same kind of hold, so a step right after the tab opens wins.
- Updates land in place. Pierre redraws a file's whole diff whenever its `lineAnnotations` array is a
  new object, so unchanged threads, runs and files keep their objects across a refresh or reload
  (`shareById`, `mergeView`, `groupByFile`, and `NO_THREADS` rather than a fresh `[]`), and a reply
  redraws only its own file. A reload keeps a patch that was loaded on demand (an `auto` file's too:
  bb sends some of those up front, not all) on screen while it is fetched again (`stalePatches`). The patch loader resets during render, not in an effect: an effect ran after the
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

https://github.com/gpambrozio/bb-plugins/issues/64 (which merged #47 and #48) is done.

- Not taken: bb's tagged live reads in place of the realtime channel (no user-visible gain), and
  diffity's chaptered guide (the Community `guided-review` plugin covers it).
