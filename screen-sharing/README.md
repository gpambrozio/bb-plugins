# Screen Sharing (screen-sharing)

See and control the screen of the Mac running your bb server from inside bb — at that Mac, or from
anywhere through getbb.app. It uses the Mac's own **Screen
Sharing**, drawn in a bb page by [noVNC](https://github.com/novnc/noVNC). Nothing extra runs on the
Mac and no port is opened to the internet.

- The **Screen Sharing** page in the sidebar checks whether Screen Sharing is on and, if it is not,
  says where to turn it on.
- **Connect** asks for a macOS user name and password — every time; bb does not keep them — and then
  shows the screen, scaled to fit. Click into it to type and use the mouse.
- **View only** watches without sending keys or clicks. It can be switched during a session.
- **Disconnect**, or leaving the page, ends the session.
- While any session is open — in this window, another window or on another device — the sidebar row
  says **Live** and a pill in the corner of every bb window offers **Close all**. The page's title bar
  has the same Close all.
- A session also ends after 30 minutes without keyboard or mouse use, and after 8 hours.

This version reaches only the Mac running the bb server. Other Macs connected to bb are not offered.

## What you need

- bb 0.45 or later, with the bb server running on a Mac.
- **Screen Sharing turned on** on that Mac: System Settings → General → Sharing → Screen Sharing.
  macOS does not let an app or a script turn it on. Under its ⓘ options, "Allow access for: Only these
  users" keeps sign-in to the accounts you choose; leave "VNC viewers may control screen with password"
  off — the plugin signs in with a macOS account.
- To use it away from home, this bb signed in to its getbb.app account (`bb account login`), as for
  any remote use of bb.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin screen-sharing --tag-prefix screen-sharing/
```

The page is **Screen Sharing** in the sidebar; the palette has *Screen Sharing: open the server Mac's
screen*.

## How it reaches the screen

The page opens a WebSocket to the plugin on the bb server, at the same address the bb app itself is
using, and the plugin copies its bytes to and from macOS Screen Sharing on `127.0.0.1:5900`. On the
Mac that is the bb server's own loopback address; from anywhere else it is your
`https://<handle>.getbb.app`, which only your signed-in bb account can open. (Opening bb by a plain
`http://` network address does not work: the browser allows macOS's sign-in only on `https://` or on
the Mac itself.) The plugin does not use
`bb connect expose`, and no other site can open the socket.

Before the socket opens, the page asks the server for a ticket: a random token, good for one socket,
for thirty seconds. The sign-in macOS asks for goes from the page to Screen Sharing inside its own
encrypted handshake; the plugin passes it through without reading it and never logs or stores it.

Screen Sharing on macOS listens on your whole local network, whatever this plugin does. Keep macOS
up to date, and consider the firewall or "Only these users" if that matters to you.

## Performance

macOS Screen Sharing's fast mode is Apple's own and not available to other viewers, so this is
plain VNC: fine for working on the Mac, not for video. Through getbb.app it is as fast as your
connection to Cloudflare and back.

## License

MIT. The bundled noVNC is MPL-2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
