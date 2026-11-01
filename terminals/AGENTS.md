# AGENTS.md

A bb plugin that adds a **Terminals** sidebar page: tabs of shells on any machine connected to bb,
each in that machine's home folder, with no project. It is not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `terminals`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the RPCs to `bb.sdk.terminals`, `bb.sdk.hosts` and `bb.storage.kv`, and runs the once-per-load prune of ended tabs. |
| `server/service.ts` | The tab list and the sessions behind it, over injected ports: open (and end the shell if its tab cannot be saved), close (and keep the tab if its running shell could not be ended), list with each shell's status, prune. Every read-modify-write of the list is serialized. |
| `shared/tabs.ts` | The stored tab, its status, the realtime channel, the tab limit, tab labels. No SDK import, so the app may use it. |
| `shared/host-choice.ts` | Which machines "+" offers (connected and active, the server's own first) and whether it asks. No SDK import. |
| `shared/contract.ts` | The app ⇄ server RPC contract. The app imports it as a type only (`app/imports.test.ts`). |
| `app.tsx` | The nav panel, and an invisible app overlay whose unmount (bb reloading or disabling the plugin) releases this copy's terminals and sockets. |
| `app/terminals-page.tsx` | The page: tab strip, "+" and its machine menu, the shown terminal, the offline and ended notices, the empty state. |
| `app/live-terminals.ts` | One xterm instance and one connection per open tab, in module scope for the life of the window, so leaving the page keeps them. Re-parents the element on return and restores the scrolled-to line. |
| `app/connection.ts` | One tab's line to bb's terminal socket: replay and resume by sequence number, acknowledgement after drawing, heartbeat, reconnect, when to stop. No React, no xterm. |
| `app/selection.ts` | Which tab this window shows, and where the selection goes when a tab closes; kept in localStorage. |
| `app/theme.ts` | The terminal's colours and font from bb's CSS variables, the ones bb's own terminal reads. |

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

**Terminals outlive the page, not the window.** `app/live-terminals.ts` keeps each tab's xterm and
socket in module scope; the page only lends them an element. That is what keeps scrollback, scroll
position and a running TUI exactly as they were across page switches, without a replay. A tab no
longer in the list is disposed (`releaseClosedTerminals`). An app reload starts empty: each tab
reattaches with `sinceSeq=0` and bb replays at most its last 512 KB.

**The tab list is the user's, the selection the window's.** Tabs live in `bb.storage.kv` and every
change publishes `tabs-changed`, so every client shows the same tabs; the page refetches on that signal
and after its realtime link reconnects. The shown tab is per window, in localStorage.

**Lifecycle.** Closing a tab ends its shell with `terminals.close({ mode: "force" })` *before* removing
the tab, so a failure leaves the tab to try again rather than an orphan; closing a session bb says has
already ended (or no longer knows) just removes the tab. A shell whose tab could not be saved is ended.
On every load the server drops the tabs whose shell has ended. From bb 0.48.1's server source (not
exercised live): a bb server restart reattaches the shells of a host daemon that kept running, and a
daemon that restarted (a reboot, bb quit on that machine) has its shells ended. Removing the plugin
does not end shells — `bb.onDispose` also runs on a reload, which must keep them. `MAX_TABS` (24)
bounds what a stuck "+" can start.

**Security.** A shell is the user's own account on that machine, so nothing here widens access: the
RPCs and the socket are bb's authenticated ones, `open` takes only a connected machine's id, no port
is opened, and storage and the log hold tab metadata only — never output, keystrokes or credentials.

## Checking it by hand

The tests cannot reach bb's socket. Against a running bb, one local shell is enough: create it with
`bb terminal create --machine <server machine>` and drive `app/connection.ts` from Node at
`ws://127.0.0.1:<port>/ws/terminals/<id>` (a Node socket sends no `Origin`, which bb accepts), then
close it. Never open sessions on someone else's machines to test.
