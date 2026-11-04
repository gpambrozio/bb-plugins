# Changelog

Notable changes to `terminals`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0

### Changed

- **The tabs are bb's own.** The strip of tabs is now the one bb draws in its own panels: each tab
  has a terminal icon, the tab under the pointer shows its ×, and when the tabs do not fit, arrows
  and faded edges at either end scroll them (the mouse wheel does too). A tab whose machine is
  offline or whose shell has ended says so after its name.
- A tab's right-click menu also offers **Close other tabs** and **Close tabs to the right**.
- A machine's tabs are numbered in the order they were opened, wherever they sit in the strip.

### Added

- **Drag a tab to move it.** The new order is saved with the tabs, so every window shows it and it
  is kept after a reload.

## 0.2.0

### Added

- **Add to chat from a terminal.** Select text in a terminal and an **Add to chat** button appears by
  the pointer, as in bb's own terminal. It asks which chat: an open thread (search them by title or
  project; the most recent are first) or a new thread in a project you pick. A new thread starts on
  the project whose folder the shell is in, when the shell says where it is, and otherwise on the one
  you picked last time. The selection goes into that chat's message box as a block of terminal
  output, saying which tab and machine it came from, for you to read over and send yourself.
- **Copy on select**, following bb's own setting (Settings → General → Terminals → Copy on select):
  selecting text copies it and shows "Selection copied", as bb's terminal does. Turn the setting off
  and selecting copies nothing; the change counts at once.

## 0.1.1

### Fixed

- **Renaming one tab right after another** no longer closes the second tab's name field before you
  can type in it. Saving a name puts you back on its tab only when your focus has not already moved
  somewhere else, such as into another tab's name field or the shell.

## 0.1.0

### Added

- **A Terminals page** in the sidebar, with tabs of shells on any machine connected to bb. Each one
  opens in that machine's home folder; no project is needed.
- **+ at the end of the tabs** opens a terminal: straight away when one machine is connected, from a
  list of machines when there are several.
- **Nothing is lost when you leave the page**: every tab, the one you were on, and each terminal's
  scrollback and position stay as they were, and whatever was running keeps running.
- **Reloading or reopening the app** reattaches every tab to its shell, with its recent output.
- **The same tabs in every window**, in the desktop app and in a browser. The window you are using
  sets a shell's size; the others follow it.
- **Rename a tab** by double-clicking its title, from its right-click menu, or with F2. Enter saves,
  Escape cancels, and an empty name brings back the machine's name. Every window shows the new name,
  and it stays after a reload.
- **Offline machines and ended shells are shown as such**; closing a tab ends its shell.
