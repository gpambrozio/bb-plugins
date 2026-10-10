# AGENTS.md

A bb plugin that adds a **Screen Sharing** sidebar page: the screens of the Macs enrolled in bb, seen
and controlled through noVNC in the page, relayed by the plugin to macOS Screen Sharing on each Mac's
own `127.0.0.1:5900` — directly for the Mac running the bb server, over bb's host link for the others.
It is not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `screen-sharing`. The feasibility study behind it measured bb's channels and auth; its
findings are summarised under *Decisions*.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the RPCs (host list, per-host status, tickets, the Mac's clipboard), the relay route, host signals and worker exits, the sweep and keepalive timers and disposal. Holds the server's limits (ticket life, no-traffic, maximum length, buffer cap, pipelining). |
| `server/sessions.ts` | Tickets (single-use, bound to a Mac and its route, short-lived) and sessions (no-traffic and age limits, Close all). No sockets. |
| `server/relay.ts` | One WebSocket ⇄ one link, bytes copied untouched; the page's ack frames, and a `pong` for each `ping`; either end closing closes the other. |
| `server/link.ts` | The seam between the relay and the Mac's side: `Link`, its events and the route. |
| `server/loopback-link.ts` | The server's own Mac: a TCP connection to `127.0.0.1:5900`, paused while the page is a window behind. |
| `server/host-link.ts` | Every other Mac: pipelined, numbered `write` calls up; numbered `data` signals down, a gap ends it; acks and keepalives to the host. `HostLinks` routes signals by session and checks their host. |
| `host.ts`, `host/entry.ts` | The host entry, on every enrolled machine: `status`, `open`/`write`/`ack`/`keepalive`/`close`, and `clipboardRead`/`clipboardWrite`; a lease per session; close-all on lifecycle abort and dispose. |
| `host/pasteboard.ts` | The Mac's clipboard as UTF-8 plain text, through NSPasteboard in JXA: the change count, the text with the count it was read at, writes that answer their own count; the account it belongs to; `runCommand`, which every command goes through. Runs on each Mac, and in the server for its own. |
| `host/relay.ts` | A Mac's side of a remote session: its TCP connection, numbered chunks out, the credit window, the silence expiry. |
| `host/status.ts` | Is Screen Sharing on: `launchctl print-disabled system` and an RFB greeting probe that signs in to nothing. Runs on each Mac, and in the server for its own. |
| `shared/channels.ts` | Route, realtime channel, flow-control frames, close codes, session limits and zod shapes; no SDK import, so the app may use it. |
| `shared/contract.ts` | The app ⇄ server RPC contract. The app imports it as a type only. |
| `shared/settings.ts` | The settings form (Scroll speed), declared by the server and read only by the app; a type-only SDK import, so the app may import it. |
| `shared/host-contract.ts`, `shared/limits.ts` | The server ⇄ host contract and signals, and the numbers both ends share (port, windows, keepalive). The app imports neither. |
| `app/screen-panel.tsx` | The page: the toolbar row (the picker, then View only, Connect/Disconnect and the keys), the picked Mac's status and System Settings guidance; the title bar's right side (`SessionsHeader`: open sessions, Close all). |
| `app/hosts.ts` | The machines, their statuses and the picked Mac, outside React, so the picker, the page and other windows' visits share them. |
| `app/host-picker.tsx` | The picker at the left of the toolbar row: a dot and the picked Mac's name, opening bb's dropdown menu of every machine with its state (a sheet on a compact viewport). |
| `app/session-store.ts` | One session per Mac per window, outside React: ticket → WebSocket → noVNC into an element it owns; the input-idle disconnect; the local-cursor CSS; why it ended. `screenSessions` holds them. |
| `app/flow.ts` | The page's acknowledgements of what it received. |
| `app/liveness.ts` | The page's pings, and the session called lost when the relay stops answering with its socket still open. |
| `app/relay-channel.ts` | The socket as noVNC sees it: text frames kept out, one wheel event's messages sent as one frame. |
| `app/wheel.ts` | Scrolling as RFB wheel steps, in proportion to the distance. |
| `app/vnc-session.tsx` | The live screen on the page: lends the store's element a place while the page is open; the sign-in form. |
| `app/rfb.ts` | The seam the page's tests replace: `new WebSocket` and noVNC's `RFB` (scaling; no dot cursor; marks a cursor sent by the Mac; its own wheel handler). |
| `app/keys.ts` | The Send keys menu: each shortcut as RFB keysyms (⌘ is `Super_L`, as noVNC sends it). |
| `app/keys-toolbar.tsx` | "Full screen", "Send keys" and the notice saying what is held or locked and how to get out. |
| `app/toolbar-menu.tsx` | The shell of the toolbar's menus (Send keys, Clipboard): drawn inside the page, so they work in full screen. |
| `app/clipboard.ts` | Clipboard text between this computer and the Mac: `ClipboardSync` (one per connection; Send, Receive, Auto sync, whose account), the remembered Auto sync choice. |
| `app/clipboard-menu.tsx` | The "Clipboard" menu and the notice saying what the last clipboard action did. |
| `app/cursor.ts` | The arrow-fallback CSS and the attribute that switches it off once the Mac sends a cursor. |
| `app/sessions.tsx` | The open sessions as the app sees them; the sidebar "Live" and the corner Close all pill. |
| `app/novnc.d.ts` | Types for the part of noVNC's `RFB` used here; noVNC ships none. |

`npm test` runs everything. The tests never touch this machine's real port 5900: the relay, the host
relay and the probe run against fake TCP servers (`testing/fake-vnc.ts`), and the fake-host test
drives the loopback route only with tickets it refuses. `server/remote.test.ts` runs the real server
entry on bb's fake plugin host against a real `HostRelay` behind `testing/fake-daemon.ts`, which
delays every call and signal by a chosen one-way time; it covers every way a remote session ends and
logs `[measured]` round trips, scroll latency and throughput at 300 ms each way. `app/novnc-session.test.ts` runs the store against the real, pinned noVNC client, playing
Apple's side of an ARD sign-in over a fake relay socket; use it for anything that depends on what
noVNC really does with credentials, keys, buttons, the wheel, the cursor or the relay's text frames.

## Decisions

**Which machine: every enrolled one, two ways.** The server's own Mac (`system.config().primaryHostId`)
is reached from `server.ts` with a loopback `net.connect`, as before. Every other Mac goes through the
plugin's `bb.host` entry over bb's host link: host calls up, host signals down. `openSession` decides
which when it mints the ticket (the ticket carries the route), so the route cannot be swapped later;
a Mac that is offline or unknown gets no ticket. The study measured ≈600 ms round trips to the
MacBooks through getbb.app. A gate-shared port (`bb.hosts.declareSharedPorts`, path C in the study)
might be faster but needs a port exposed on the Mac and has open questions about the getbb.app cookie;
it is not used.

**One same-origin WebSocket route, `bb.http.experimental_websocket("/vnc", …, { auth: "local" })`.**
bb serves the app from the server's own origin (`window.location.origin` is what bb's own SDK uses for
`/api` and `/ws`), so the page opens the route as a same-origin socket: over loopback on the Mac,
through bb's getbb.app tunnel remotely. "local" auth refuses a browser on any other origin (403,
checked in the study); a request with no `Origin` header passes. Browsers always send one, so that
is a non-browser client of the bb API: a local process (which can reach port 5900 directly anyway),
or anything that can reach a bb server bound to the network with `BB_SERVER_BIND_HOST` — which can
then already drive every bb API, terminals on every host included. The relay adds no reach beyond
bb's own API. The API is experimental; `engines.bb` is `>=0.46`, for `experimental_copyToClipboard`
(see *Clipboard*).

**Who may mint a ticket.** `openSession` refuses callers bb marks `plugin` (another plugin through
`bb.sdk.plugins.callRpc`). bb marks everything else `client` — the app, the `bb` CLI, agents — and
nothing distinguishes the app, so the CLI and agents can mint tickets too. They still need the macOS
user name and password to get past Screen Sharing's sign-in, and the skill tells agents never to try.
Do not claim more than this in docs or messages.

**A session belongs to the window, not the page.** bb unmounts the page whenever the user opens
something else but keeps the plugin's app module loaded for the life of the window, so the session
(a `ScreenSessionStore` in `app/session-store.ts`) lives at module scope: the WebSocket, noVNC's
client and a `div` noVNC draws into. The page appends that `div` while open and removes it on unmount; noVNC keeps
running detached (a 0×0 target scales to 0, and its ResizeObserver rescales on reattach). Coming back
shows the same connection, already signed in. Nothing about the sign-in is kept to make this work —
the live connection is what persists. One session per Mac per window (`screenSessions.for(hostId)`);
another window has its own. Sessions to different Macs run at once: the page attaches the picked
Mac's element and the others stay detached, input suspended, exactly as when the page is closed —
`HostScreen` is keyed by host, so switching Macs is an unmount and a mount. Close all and `pagehide`
end every store. The picked Mac is `hostDirectory.picked` (`app/hosts.ts`), window state like the
sessions.

**The picker leads the toolbar row, in every state.** A dot coloured by state and the Mac's name,
truncated, with every machine's state in its menu, at the left of the row that holds View only,
Connect or Disconnect and the keys — so the row names the Mac it acts on, and no other place does.
The row is drawn while the Mac is being checked, is off, offline or not a Mac (with only the picker
in it then), so another Mac is always one click away. It wraps in a narrow window: the picker keeps the
left, the controls go right-aligned onto the next line. The menu is bb's vendored dropdown
(`components/ui/dropdown-menu.tsx`, copied from `github-board`), which portals to the page body and
becomes a sheet on a compact viewport; because a full-screen page hides anything portalled outside
it, the picker is disabled while Full screen is on. It was in the title bar (`headerContent`, a
fixed box on the bar's right) for a while; the captain preferred it under the title, where the bar
keeps only the open sessions and Close all.

While the screen is off the page its input is suspended: `detach()` first releases every key and
mouse button held over it — a real `keyup` per held key on noVNC's canvas, and a `mouseup` with no
buttons at the last pointer position — so noVNC sends the releases to the Mac, and only then turns
noVNC's `viewOnly` on; `attach()` restores the user's choice. Turning view-only on alone is not
enough: noVNC's setter sets the flag before it ungrabs the keyboard, so the key-ups the ungrab
generates are dropped as view-only input. For the same reason the user turning View only on releases
held input first, in the same order. Touch gestures (a drag, a long press) press the Mac's buttons
through noVNC's private `_handleMouseButton` with no mouse event to track, so the release also asks
noVNC itself, through `releaseRemoteButtons` in `app/rfb.ts`, to let go of any button it still has
pressed (`_mouseButtonMask` at `_mousePos`, pinned 1.7.0; the real-noVNC tests drive real gestures).

The button-up has to end noVNC's pointer capture too. A button-down makes noVNC capture the pointer:
without a native `setCapture` it puts a full-window overlay (`#noVNC_mouse_capture_elem`) over the
page, listens on `window`, and lets go only when a `mouseup` reaches that `window` listener. So while
`document.captureElement` is the store's canvas the `mouseup` is dispatched on `window` — noVNC
forwards it to the canvas, then removes the overlay — never on the canvas, which sends the release but
leaves the overlay over bb. Every teardown does this before noVNC drops its canvas (the store keeps a
reference, since noVNC removes the canvas from the page on disconnect).

**Idle is measured in the window.** noVNC asks for a screen update after every one it gets and the
menu-bar clock changes each minute, so bytes flow as long as a session is open, seen or not. The
server's 30-minute limit therefore only catches clients that went away (no traffic at all); the store
ends a session after 30 minutes without a key, click, touch, wheel or pointer movement on its element
— which an unseen, detached screen never gets.

**The pointer.** noVNC sets its canvas's CSS cursor to `none` until the server sends a cursor shape
(Cursor or VMware cursor pseudo-encoding), and macOS Screen Sharing sends none it can draw (noVNC
issue #1430), so the pointer vanished over the screen. `LOCAL_CURSOR_CSS` shows the ordinary arrow
while the canvas says `cursor: none` and the Mac has sent no cursor yet — the local pointer is exactly
where a click lands. noVNC also says `none` for an empty cursor the server sends on purpose (how a
server hides its pointer), and raises no event for either, so `createRfb` wraps noVNC's private
`_updateCursor` (both cursor encodings call it in the pinned 1.7.0) to set `data-remote-cursor` on the
screen element; from then on the rule stands aside and the cursor is shown as sent. The attribute is
cleared for each new connection. `app/novnc-session.test.ts` sends real Cursor rectangles, so a noVNC
that renames `_updateCursor` fails there. `showDotCursor` stays off: it replaces noVNC's empty
start-up cursor with a 3×3 dot, which a desktop browser shows as a `url()` cursor, so the arrow rule
would never match.

**Never expose a port.** No `bb connect expose`, no `declareSharedPorts`, no listening socket. The
gate carries only HTTP and WebSockets, so raw VNC could not cross it anyway, and an exposed share
would be one more door to a Mac's screen.

**The page opens the WebSocket itself and hands it to noVNC** (`new RFB(target, channel)`), so it can
read the close code and say why a session ended; noVNC reports only clean or not. No subprotocol is
requested. The page also listens on that socket beside noVNC to acknowledge what arrives (see *Flow
control*) and to ping the relay (see *A socket can outlive bb*). noVNC sends only binary frames, so
text frames on the route are the page's acks and pings, and the relay's pongs. noVNC reads every
frame it gets as RFB bytes (`new Uint8Array(data)`: a `pong` comes out empty and is ignored, which is
luck, not design), so it gets the socket through `RelayChannel` (`app/relay-channel.ts`), which
passes it binary frames only.

**A socket can outlive bb.** Restarting bb on the server's Mac while the owner watched through
getbb.app left the page saying "connected": the browser's end of the socket stays open when the server
behind the tunnel goes away, and no close event comes, so nothing told noVNC or the store. The page now
sends `ping` every `PING_EVERY_MS` (2 s), the relay answers `pong` at once, and the store ends the
session with `LOST_MESSAGE` when a ping has had no answer, and nothing else has arrived either, for
`LOST_AFTER_MS` (6 s) — so within about 8 s. Any frame counts as an answer, so a pong stuck behind a
big screen update is no false alarm. The wait is counted in ticks, and a late tick decides nothing: a
browser holds back a busy, hidden or suspended page's timers, and on resume the late tick may run
before the pong that arrived meanwhile is handled. So a tick more than 1.5 intervals after the one
before (or after the clock went back) starts the wait afresh, and the session ends only after 6 s of
ticks on time with nothing heard; a tick a little late counts as one interval (review passes 1 and 2
found a late first, then a late final, tick ending a session whose pong was waiting). The cost: a tab
whose every tick is held back (Chrome's one-a-minute throttling of hidden tabs) never ends a dead
session while hidden — it does within seconds of being shown again. A ping is traffic for the server's 30-minute no-traffic limit, which
already only catches clients that went away. There is no reconnect: the session's sign-in is gone with
it, and Connect starts again.

**Scrolling.** RFB has no scroll distance, only steps (buttons 4–7 pressed and released), and noVNC
1.7.0 sends at most one step per browser wheel event, once 50 px have gathered, and drops the rest:
a flick or a wheel notch was one step, a trackpad one step per 50 px. `createRfb` puts its own wheel
listener on the screen element, in the capture phase so noVNC's on the canvas never sees the event,
and sends `speed` steps per `WHEEL_STEP_PX` (12 px) of scrolling with the remainder kept, at most
`maxWheelSteps(speed)` per event (80 at the default), through noVNC's private `_handleMouseButton`
like `releaseRemoteButtons`. `speed` is the "Scroll speed" setting (1–5, `shared/settings.ts`,
default 3), so the default is a step per 4 px. The owner tuned it on the server's own Mac, where
there is no link delay: one step per line (20 px) moved the Mac far too little, three per line was
still short, and five per line felt right — that is the default now, with 1–5 spread around it in
proportion. The page (`ScreenMount`) reads it with
`useSettings()` and hands it to the store, and the wheel handler reads it on every event, so a
change applies to an open session. One event's steps go to the relay as one frame
(`RelayChannel.gather`), so a scroll is one host call per event. A trackpad pinch arrives as wheel
events with `ctrlKey` set and no key event (Chromium's `touchpad_pinch_event_queue.cc`); the handler
drops it — no step, nothing gathered, kept from noVNC and from the browser's zoom — unless noVNC has
Control down on the Mac (`_keyboard._keyDownList`, pinned 1.7.0), when it scrolls with Control held
there. noVNC's own list decides because noVNC releases every key on window blur without a DOM key-up;
a tracker of the page's key events stayed "down" and let a pinch after blur scroll (review pass 2).

**One display picture.** A Mac with several displays sends noVNC one framebuffer; picking a display is
Apple's private extension to its own Screen Sharing app. Apple documents nothing for third-party
viewers and the plugin was not tried on a multi-display Mac. Do not add display selection without
seeing what such a Mac sends (ServerInit size, any ExtendedDesktopSize screen list).

**View only is noVNC's `viewOnly`, set in the page.** The relay does not parse RFB to enforce it; the
user is the one viewing.

## Clipboard

Text only, any characters. **Not through the screen session:** the page asks the plugin's server
(`clipboardRead`, `clipboardWrite`), which runs `host/pasteboard.ts` itself for its own Mac and calls the
host entry for the others. `app/clipboard.ts` holds the page's side, one `ClipboardSync` per connection.

- **Why not RFB.** 0.3.0's first candidate used RFB cut text through noVNC (`clipboardPasteFrom`, the
  `clipboard` event). On the MacMini, signed in as the console account, nothing crossed either way:
  macOS sent no ServerCutText and ignored ClientCutText. remotex, an open-source viewer that
  reverse-engineered Apple's protocol, says the same in `src/vnc_apple_clipboard.rs` ("macOS does not
  bridge its pasteboard through RFB Client/ServerCutText, even after accepting the Extended Clipboard
  pseudo-encoding") and documents Apple's own pasteboard messages in `docs/apple-vnc-889.md`:
  `AutoPasteboard` (`0x15`) after `ViewerInfo` and `SetMode(control)`, `MiscStatus` (`0x14`) command 2
  when the Mac's pasteboard changes, a fetch (`0x0b`), and `0x1f` carrying a zlib archive of every
  flavor (`public.utf8-plain-text` among them) both ways. Apple's viewer and remotex speak them only
  in RFB `003.889`, Apple's private revision, with ClientInit `0x81` and Apple's extended ServerInit;
  noVNC answers `003.008`, and 003.889 also changes the pointer buttons and the wheel. Making noVNC
  speak it would mean faking the version, parsing Apple's ServerInit and server messages through
  noVNC's private message loop, and remapping input — unverifiable without a live session, and a
  macOS update is free to change any of it. Nobody has tried Apple's messages in a 3.8 session.
- **Plain text through NSPasteboard, not `pbpaste`/`pbcopy`** (review pass 1). Those two pick formats
  for you: `pbcopy` writes text that starts like RTF or EPS as that format, and `pbpaste` falls back to
  RTF or EPS when there is no plain text (`man pbcopy`). And a `pbcopy` followed by a separate count
  query can pair the count of someone else's copy with the text just written, so a poll would skip
  that copy. The JXA scripts read and write `public.utf8-plain-text` only (a picture reads as no
  text); a read samples the count before and after the text and tries again if it moved; a write
  answers the count `clearContents` returned for it, and fails if another copy took the pasteboard
  before its text was set. Text crosses as UTF-8 on stdin/stdout, never the locale or argv. Checked
  on the MacMini against a private named pasteboard (`macPasteboardCommandsFor(name)`), never the
  clipboard: literal RTF source and full Unicode round-trip as plain text, the counts match, and an
  EPS-only pasteboard reads as no text. Tests use `testing/fake-pasteboard.ts`.
- **`runCommand`** settles once on exit, spawn error, stdin error (EPIPE: a child that exits before
  reading 1 MiB of input), timeout and output limit, and kills the child on every failure. A bare
  `spawn` with only a child `error` listener let an EPIPE on stdin escape as an uncaught exception,
  in the bb server's own process for its own Mac (review pass 1). Its tests run Node children only.
- **Whose clipboard.** The scripts act on the pasteboard of the login session they run in:
  the account bb runs as on that Mac (`ci` on the MacMini). A Screen Sharing sign-in as another account
  that is not at the console opens that account's own desktop, with its own pasteboard, which only root
  could reach (`launchctl asuser`); bb runs as a non-admin there. So each read and write answers the
  account (`id -F` for the full name), the page compares it with the user name typed at sign-in (short
  or full name, any case). The store keeps that user name — never the password — for the session only.
- **When sync cannot work** — a sign-in as another account, or a Mac whose clipboard could not be
  reached (the first `clipboardRead` failed, or any later call did) — the session's `clipboardAccess` says why, and
  the Clipboard menu holds only that reason, one step up the type scale (`text-sm` where its notes are
  `text-xs`), with none of its items; nothing syncs. Opening the menu asks an unreachable Mac again;
  after a failed call that probe reads the text, not only the count, since the count alone does not
  show the text can be read (review pass 1).
  The captain's choice: a menu of items that can only fail is worse than one sentence saying why.
- **The Mac's changes.** `NSPasteboard.changeCount` through `osascript -l JavaScript`, about 40 ms. The
  page reads it once a second (`MAC_POLL_MS`) while Auto sync is on, the screen is on the page and the
  page is not hidden (another tab, a minimised window), and once more as the screen leaves the page;
  the text is read only when the count moved, and an answer that comes back after the page was hidden
  or the screen went is dropped (the next poll asks again). A remote Mac's poll
  is a host call (≈0.6 s there and back), one at a time. The polls keep that Mac's worker alive, which
  its session's lease already does.
- **Limits.** 1 MiB of UTF-8 each way (`MAX_CLIPBOARD_BYTES`), one host call or RPC; more is refused
  with its size, not cut. A copied picture or file has no text and is left alone.
- **Who may.** The two RPCs refuse `plugin` callers and any Mac with no session open (any window or
  device: the registry's list). That is a per-Mac gate for bb's clients, not ownership of a session:
  any window, device, the CLI or an agent may call while any relay session to that Mac exists, even
  one not yet past Screen Sharing's sign-in, and the account check is the page's, not the server's.
  The CLI and agents count as `client`, as for tickets; the skill tells agents never to call them.
  They log nothing, and the server never stores the text.
- **Reading this computer's clipboard** is `navigator.clipboard.readText`: focus required everywhere;
  Chrome asks once; Safari, Firefox and the mobile app's web view only within a click. bb's desktop
  app sets no permission handler on its main window's session (it does on the in-app browser's), so
  Electron grants `clipboard-read` — read from its `app.asar`, not from a live run. Auto sync
  therefore reads it only at moments the user is likely to have copied elsewhere (connect, attach,
  window `focus`, `visibilitychange`, `pointerenter` / `focusin` on the screen), one read at a time
  and at most every 500 ms, and stops after the first refusal until the user asks again. This side
  is not polled. Send clipboard and turning Auto sync on call `readText` before awaiting anything,
  so a click-only browser sees the click.
- **Writing it** is bb's `experimental_copyToClipboard` (native in bb's desktop app, focus not needed).
  Receive awaits the Mac first, so where a browser writes only within a click the notice offers a
  Copy button: a click of its own.
- **One step at a time** (review pass 1). Every read or write of the Mac's clipboard, and every write
  of this computer's, runs in one queue in `ClipboardSync`, in the order asked — Send, Receive and
  Auto sync alike — so no answer lands between another step's read and write, and an older poll
  cannot overwrite a newer Receive. Reading this computer's clipboard starts at once (inside the click,
  where there is one) and only its use waits in the queue; an automatic read that a write here
  overtook is dropped as stale (`localRevision`, bumped only by a write that took). A write here that
  failed leaves the clipboard as it was, possibly never read, so the next automatic read is adopted as
  what it holds instead of sent: otherwise old text here went over the Mac's newer copy (review pass
  2). An automatic send also checks again, just before it runs, that Auto sync is still on under the
  same choice (`clipboardPreference.getVersion()`), the screen still takes input and the page is not
  hidden; Send clipboard does not depend on Auto sync. The Copy button writes at once, outside the queue,
  so it keeps its click. After every await a step checks the session has not ended, so nothing from
  a closed session reaches either clipboard.
- **No ping-pong.** `ClipboardSync` keeps what each side was last known to hold. Auto sync sends only
  text it has not already read or written locally, and copies only text the local clipboard does not
  already hold; so the Mac's count moving for text sent from here changes nothing, and a failed local
  write is not followed by the old local text going back over the Mac's new one.
- **Auto sync is per computer**, in `localStorage`, not a bb setting: clipboard access depends on the
  computer and browser, and a phone that cannot read the clipboard should not turn it on everywhere.
- **The menus are drawn inside the page**, not bb's portalled dropdown, because full screen hides
  what is portalled outside the page (`app/toolbar-menu.tsx`).

## The host link

How a session to a Mac other than the server's works (`server/host-link.ts`, `host/relay.ts`). bb's
host link is a JSON RPC up and lossy, ephemeral signals down (the SDK guide calls them "invalidation
signals"); the worker sends each signal over IPC and the daemon over its one WebSocket to the server,
which starts each handler as it arrives. So signals arrive in order in practice, but none is
guaranteed, and the design must not depend on either.

- **Up:** the viewer's bytes are batched into `write` calls of at most 128 KiB, numbered from 0, with
  up to 24 in flight (`MAX_PIPELINED_WRITES`; 8 until 0.2.1 — a scroll or drag sends input every
  frame, and at 8 a second of scrolling reached the Mac ≈550 ms after each event instead of ≈300 ms
  at 300 ms each way, waiting behind the window). **bb does not deliver concurrent host calls in order**:
  its server awaits `resolveHostEnvironment` for each call before sending it, so calls overtake each
  other. The 0.2.0 candidate ended the session on the first one out of order, and every session to a
  MacBook died while the user typed the password (the log said "expected 4, got 5"); twelve one-byte
  writes reproduced it three times in three, and arrived as early as 6 before 0. So the host holds a
  write that arrives early until the ones before it are in (`MAX_WRITES_AHEAD`, 32), and ends the
  session only on a repeated number or one too far ahead. The server's window is counted from the
  earliest write still unanswered, not by calls in flight: the host answers an early write as soon
  as it holds it, so counting calls let later writes run past the host's 32 behind one slow call
  (review pass 1; `server/remote.test.ts` holds write 0 back while 72 more are typed).
  `MAX_PIPELINED_WRITES` and `MAX_WRITES_AHEAD` live together in `shared/limits.ts`. `testing/fake-daemon.ts`'s `callJitterMs`
  makes calls overtake each other, and `server/remote.test.ts` types through it. Pipelining is what
  keeps typing from waiting a round trip per key; serialised writes would make each key wait for the
  one before it.
- **Down:** the host coalesces what Screen Sharing sends into `data` signals of at most 128 KiB raw,
  numbered from 0, emitted one at a time. The server ends the session on a gap — a VNC stream with a
  hole is garbage — and ignores a signal from any host but the session's own.
- **Flow control** (end to end, see below): the server forwards the page's acknowledgement totals as
  `ack`, one call in flight carrying the latest total; the host pauses its socket while emitted minus
  acknowledged (plus pending) exceeds `HOST_WINDOW_BYTES` (16 MiB). So neither the host nor the server
  holds more than the window for a slow page.
- **Leases:** `open` takes a worker lease (`experimental_retainWorker`, which bb allows only during a
  call) and the session releases it on every end, failure to connect included. Without it the daemon
  stops an idle worker after five minutes and its sockets with it.
- **Liveness:** a timer (every 2.5 s) sends `keepalive` for a session quiet for `HOST_KEEPALIVE_MS`
  (5 s), timed out after `HOST_KEEPALIVE_TIMEOUT_MS` (10 s); the host ends a session it has heard
  nothing about for `HOST_SILENCE_MS` (3 min). A failed call ends the session on the server — a call to a host bb is not connected
  to fails, so a Mac whose bb restarted or whose network dropped ends a quiet session in ≈7.5 s with
  the fake daemon (it was 60–75 s), or within the keepalive's timeout if the call hangs instead; a server that vanished (crash, reload whose close
  never arrived, a lost link) leaves the host's session to expire. bb raises no plugin event when a host
  disconnects, and `experimental_onWorkerExit` skips daemon shutdown, so the keepalive is what notices.
- **Teardown, all tested in `server/remote.test.ts`:** the page closing, Close all, the plugin stopping
  (bb closes the sockets, the relay asks the host to close), Screen Sharing hanging up (the host's last
  `data`, then `closed`), bb stopping the worker (lifecycle abort and `dispose` close every session and
  signal `closed`), the worker crashing (`experimental_onWorkerExit`), the link dropping (the next call
  fails here; the host expires it), and the page leaving while the host is still connecting (`close`
  is sent once `open` answers). On the host, a session closed while it is still connecting — by
  `close`, by bb cancelling the call (`context.signal`) or by the worker stopping — never opens, and a
  stopping worker opens nothing more. An `open` that fails on the server (a timeout) still sends
  `close`, in case the host did connect. `ws.send` is guarded: it runs inside socket and signal
  callbacks in the bb server's process. Close reasons are cut to 123 bytes of UTF-8 at whole characters
  (`shortReason`): they carry the Mac's name, and bb's `ws` refuses a longer reason and closes
  nothing, which would leave the page showing a session the server has already ended.

Live, holding a connection at Screen Sharing's security-type list without signing in: the MacBook
and the MacMini (over loopback, no host link) both hang up at 240 s ("Screen Sharing closed the
connection"), which is macOS's own limit on an unauthenticated connection, not the relay. Over the
host link that is past `HOST_SILENCE_MS`, so the keepalives reach the Mac.

Measured with `testing/fake-daemon.ts` at 300 ms each way: greeting and a key echo ≈ 600 ms (one
round trip), 30 keys typed over 600 ms all echoed after ≈ 1.2 s, a second of scrolling (60 events)
at the Mac ≈ 300 ms after each event (median; under 500 ms at worst), ≈ 19–26 MiB/s with the 16 MiB
window. Over that link a scroll still redraws slowly: noVNC asks for the next screen update once the
last has arrived, so the frame rate is bounded by the round trip — the plugin cannot change that
without changing how noVNC asks.
The real link adds bandwidth limits the fake has none of (the study measured ≥ 17 MB/s of base64
signals from a MacBook).

## Flow control

The page acknowledges what it has received (`app/flow.ts`): a text frame `ack:<total bytes>` at most
every 50 ms. The relay checks it (never less than before, never more than it sent; anything else ends
the session with 1008) and hands it to the link. The loopback link pauses the server's TCP socket
while more than `LOOPBACK_WINDOW_BYTES` (8 MiB) is unacknowledged; the host link forwards it to the
host. bb's plugin WebSocket has no `bufferedAmount`, so this is the only way the server can tell a
page is behind. The relay URL carries `flow=ack-ping` — the text frames the page speaks, acks and
pings — and the relay refuses any other value before redeeming the ticket, with a "reload bb" reason.
That covers both sides of an update: a window still running an older page (no flow control, or
0.2.0's `flow=ack`, which never pings and would stay "connected" after bb restarts) is refused
instead of stalling, and a relay from 0.2.0, which accepted only `ack`, refuses this page instead of
closing its session on the first ping. Change the value whenever the page's text frames change.

## Keys

What reaches the Mac depends on the computer the user sits at, and on a Mac some shortcuts never
reach any page. The evidence, so nobody has to rediscover it:

- **macOS keeps its own shortcuts, and no page can take them.** Keyboard Lock is the only web API for
  claiming system keys, and Chromium's macOS system hook is a stub: `KeyboardHook::
  CreateModifierKeyboardHook` in `ui/events/mac/keyboard_hook_mac.mm` returns `nullptr`, and
  `-[RenderWidgetHostViewCocoa lockKeyboard:]` carries `TODO(joedow): Integrate System-level keyboard
  hook`. Safari and Firefox have no Keyboard Lock. So ⌘Tab / ⇧⌘Tab (the Dock's app switcher),
  ⌘Space and the input-source shortcuts, Mission Control and Spaces (⌃↑ ⌃↓ ⌃← ⌃→, F3), ⌥⌘Esc, ⌃⌘Q,
  ⇧⌘3/4/5, Globe/Fn and the media keys stay on the user's own Mac. Chromium also never forwards ⌘`
  (window cycling) or any shortcut listed in `com.apple.symbolichotkeys`: `EventIsReservedBySystem`
  in `performKeyEquivalent:`, with ⌘` added by default in `content/browser/cocoa/system_hotkey_map.mm`.
- **The only way to give those to the Mac is to send them**: the Send keys menu (`app/keys.ts`)
  presses each shortcut with `rfb.sendKey`, and "Hold ⌘" keeps ⌘ down on the Mac so the user's own
  Tab steps the app switcher; ⌘ is released by "Release ⌘" and by every release path above (detach,
  View only, Disconnect, Close all, teardown). No remapping (say ⌃Tab sent as ⌘Tab): the menu covers
  the same ground without making a key mean two things.
- **bb's desktop app (Electron 44.3, Chromium 152)** gives the page every other ⌘ shortcut already.
  Chromium hands a key equivalent to the page first and passes it to the app menu only if the page
  leaves it unhandled (`performKeyEquivalent:` forwards it to the renderer; see
  https://www.chromium.org/developers/os-x-keyboard-handling/, and electron/electron#11116 for a
  renderer `preventDefault()` stopping a menu accelerator), and noVNC calls `preventDefault()` on
  every key it takes. So ⌘W, ⌘Q, ⌘H, ⌘M, ⌘T, ⌘N and ⌘, reach the Mac instead of bb's menu. The
  exceptions are ⌘R and ⇧⌘R: bb's main process takes them in `before-input-event` to reload bb
  (`registerApplicationRendererReloadShortcut` in its `app.asar`), which also ends the session — send
  ⌘R from the menu. This reading of the desktop app comes from source, not from a live session.
- **Chrome and Edge** (bb through getbb.app) keep ⌘W, ⇧⌘W, ⌘T, ⌘N, ⇧⌘N, ⇧⌘T, ⌃Tab, ⌃⇧Tab, ⌥⌘← / →
  and ⌘Q for themselves (`BrowserCommandController::IsReservedCommandOrKey`). Keyboard Lock marks
  locked keys to skip that pre-handling (`event.skip_if_unhandled` in `keyEvent:`), so with "Full
  screen" on they reach the Mac too. Esc then reaches the Mac as well; holding it for 1.5 s leaves full
  screen (`kHoldEscapeTime` in `keyboard_lock_controller.cc`; Electron matches this since
  electron/electron#40365).
- **"Full screen"** (`setFullScreen`) puts the whole page — toolbar included, so Send keys and
  Release ⌘ stay in reach — in full screen and calls `navigator.keyboard.lock()` with no list (all
  keys). It is offered only where Keyboard Lock exists (`canGoFullScreen`); elsewhere the switch is
  disabled and the menu says why. It ends when full screen ends (`fullscreenchange`), on View only,
  detach, Disconnect, Close all and teardown, each of which also unlocks the keyboard.

## Security invariants

- **A session needs a ticket, for one Mac.** `openSession` mints one only for `client` callers (not
  other plugins; see *Who may mint a ticket*) and only for a machine bb has — the server's own, or a
  connected one. The ticket names the Mac and the route; redeeming it uses it up, a wrong Mac uses it
  up too, and it expires after 30 s; at most 16 wait at once.
- **One socket per ticket.** The relay connects to Screen Sharing — loopback TCP, or `open` on the host
  — only after a ticket is redeemed; a refused socket closes with 1008 and never reaches any Mac.
- **The same on every Mac.** Nothing listens and nothing is exposed on any of them: the host entry
  connects out to its own loopback, and only the plugin's own server can call it. Plaintext RFB leaves
  a loopback interface only inside TLS (the getbb.app tunnel, the host daemon's link).
- **Bytes only.** Neither the relay nor the host entry parses, logs or stores what crosses it; they log
  only session ids and close reasons — never the ticket. The sign-in travels inside RFB's own ARD Diffie-Hellman
  exchange; the page hands it to noVNC and clears the form. noVNC keeps the very object it is handed
  (`_rfbCredentials`) for the life of the connection, so the store empties that object once the
  sign-in is over — on `connect`, on `securityfailure` and on teardown. Not earlier: noVNC's ARD step
  re-reads the fields when it resumes after its async encryption. No setting holds credentials.
- **Everything closes.** WebSocket close or error destroys the TCP socket or closes the host's session;
  a relay that stops answering the page's pings ends the page's session even with its socket open;
  TCP close or error, or the host's `closed`, closes the WebSocket; every remote teardown also releases
  the host's socket and lease (see *The host link*); the sweep (every 15 s) ends sessions with no traffic for 30 min or older than 8 h;
  `closeAll` ends them all, on every Mac (4003), voids every unredeemed ticket, and bumps a generation that
  `openSession` reads before its await, so a request already under way cannot mint afterwards; in the
  window that pressed it, Close all also cancels the store's own attempt still waiting for a ticket.
  On reload or disable bb closes the plugin's sockets itself with 1012
  before the dispose hooks run, and `bb.onDispose` then ends every session, which destroys the TCP
  sockets (its 4004 rarely reaches a page). The store ends a session after 30 min without input,
  seen or not, on Disconnect, and on `pagehide` (the window closing); a ticket that arrives after
  Disconnect is never used. Leaving the page does not end a session — the sidebar "Live" and the
  corner pill are how an unseen one stays visible.
- **The clipboard only beside an open session.** `clipboardRead` and `clipboardWrite` refuse other
  plugins and any Mac with no session open, and reach only the clipboard of the account bb runs as
  there; the page uses them only for a signed-in session as that account. Neither the server nor the
  host entry logs or stores clipboard text. The page keeps the user name typed at sign-in for the
  session, to tell whether it is that account; the password is never kept.
- **Open sessions are visible.** Every open and close publishes the list, whichever Mac; the sidebar row
  and a corner pill in every window show it, both the pill and the page's title bar offer Close all,
  and the picker marks each Mac with a session as Live.

## Status check

`hosts` lists the enrolled machines without asking any of them anything; the page then calls
`status` for each at once, so the server's own answer does not wait on a laptop's round trip. For the
server's Mac the check runs in the server; for any other the server asks its host entry (12 s
timeout), answers `offline` for a machine bb is not connected to without calling it, and
`unreachable` with the error when the call fails (an old bb on that machine, say). The host entry
answers `unsupported` off macOS.

The check itself is read-only and needs no root. The RFB probe reads the version line, answers with the
highest version it speaks that the server offers (3.8 for Apple's `003.889`, never more than the
server), reads the list of security types and hangs up before choosing one, so it never signs in. The
probe decides `ready`: Remote Management also answers on 5900 while the Screen Sharing switch is off.
An empty list is the server turning connections away (macOS does after repeated failed sign-ins); the
probe reads its reason and reports `refused`.
`signInSupported` is false when the Mac offers none of noVNC's types (Apple offers 30, ARD, by
default). Nothing here can turn Screen Sharing on: since macOS 12.1 that takes System Settings or MDM,
and the page says so.

## noVNC

`@novnc/novnc` is pinned exactly and bundled into the app; it is MPL-2.0, noted in
`THIRD_PARTY_NOTICES.md`. Keep it unmodified — a change to its files would have to be published under
the MPL. It uses top-level await, which bb's ESM app build accepts. Its sign-in for Apple's type 30
needs WebCrypto, so the page must be a secure context: `https://…getbb.app` and `http://127.0.0.1`
both are, a bare LAN `http://` address is not.
