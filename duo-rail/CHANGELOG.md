# Changelog

Notable changes to `duo-rail`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **Buttons at the bottom of the empty strip beside the screen on the iPhone Duo**, on the folded cover
  screen and on the unfolded display, stacked upward from just above the home indicator, clear of the
  camera, the clock and the Dynamic Island. Out of the box: Back, New thread, and More, which lists your recent threads and
  offers Forward and Reload bb. They show only on the Duo, on whichever side its strip is, and nowhere
  else.
- **Your own buttons**, chosen separately for the folded and the unfolded display, in the plugin's
  settings: add, remove and reorder them, and give each a symbol and an action. The symbol shows beside
  the button's name; press it to pick from every one bb draws (181), in a small popover you can search
  by name. A button can go back or
  forward, open a new thread (in a project you pick), a thread, a project, your recent threads or a web
  address, run an action from bb's thread menu (Pin, Archive, …) on the thread you are looking at, run a
  `bb` command and show its result, reload bb, or open a menu of its own. The command list holds every
  installed plugin's commands and subcommands and bb's own, and narrows as you type. A button is named
  after what you pick until you name it yourself. Export and Import copy the buttons between bbs. The
  layout is kept on your bb server, so every device follows it.
- **Space for the camera**, one setting for each display: how high the buttons may reach, so they stay
  clear of the camera, the clock and the Dynamic Island.
- The buttons stay showing over a thread's side pane, which on the folded cover screen fills the screen,
  and step aside when bb's sidebar drawer, a sheet or a menu opens over them.
- **Debug numbers** above the top button, off until you turn on *Show debug numbers*: what the screen
  reports about its edges and sizes, updated live. A temporary aid.
