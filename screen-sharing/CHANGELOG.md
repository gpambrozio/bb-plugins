# Changelog

Notable changes to `screen-sharing`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Added

- **Every Mac connected to your bb**, not only the one running the bb server. The Screen Sharing page
  lists the machines enrolled in bb, each marked with whether its Screen Sharing is on, off, not a
  Mac or offline; pick one to connect to it, or to see where on that Mac to turn Screen Sharing on.
  Nothing extra is installed on the other Macs, and no port is opened on any of them.
- Sessions to several Macs at once in the same bb window. The page shows the Mac you pick; the others
  keep running out of sight, and Close all ends every one of them.
- The page says what to expect from a Mac reached through bb's link to it: about half a second
  between a key or click and the screen answering, and fewer screen updates a second. Typing does not
  wait for each key to arrive before sending the next.

### Changed

- A page that cannot keep up with a busy screen now slows the Mac down instead of letting data pile up
  on the way.
- A bb window still showing the previous version of the page is asked to reload before it connects.

## 0.1.0

The first release.

### Added

- **A Screen Sharing page** in the sidebar showing the screen of the Mac running the bb server, with
  keyboard and mouse, at that Mac or remotely through getbb.app. It uses the Mac's own Screen Sharing.
- When Screen Sharing is off, the page says where in System Settings to turn it on, and checks again
  when asked.
- A sign-in with a macOS user name and password each time you connect; nothing keeps them.
- **View only**, which can be switched during a session.
- **Send keys**, for the shortcuts your own Mac keeps for itself (⌘Tab, ⌘Space, Mission Control and
  more), with a held ⌘ for stepping through the app switcher.
- **Full screen** in Chrome, Edge and bb's desktop app: the page fills the screen with the whole
  keyboard going to the Mac, the browser's own shortcuts included. Hold Esc to leave.
- **Live** beside the sidebar row and a **Close all** pill in the corner of every bb window while any
  session is open, on any device.
- A session keeps running while you use other pages in the same bb window, and is still signed in
  when you come back. It ends on Disconnect or Close all, when the window closes, after 30 minutes
  without keyboard or mouse use, and after 8 hours.
- The pointer stays visible over the screen.
