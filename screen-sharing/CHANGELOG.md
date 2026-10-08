# Changelog

Notable changes to `screen-sharing`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

The first release.

### Added

- **A Screen Sharing page** in the sidebar showing the screen of the Mac running the bb server, with
  keyboard and mouse, at that Mac or remotely through getbb.app. It uses the Mac's own Screen Sharing.
- When Screen Sharing is off, the page says where in System Settings to turn it on, and checks again
  when asked.
- A sign-in with a macOS user name and password every time; nothing keeps them.
- **View only**, which can be switched during a session.
- **Live** beside the sidebar row and a **Close all** pill in the corner of every bb window while any
  session is open, on any device.
- Sessions end when their page closes, after 30 minutes without keyboard or mouse use, and after 8
  hours.
