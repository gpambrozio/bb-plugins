Open the screen of the Mac running your bb server inside bb, and use it with your keyboard and mouse
— sitting at that Mac, or from anywhere through your getbb.app address.
It is the Mac's own Screen Sharing, drawn in a bb page; nothing extra is installed on the Mac and no
port is opened to the internet.

## What you get

- A Screen Sharing page in the sidebar. It checks whether Screen Sharing is on and, when it is not,
  says where in System Settings to turn it on.
- Connect, sign in with a macOS user name and password, and the screen appears scaled to the page.
- View only, to watch without sending keys or clicks; switch it at any time.
- Send keys, for ⌘Tab, ⌘Space, Mission Control and the other shortcuts your own Mac keeps; Full
  screen, in Chrome, Edge and bb's desktop app, to give the shared Mac the browser's shortcuts too.
- While any session is open, on any device, the sidebar row says Live and a pill in the corner of
  every bb window offers Close all.
- Leave the page and come back: the session keeps running in that bb window and is still signed in.
- Sessions end on Disconnect or Close all, when you close the window, after 30 minutes without
  keyboard or mouse use, and after 8 hours.

## Private by design

The page talks to the bb server at the same address the bb app is using: your own Mac, or your
getbb.app address, which only your signed-in bb account can open. Each session needs a one-time
ticket that lasts thirty seconds. Your macOS password goes to Screen Sharing inside its own encrypted
sign-in, and bb never logs or keeps it.

## What it needs

- The bb server running on a Mac, with Screen Sharing turned on in System Settings → General →
  Sharing. macOS does not let an app turn it on for you.
- For use away from home, this bb signed in to its getbb.app account.

## Limits

- Only the Mac running the bb server. Other Macs connected to bb are not offered in this version.
- It is standard VNC, because Apple's faster mode is private to its own app: good for working on the
  Mac, not for watching video.
