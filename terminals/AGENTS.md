# AGENTS.md

A bb plugin that adds a **Terminals** sidebar page: tabs of shells on any machine connected to bb,
each in that machine's home folder, with no project. It is not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `terminals`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the RPCs to `bb.sdk.terminals`, `bb.sdk.hosts` and `bb.storage.kv`, and runs the once-per-load prune of ended tabs. |
| `server/service.ts` | The tab list and the sessions behind it, over injected ports: open (store the tab, then make its shell under the tab's id), close (and keep the tab if its running shell could not be ended), list with each shell's status, prune. Every read-modify-write of the list is serialized. |
| `shared/tabs.ts` | The stored tab (with the user's name for it, null for the default title), its status, the realtime channel, the tab and name limits, name normalising, tab labels. No SDK import, so the app may use it. |
| `shared/host-choice.ts` | Which machines "+" offers (connected and active, the server's own first) and whether it asks. No SDK import. |
| `shared/contract.ts` | The app ⇄ server RPC contract. The app imports it as a type only (`app/imports.test.ts`). |
| `app.tsx` | The nav panel; an invisible app overlay whose unmount (bb reloading or disabling the plugin) releases this copy's terminals and sockets; and the chat-delivery overlay. |
| `app/terminals-page.tsx` | The page: tab strip, "+" and its machine menu, renaming in place (double click, F2, the tab's context menu), the shown terminal, the offline and ended notices, the empty state. |
| `app/live-terminals.ts` | One xterm instance and one connection per open tab, in module scope for the life of the window, so leaving the page keeps them. Re-parents the element on return and restores the scrolled-to line. |
| `app/connection.ts` | One tab's line to bb's terminal socket: replay and resume by sequence number, acknowledgement after drawing, heartbeat, reconnect (also after a failed or silent attach), the output an exited shell left, when to stop. No React, no xterm. |
| `app/sizing.ts` | Which window sizes a shell several windows show, and drawing every window at the shell's real size. |
| `app/selection.ts` | Which tab this window shows, and where the selection goes when a tab closes; kept in localStorage. |
| `app/theme.ts` | The terminal's colours and font from bb's CSS variables, the ones bb's own terminal reads. |
| `app/terminal-selection.tsx` | A selection the user makes: the floating "Add to chat" button (bb's placement and classes) and copy on select with bb's toasts. |
| `app/copy-on-select.ts` | bb's own "Copy on select" setting, read through `useSdk().system.config()`. |
| `app/add-to-chat-dialog.tsx` | The thread picker: open threads (searchable, most recent first) and "New thread" with its project. |
| `app/chat-text.ts` | The fenced block "Add to chat" writes, and adding it to a draft. |
| `app/project-match.ts` | The shell's directory from OSC 7, the project whose checkout holds it, and the default project. |
| `app/chat-delivery.tsx` | The block on its way to a composer, and the overlay that writes it once that composer is on screen. |

`npm test` runs everything. Nothing in it opens a shell or a socket: the connection runs against a
scripted socket and a manual clock, the server against the SDK's fake host with stubbed terminals,
and the page (`app/terminals-page.test.tsx`) against fake RPCs with `app/live-terminals.ts` mocked,
since xterm needs a real layout.

## Decisions

**bb's terminals, drawn by the plugin.** bb has a public terminal API — `bb.sdk.terminals` with a
`host_path` scope, where `cwd: null` is the machine's home folder — and the shells it makes are
persistent PTYs in each machine's host daemon, buffered by bb. That is the whole back end here; the
plugin runs no PTY of its own and needs no `bb.host` entry. What bb does not offer a plugin is a
terminal *view*: `experimental_openTerminal` shows a terminal only in the App panel beside a page,
whose tab strip and "+" are bb's (no machine choice), and the SDK exports no terminal component. So
the page draws its own, as the Wterm Terminal Preview plugin does: xterm.js (MIT; the emulator bb
itself uses) as a dependency, nothing copied from Wterm.

**The stream is bb's own terminal socket, not an SDK call.** `/ws/terminals/<id>?sinceSeq=&outputAcks=1`
on the page's origin is what bb's terminal panel and Wterm use; it is not in the SDK's typings, so a bb
release may change it. `app/connection.ts` documents the protocol as bb 0.48.1 speaks it and parses
defensively (an unknown message is ignored). The alternative, `terminals.output`/`input` over the SDK,
polls: a round trip between a keystroke and its echo. If a bb release breaks the socket, a terminal
stays "offline" retrying, and the shells are unharmed.

**Acknowledged as drawn.** With `outputAcks=1`, bb paces a shell's output to the acknowledgements of
its visible clients, as a real terminal's PTY back-pressure does; a client that has not acknowledged
for 3 s stops governing, and a hidden one never does (bb 0.48.1, `TerminalOutputFlowControl`). The
connection acknowledges each chunk once xterm has parsed it, which keeps happening while the page is
away, and never reports itself hidden. A window that stops processing (a throttled background browser
tab) can hold a printing program back for those 3 s at most.

**The window in use sizes the shell.** bb 0.48.1 takes a socket `resize` only from the socket that
attached last and drops the rest silently, and a tab's socket here stays attached while its page is
away — so a second window would hold the size for good. The socket never resizes: the window that
shows the tab and is shown, resized, focused or typed in asks `terminals.resize` (any client may), and
every window draws the shell at the size bb reports in `session-updated` (`app/sizing.ts`). A window not
in use never asks, so two windows cannot fight; the last one used wins.

**Terminals outlive the page, not the window.** `app/live-terminals.ts` keeps each tab's xterm and
socket in module scope; the page only lends them an element. That is what keeps scrollback, scroll
position and a running TUI exactly as they were across page switches, without a replay. A tab no
longer in the list is disposed (`releaseClosedTerminals`). An app reload starts empty: each tab
reattaches with `sinceSeq=0` and bb replays at most its last 512 KB. bb replays nothing for a shell
that has already exited, so an ended tab reads what bb kept (30 minutes, `terminals.output` through
the app's `useSdk()`) from the first sequence it has not drawn, then says it ended.

**The tab list is the user's, the selection the window's.** Tabs live in `bb.storage.kv` and every
change publishes `tabs-changed`, so every client shows the same tabs; the page refetches on that signal
and after its realtime link reconnects. The shown tab is per window, in localStorage.

**Names live with the tabs.** A tab's name is stored in the same kv list as the tab, normalised on
the server (trimmed, whitespace collapsed, at most 80 characters, empty → null), so every client
shows it and it survives reloads. The default title is computed in the app from the machine's name
and the tab's position among that machine's tabs; a named tab keeps its position, so clearing the
name brings back the title it had, and saving the default title untouched sends nothing. Renaming
also sets bb's own terminal title, best-effort: the tab's name is what counts.

**Lifecycle.** A tab is stored *before* its shell exists: `open` picks the terminal id itself
(`terminals.create` takes one, `server/terminal-id.ts`), saves the tab under the limit check in the
serialized section, then asks bb for the shell. So no shell ever runs without a tab — a reload or
disable while bb is still opening one leaves a tab the next copy sees — and two clients pressing "+"
at once cannot pass `MAX_TABS`. Until bb has the session, `list` calls the tab `opening` (for
`OPENING_GRACE_MS`, after which it is `ended`), and bb's own `starting` follows while the machine opens
the shell. The page treats both as pending (`isPending`): it draws a placeholder and polls rather than
attach, which would hear "not found" or "not running"; and a connection that meets `starting` anyway
(bb answers `attached` then `terminal_not_running`) backs off and tries again instead of ending. If bb cannot start the shell the tab is dropped again. A tab
closed before bb has a session for it leaves a record in kv (`closing`, `ClosingSchema`), because the
shell may still be on its way and the copy of the plugin that asked for it may be reloaded first: the
background service of whichever copy is loaded checks every few seconds while there is one, ends the
shell once bb has it, and forgets the record once the shell has ended or `OPENING_GRACE_MS` has passed
with no session (bb inserts its row before asking the host, so by then it never made one).
Closing a tab ends its shell with `terminals.close({ mode: "force" })` *before* removing the tab, so a
failure leaves the tab to try again rather than an orphan; closing a session bb says has already ended
(or no longer knows) just removes the tab. On every load the server drops the tabs whose shell has ended. From bb 0.48.1's server source (not
exercised live): a bb server restart reattaches the shells of a host daemon that kept running, and a
daemon that restarted (a reboot, bb quit on that machine) has its shells ended. Removing the plugin
does not end shells — `bb.onDispose` also runs on a reload, which must keep them. `MAX_TABS` (24)
bounds what a stuck "+" can start.

**Security.** A shell is the user's own account on that machine, so nothing here widens access: the
RPCs and the socket are bb's authenticated ones, `open` takes only a connected machine's id, no port
is opened, and storage and the log hold tab metadata only — never output, keystrokes or credentials. A
selection sent with "Add to chat" stays in the window's memory until the chat's composer takes it; it
is never stored or sent for the user.

**Selections behave as in bb's terminal.** bb 0.48.1's `ThreadTerminalView` was read from its bundle
and matched: on the release of a left press that started in the terminal, a frame later, the
selection is read; a non-empty one shows "Add to chat" at the pointer (below it after a drag
downwards of more than 4 px, above otherwise, 6 px off, kept 8 px inside the view), and is copied with
`toast.success("Selection copied")` / `toast.error("Failed to copy selection")` when the setting is
on. The same text is not copied twice in a row. Nothing happens on xterm's own `onSelectionChange`
(output, programs, the terminal clearing it) except taking the button away when the selection is
gone; a scroll or a window resize takes it away too, as bb's does.

**Copy on select is bb's setting, polled.** `useSdk().system.config()` carries
`generalSettings.terminalCopyOnSelect` (default true), but nothing tells a plugin it changed, so the
page reads it on mount, on window focus, after a realtime reconnect and on each press in the terminal
(at most every 2 s); the release waits for the read its press started. There is no plugin setting of
its own: it would only disagree with bb's.

**"Add to chat" fills a composer, never sends.** The SDK writes only into composers on screen
(`useComposers()`), and the Terminals page shows none. So the page leaves the block in
`windowDeliveries`, opens the thread (`toThread`) or the New thread screen (`toCompose` with the
project), and the `chat-delivery` app overlay — mounted once per window, so it outlives the page —
appends the block to that composer's draft (`replace`, keeping text, mentions and attachments, as
bb's own "Add to chat" appends its quote) and focuses it. It looks on each render and polls every
100 ms, because a composer's scope can change in place; the SDK test harness keeps the same handle
list across `setComposerScope`, which is how that was found. After 15 s the block goes to the
clipboard with an error toast instead.

**The new thread's project.** The shell's directory comes from OSC 7 (`file://host/path`), which many
shells send on each prompt; the tab's `initialCwd` is always the home folder. The deepest project
checkout (`projects.list` sources) or thread worktree (sidebar threads' environments) holding it on
the tab's machine wins; else the project last picked here (localStorage), else the most recent
thread's.

## Checking it by hand

The tests cannot reach bb's socket. Against a running bb, one local shell is enough: create it with
`bb terminal create --machine <server machine>` and drive `app/connection.ts` from Node at
`ws://127.0.0.1:<port>/ws/terminals/<id>` (a Node socket sends no `Origin`, which bb accepts), then
close it. Never open sessions on someone else's machines to test.
