# Changelog

Notable changes to `terminals`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **A Terminals page** in the sidebar, with tabs of shells on any machine connected to bb. Each one
  opens in that machine's home folder; no project is needed.
- **+ at the end of the tabs** opens a terminal: straight away when one machine is connected, from a
  list of machines when there are several.
- **Nothing is lost when you leave the page**: every tab, the one you were on, and each terminal's
  scrollback and position stay as they were, and whatever was running keeps running.
- **Reloading or reopening the app** reattaches every tab to its shell, with its recent output.
- **The same tabs in every window**, in the desktop app and in a browser.
- **Offline machines and ended shells are shown as such**; closing a tab ends its shell.
