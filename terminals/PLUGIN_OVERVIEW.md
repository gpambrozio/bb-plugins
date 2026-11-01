A Terminals page in the bb sidebar with tabs of shells on any machine connected to bb. No project,
thread or checkout is needed: each terminal opens in that machine's home folder, as a new window in a
terminal app does.

## What you get

- Press + at the end of the tab strip to open a terminal. With one machine connected it opens there at
  once; with several, pick one from the list.
- Tabs are named after their machine, and closing a tab ends its shell.
- Leave the page and come back to find every tab, the one you were on, and each terminal's scrollback
  at the line you left it. Whatever was running kept running.
- Reload or reopen the app and every tab reattaches to its shell, with its recent output replayed.
- The same tabs in every window: the desktop app and bb in a browser through getbb.app show and drive
  the same shells.
- A machine that goes offline is marked, and its shells carry on when it reconnects. A shell that ends
  keeps its output on screen with its exit code.
- Colours and font follow bb's theme.

## How it works

Each tab is one of bb's own terminal sessions, run by the chosen machine's bb host daemon, so a shell
does not depend on the page or the app being open. The page draws it with xterm.js and streams it over
bb's own terminal connection. No port is opened, and the plugin stores only the list of tabs: never
output, keystrokes or credentials.

## What it needs

bb 0.48 or newer, and at least one machine connected to bb. A terminal runs that machine's own shell as
the user bb runs as there.
