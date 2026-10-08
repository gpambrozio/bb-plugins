# AGENTS.md

A bb plugin that adds a **Screen Sharing** sidebar page: the screen of the Mac running the bb server,
seen and controlled through noVNC in the page, relayed by the plugin to macOS Screen Sharing on
`127.0.0.1:5900`. It is not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `screen-sharing`. The feasibility study behind it measured bb's channels and auth; its
findings are summarised under *Decisions*.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the RPCs, the relay route, the sweep timer and disposal. Holds the limits (ticket life, no-traffic, maximum length, buffer cap). |
| `server/sessions.ts` | Tickets (single-use, bound to a Mac, short-lived) and sessions (no-traffic and age limits, Close all). No sockets. |
| `server/relay.ts` | One WebSocket ⇄ one TCP connection, bytes copied untouched; either end closing closes the other. |
| `server/status.ts` | Is Screen Sharing on: `launchctl print-disabled system` and an RFB greeting probe that signs in to nothing. |
| `shared/channels.ts` | Route, realtime channel, close codes, limits and zod shapes; no SDK import, so the app may use it. |
| `shared/contract.ts` | The app ⇄ server RPC contract. The app imports it as a type only. |
| `app/screen-panel.tsx` | The page: status and System Settings guidance, Connect/Disconnect, View only, the title bar's Close all. |
| `app/session-store.ts` | The window's session, outside React: ticket → WebSocket → noVNC into an element it owns; the input-idle disconnect; the local-cursor CSS; why it ended. |
| `app/vnc-session.tsx` | The live screen on the page: lends the store's element a place while the page is open; the sign-in form. |
| `app/rfb.ts` | The seam the page's tests replace: `new WebSocket` and noVNC's `RFB` (scaling, dot cursor). |
| `app/sessions.tsx` | The open sessions as the app sees them; the sidebar "Live" and the corner Close all pill. |
| `app/novnc.d.ts` | Types for the part of noVNC's `RFB` used here; noVNC ships none. |

`npm test` runs everything. The tests never touch this machine's real port 5900: the relay and the
probe run against fake TCP servers, and the fake-host test drives the route only with tickets it
refuses.

## Decisions

**Which machine: the bb server's own, in `server.ts`, no `bb.host` entry.** The server runs on the Mac
it shares, so a loopback `net.connect` reaches Screen Sharing. Other enrolled Macs are refused in
`openSession` (the route's `host` parameter is there so a relay to them can be added later). The study
measured the two ways to reach another Mac: a relay over the host channel (host RPC up, host signals
down) works but the round trip was ≈600 ms to remote hosts; a gate-shared port
(`bb.hosts.declareSharedPorts`) is unproven. Neither is in this version.

**One same-origin WebSocket route, `bb.http.experimental_websocket("/vnc", …, { auth: "local" })`.**
bb serves the app from the server's own origin (`window.location.origin` is what bb's own SDK uses for
`/api` and `/ws`), so the page opens the route as a same-origin socket: over loopback on the Mac,
through bb's getbb.app tunnel remotely. "local" auth refuses a browser on any other origin (403,
checked in the study); a request with no `Origin` header passes. Browsers always send one, so that
is a non-browser client of the bb API: a local process (which can reach port 5900 directly anyway),
or anything that can reach a bb server bound to the network with `BB_SERVER_BIND_HOST` — which can
then already drive every bb API, terminals on every host included. The relay adds no reach beyond
bb's own API. The API is experimental; `engines.bb` is `>=0.45`.

**Who may mint a ticket.** `openSession` refuses callers bb marks `plugin` (another plugin through
`bb.sdk.plugins.callRpc`). bb marks everything else `client` — the app, the `bb` CLI, agents — and
nothing distinguishes the app, so the CLI and agents can mint tickets too. They still need the macOS
user name and password to get past Screen Sharing's sign-in, and the skill tells agents never to try.
Do not claim more than this in docs or messages.

**A session belongs to the window, not the page.** bb unmounts the page whenever the user opens
something else but keeps the plugin's app module loaded for the life of the window, so the session
(`screenSession` in `app/session-store.ts`) lives at module scope: the WebSocket, noVNC's client and a
`div` noVNC draws into. The page appends that `div` while open and removes it on unmount; noVNC keeps
running detached (a 0×0 target scales to 0, and its ResizeObserver rescales on reattach). Coming back
shows the same connection, already signed in. Nothing about the sign-in is kept to make this work —
the live connection is what persists. One session per window; another window has its own.

**Idle is measured in the window.** noVNC asks for a screen update after every one it gets and the
menu-bar clock changes each minute, so bytes flow as long as a session is open, seen or not. The
server's 30-minute limit therefore only catches clients that went away (no traffic at all); the store
ends a session after 30 minutes without a key, click, touch, wheel or pointer movement on its element
— which an unseen, detached screen never gets.

**The pointer.** noVNC sets its canvas's CSS cursor to `none` until the server sends a cursor shape
(Cursor or VMware cursor pseudo-encoding), and macOS Screen Sharing sends none it can draw (noVNC
issue #1430), so the pointer vanished over the screen. `LOCAL_CURSOR_CSS` shows the ordinary arrow
while the canvas says `cursor: none` — the local pointer is exactly where a click lands — and leaves a
real remote cursor (`url(…)`) alone; `showDotCursor` covers a remote cursor that is fully transparent.

**Never expose a port.** No `bb connect expose`, no `declareSharedPorts`, no listening socket. The
gate carries only HTTP and WebSockets, so raw VNC could not cross it anyway, and an exposed share
would be one more door to a Mac's screen.

**The page opens the WebSocket itself and hands it to noVNC** (`new RFB(target, socket)`), so it can
read the close code and say why a session ended; noVNC reports only clean or not. No subprotocol is
requested.

**View only is noVNC's `viewOnly`, set in the page.** The relay does not parse RFB to enforce it; the
user is the one viewing.

## Security invariants

- **A session needs a ticket.** `openSession` mints one only for `client` callers (not other plugins;
  see *Who may mint a ticket*) and only for the server's primary host. Redeeming it uses it up, a
  wrong Mac uses it up too, and it expires after 30 s; at most 16 wait at once.
- **One socket per ticket.** The relay connects to 5900 only after a ticket is redeemed; a refused
  socket closes with 1008 and never opens TCP.
- **Bytes only.** The relay never parses, logs or stores what crosses it, and logs only session ids
  and close reasons — never the ticket. The sign-in travels inside RFB's own ARD Diffie-Hellman
  exchange; the page hands it to noVNC and clears the form. No setting holds credentials.
- **Everything closes.** WebSocket close or error destroys the TCP socket; TCP close or error closes
  the WebSocket; the sweep (every 15 s) ends sessions with no traffic for 30 min or older than 8 h;
  `closeAll` ends them all (4003). On reload or disable bb closes the plugin's sockets itself with 1012
  before the dispose hooks run, and `bb.onDispose` then ends every session, which destroys the TCP
  sockets (its 4004 rarely reaches a page). The store ends a session after 30 min without input,
  seen or not, on Disconnect, and on `pagehide` (the window closing); a ticket that arrives after
  Disconnect is never used. Leaving the page does not end a session — the sidebar "Live" and the
  corner pill are how an unseen one stays visible.
- **Open sessions are visible.** Every open and close publishes the list; the sidebar row and a corner
  pill in every window show it, and both the pill and the page's title bar offer Close all.

## Status check

`status` is read-only and needs no root. The RFB probe reads the version line, answers with the
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
