# Screen Sharing (screen-sharing)

See and control the screens of the Macs connected to your bb from inside bb — the Mac running the bb
server and every other Mac enrolled in it, at home or from anywhere through getbb.app. It uses each
Mac's own **Screen Sharing**, drawn in a bb page by [noVNC](https://github.com/novnc/noVNC). Nothing
extra is installed on any Mac and no port is opened to the internet.

- The **Screen Sharing** page in the sidebar has a Mac picker at the left of its toolbar: the Mac on show,
  with a coloured dot for its state, and a menu of every machine enrolled in bb with whether its
  Screen Sharing is on, off, not a Mac or offline (a sheet on a phone-sized window). Pick one; if its
  Screen Sharing is off, the page says where on that Mac to turn it on.
- **Connect** asks for a macOS user name and password — each time you connect; bb does not keep
  them — and then shows the screen, scaled to fit. Click into it to type and use the mouse. macOS
  itself hangs up on a connection that has not signed in within 4 minutes; connect again if that
  happens.
- **View only** watches without sending keys or clicks. It can be switched during a session.
- **Send keys** sends the shortcuts your own Mac keeps for itself — ⌘Tab, ⌘Space, ⌘`, Mission
  Control and the Spaces arrows, ⌥⌘Esc and more — to the shared Mac. *Hold ⌘ and open the app
  switcher* keeps ⌘ down there so Tab on your keyboard steps through the apps; *Release ⌘* switches.
- **Full screen** (Chrome, Edge and bb's desktop app) puts the page in full screen and gives it the
  whole keyboard, so the browser's own shortcuts — ⌘W, ⌘Q, ⌘T, Esc — go to the Mac too. Hold Esc to
  leave full screen, and leave it to switch to another Mac. Safari and Firefox can't do this; use
  Send keys there.
- Leaving the page does not end the session: it keeps running in that bb window, and coming back shows
  it again, still signed in. **Disconnect** on the page ends it. If bb or the Mac goes away during a
  session — bb restarting, the network dropping — the page says the connection was lost within a few
  seconds, and **Connect** starts a new session once it is back.
- Sessions to several Macs can be open at once in the same window. The page shows the Mac picked; the
  others keep running out of sight, with your keyboard and mouse going only to the one on screen.
- The pointer stays visible over the screen: macOS's own cursor when it sends one, otherwise your
  usual arrow, which is exactly where a click lands.
- While any session is open — to any Mac, in this window, another window or on another device — the
  sidebar row says **Live** and a pill in the corner of every bb window offers **Close all**, which
  ends every one of them. The page's title bar has the same Close all, and the picker marks each Mac
  with a session open as Live.
- A session also ends after 30 minutes without keyboard or mouse use (whether or not it is on screen),
  after 8 hours, and when you close the bb window.

## What you need

- bb 0.45 or later. The other Macs need bb's host daemon connected to this bb (they are in Settings →
  Machines); the plugin's helper reaches them through it, so nothing else is installed on them.
- **Screen Sharing turned on** on each Mac you want to see: System Settings → General → Sharing →
  Screen Sharing. macOS does not let an app or a script turn it on. Under its ⓘ options, "Allow access
  for: Only these users" keeps sign-in to the accounts you choose; leave "VNC viewers may control
  screen with password" off — the plugin signs in with a macOS account.
- To use it away from home, this bb signed in to its getbb.app account (`bb account login`), as for
  any remote use of bb.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.2.0' --plugin screen-sharing --tag-prefix screen-sharing/
```

The page is **Screen Sharing** in the sidebar; the palette has *Screen Sharing: see and control a
Mac's screen*.

## Which keys reach the Mac

On a Mac, macOS keeps ⌘Tab, ⌘Space, ⌘`, Mission Control and Spaces (⌃ arrows), ⌥⌘Esc, ⌃⌘Q, the
screenshot shortcuts and the media keys for itself; no web page can take them, in any browser. Send
them from **Send keys**.

- **bb's desktop app:** every other key and shortcut already reaches the Mac, ⌘W and ⌘Q included,
  except ⌘R and ⇧⌘R, which reload bb (and so end the session) — send ⌘R from Send keys.
- **Chrome and Edge:** the browser keeps ⌘W, ⌘T, ⌘N, ⌘Q, ⇧⌘T and the tab-switching keys until
  you turn on **Full screen**; then they reach the Mac, and so does Esc (hold it to leave full
  screen).
- **Safari and Firefox:** the browser keeps its own shortcuts; use Send keys.

## How it reaches the screen

The page opens a WebSocket to the plugin on the bb server, at the same address the bb app itself is
using: the bb server's own loopback address on that Mac, and from anywhere else your
`https://<handle>.getbb.app`, which only your signed-in bb account can open. (Opening bb by a plain
`http://` network address does not work: the browser allows macOS's sign-in only on `https://` or on
the Mac itself.) The plugin copies the socket's bytes to and from macOS Screen Sharing on the chosen
Mac's own `127.0.0.1:5900`:

- **The Mac running the bb server:** directly, over its loopback.
- **Every other Mac:** through bb's own connection to that Mac's host daemon, which is encrypted the
  whole way. A small helper the plugin ships runs inside that daemon and connects to the Mac's own
  Screen Sharing on its loopback.

The plugin does not use `bb connect expose` or any shared port, opens no listening socket on any Mac,
and no other site can open its socket.

Before the socket opens, the page asks the server for a ticket: a random token for the one Mac you
picked, good for one socket, for thirty seconds. The sign-in macOS asks for goes from the page to
Screen Sharing inside its own encrypted handshake; the plugin passes it through without reading it and
never logs or stores it. That is the same for every Mac.

Screen Sharing on macOS listens on your whole local network, whatever this plugin does. Keep macOS
up to date, and consider the firewall or "Only these users" if that matters to you.

## Performance

macOS Screen Sharing's fast mode is Apple's own and not available to other viewers, so this is
plain VNC: fine for working on a Mac, not for video.

- **The Mac running the bb server** is as fast as your connection to it: instant at home, your
  connection to Cloudflare and back through getbb.app.
- **Other Macs** go through bb's link to them, which on a laptop away from the server is about 0.6 s
  there and back. Expect about half a second between pressing a key or clicking and seeing the
  screen answer, and a few screen updates a second. Typing and moving the mouse never wait for that
  round trip key by key: what you type is sent as you type it and arrives in order, and a scroll
  moves the Mac as far as you scroll. A big change on screen (a window opening, scrolling) can take
  a second or two to draw: the viewer asks for each new picture once the last has arrived, so that
  round trip sets how often the screen redraws. It is usable for working on
  the Mac; it does not feel local.

## A Mac with more than one display

The page shows the one picture macOS Screen Sharing sends a standard VNC viewer, scaled to fit.
Choosing a display is something only Apple's own Screen Sharing app offers, through its private
protocol extensions, so this viewer cannot pick one. Apple does not document what that picture is for
a Mac with several displays, and this plugin has not been tried on one. Reports from people using
other VNC viewers are few and mixed; on Macs with three or more displays they describe clicks working
only on the main display. If a picture comes out too small, use **Full screen**, or mirror that Mac's
displays while you work on it remotely.

## License

MIT. The bundled noVNC is MPL-2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
