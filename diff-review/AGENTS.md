# AGENTS.md

A bb plugin that adds a **Review** tab beside each thread: the thread's workspace diff, drawn with the
`@pierre/diffs` bb provides, with comment threads on lines, ranges, files and the whole diff, stored in
the plugin's own SQLite, and **Send to agent**, which puts the open ones in the thread's chat (or a new
thread's). The agent answers each one with `bb diff-review reply|resolve|dismiss` or the
`diff_review_*` tools, and the tab updates live. **AI runs** — an AI review, an answer to an
`@claude`/`@codex`/`@opencode` mention, fixes in a new thread — each run in a visible thread of their
own in the reviewed workspace.
It is a bb take on [diffity](https://github.com/nilbuild/diffity)'s review loop, not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `diff-review`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the settings, the database and its migrations, the RPCs, the CLI and the `thread.idle` / `thread.failed` listeners. |
| `server/review.ts` | `ReviewService`: everything the tab, the CLI and the thread events do to reviews — the view, threads and comments, sends, the agent's answers and who may give them, closing out a send after a turn. |
| `server/store.ts` | The SQLite tables (sessions, threads, comments, sends), their append-only `MIGRATIONS`, and every query. |
| `server/diff.ts` | The workspace a thread runs in, its refs (base branch, the branch's commits), and the diff from `bb.sdk.environments.diffFiles` / `diffPatch`, minus ignored files. |
| `server/ignore.ts` | Gitignore-style ignore patterns, from the setting and the workspace's diffity ignore files. |
| `server/prompt.ts` | The "Address review comments" message a send puts in the thread (adapted from diffity's prompts, MIT). |
| `server/cli.ts` | `bb diff-review list|reply|resolve|dismiss|comment`; base64 text through `--text-base64-stdin`. |
| `server/runs.ts` | `RunService`: AI runs — the pickers' defaults, starting a review, a mention's answer or a fix thread, a run's end (summary, files changed during a review), Close (archive), and a review run's comments, checked against the diff. |
| `server/run-prompts.ts` | The first message of each run's thread (adapted from diffity's `review.md` and `thread.md`, MIT). |
| `server/tools.ts`, `server/tool-names.ts` | The `diff_review_*` agent tools; their names and the run-id metadata key `configure` reads. |
| `shared/mentions.ts` | Which `@claude`, `@codex`, `@opencode` count (outside code; ported from diffity) and the provider each starts. |
| `shared/types.ts` | The data model and zod schemas, the realtime channel and its signals. No SDK import, so the app may use it at run time. |
| `shared/contract.ts` | The RPC contract. Imports the SDK root, so the app imports it as a type only. |
| `shared/patch-lines.ts`, `shared/anchors.ts` | A patch's lines by side and number, and where a thread belongs in the current diff (anchored, moved, outdated). |
| `app/review-panel.tsx` | The tab: the view picker, split/unified, *Only files with comments* (remembered in `localStorage` like split/unified), reload, whole-diff comments, the *Not on the current diff* list, the files, the send dialog. |
| `app/file-diff.tsx` | One file: its header (with its thread count while the switch is off), whole-file threads, and Pierre's `PatchDiff` with thread annotations and the gutter "+". |
| `app/patch-loader.ts` | Patches bb did not send with the file list, asked for as files come near the screen and fetched in batches, one request at a time. |
| `app/header-action.tsx` | The Review button in the thread's title bar (`experimental_threadHeaderAction`), which opens the tab. |
| `app/thread-card.tsx`, `app/comment-composer.tsx` | A thread and its comments; the box comments are written in. |
| `app/send-dialog.tsx` | Picking threads and a note for **Send to agent**, to this thread or a new one. |
| `app/ai-review-dialog.tsx`, `app/execution-picker.tsx` | The AI review dialog (focus chips, instructions); bb's provider/model picker, seeded from the settings. |
| `app/runs-list.tsx` | The session's runs under the toolbar: status, files a review changed, Open thread, Close. |
| `app/use-review.ts`, `app/actions.tsx` | The tab's data (RPC + realtime) and the thread actions every card shares. |
| `skills/diff-review/SKILL.md` | What an agent needs to answer: the commands, base64 through stdin, how to write answers. |

`npm test` runs everything. The server tests drive `server.ts` on the SDK's fake plugin host with a
real temporary SQLite; the app tests render the tab with a stand-in for `@pierre/diffs/react`, since
jsdom cannot run its highlighter.

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
Review tab started the run (for a mention, the tab the comment was written in), and only while it
still works in the reviewed workspace; otherwise the run starts at the root. They are never hidden
(the owner watches, steers and approves there, and hidden helpers bring the reload problems of issue
#11). They run in the `aiPermissionMode` setting's mode, **`auto` ("Approve for me") by default**:
`accept-edits` asked the owner to approve most of a review's commands. The provider and model come
from the per-run picker, seeded from the settings (Claude Code unless changed); a mention runs the
mentioned agent at its default model and reasoning.

**A child reports to its parent, and that must not turn into work.** bb posts every finished turn of
a child to its parent (`[bb system] @thread:<child> completed: <its final message>`, and a
"needs help" notice when a child waits on an approval), which wakes the parent's agent. Three things
keep the parent from taking a report for a request: every run prompt makes the final message open with
`REPORT_LINE` ("Diff Review status report — no action needed…"), which works on a session already
running; `contributeInstructions` tells a thread with run children (`runs.parent_thread_id`) what the
notices are, from its next session; and the skill says the same. Nothing can loop: the plugin sends
nothing to the parent when a run ends, agents cannot start runs (only the tab's buttons and a
*user's* @-mention do; an agent's comment never triggers a mention), and the parent's agent can only
answer threads already sent to it. A notice still costs the parent a short turn. A run's row is written before its thread is
spawned, so a thread bb refuses leaves a *failed* run that says why. **Close** archives the thread.
A run ends on its thread's `thread.idle` / `thread.failed`, keeping the agent's last message as the
summary; it is never parsed for answers.

**A review run cannot be read-only, so it is watched.** bb has no tool-free thread. The review prompt
says not to edit; the workspace's uncommitted changes are fingerprinted (each file's change kind, line
counts and patch hash) when the run starts and when it ends, and every file that differs is listed on
the run. Another thread editing the same workspace meanwhile shows up there too, which the tab says.

**Mention and fix runs are sends.** They record a send to the run's thread in the same ledger, so the
agent's answers go through the same check as the thread under review's: only the thread a comment
thread was last sent to may answer it. A later mention of the same agent in the same comment thread
goes to the same run thread (`threads.send`), not a new one. A review run may also act on every thread
of the session it reviews, and only a review run may open new threads (`comment`), each checked to
lie on lines the current diff shows; a refusal lists the lines that are (diffity's `add_comment`
checks).

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
line-click hooks (still none in bb 0.47), so the tab renders `PatchDiff` from the host-shimmed
`@pierre/diffs` (a type-only devDependency at the host's version). bb's shim passes options through
unchanged, so the plugin sets `theme` and `themeType` from `experimental_useCodeTheme()` itself.

**Which machine.** Phase 1 has no server-Mac-only part: diffs come from `bb.sdk.environments.*` and
the ignore files from `bb.sdk.files.read` on the environment's host, both of which run on whichever
machine holds the workspace, remote hosts included. What needs raw git — staged against unstaged,
arbitrary `a..b` ranges, a pull request's head — will run on the **bb server's Mac only** until phase 4
adds a `bb.host` git entry (decision 8 of the plan). Say so in each feature that adds raw git.

**Diffs load without a tap.** bb's `diffFiles` may send no patches up front (it sent none for a
42-file working tree), so every file without one asks for it when it comes within a screen of the
tab's scroll area; the asks are batched (25 paths, one request at a time). Only a change of more than
2,000 lines starts folded, and it loads when unfolded; binary and too-large files say why they have no
line diff. Never put a "Load diff" button back.

**The first view is picked once.** A tab opened without a view sends `autoTarget` on its first
`getReview` only; the server answers with the branch's commits when the uncommitted view is empty and
the branch has some, and the tab's picker adopts that view without loading it again. No later load
(a reload, a realtime signal, a reconnect, the user's pick) sends it, so a choice is never overridden.

**The tab is a `threadPanelAction`.** It is the only tab surface bb 0.46 has. bb 0.47 drops it from
the SDK typings in favour of `app.slots.experimental_tab({ context: { kind: "thread" }, availability:
"action", icon, … })` and keeps loading it through an adapter, keeping saved tabs and their params.
Move to `experimental_tab` when the plugin re-pins to an SDK that has it (and raise `engines.bb`).

## Invariants

- `MIGRATIONS` is append-only; bb checks each applied statement's hash. 0.1.0 shipped indexes 0–6;
  0.2.0 added the `runs` table at 7–9 and its `parent_thread_id` at 10 (an `ALTER`, since 7 was
  already applied on installs of the branch).
- The app never imports the SDK root at run time: the contract is a type import, the schemas and the
  channel name live in `shared/types.ts`.
- `@pierre/diffs` stays a devDependency: bb provides it.
- Text from the CLI is capped at 12,000 bytes, so its base64 fits bb's one stdin line of 16 KiB.
- Nothing the agent writes is trusted as Markdown beyond what the host `Markdown` component renders.

## Roadmap

- **Phase 3:** GitHub pull request review — https://github.com/gpambrozio/bb-plugins/issues/47.
- **Phase 4:** polish (Reviews page, staged/unstaged and ranges through a host entry, find, viewed
  marks on bb 0.47's `experimental_diffViewed`, suggestions, palette commands) —
  https://github.com/gpambrozio/bb-plugins/issues/48.
