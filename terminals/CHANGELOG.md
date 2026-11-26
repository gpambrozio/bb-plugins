# Changelog

Notable changes to `terminals`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0

### Added

- **Ask an agent when a command fails.** When the shell reports it, a failed command shows an
  **Ask an agent** card at the bottom of the terminal. It opens a panel beside the terminal with bb's
  new-chat box, in the project the terminal's folder belongs to, already saying "The last command I
  ran returned an error. Help me debug." Edit it if you like, pick the agent, and send. The agent is
  told which terminal you are working in, and reads the command and what it printed from there itself.
- **The agent can look and try things itself.** That chat can read what the terminal shows and run
  commands in it, at your prompt, where you see them, and gets back their output and exit code. A note
  in the terminal's corner, in bb's accent colour, lists the last three commands it ran there, with a
  button to show them all, until you type at your own prompt there again: a password or an answer typed
  into a command the agent started does not clear it. It never types while a command runs, into an editor or
  other full-screen program, or over something you typed and have not run. Ask it to run something
  and it runs it there, in your terminal, without asking you to confirm first.
- **One chat per tab.** The bot button at the end of the tabs opens the panel at any time, with an empty
  message unless the last command failed. A tab keeps
  its chat, so the next failure goes to the same one; start a new chat from the panel whenever you
  like. No other chat can use that terminal.
- **Agent chats stay out of the sidebar.** A terminal's agent chat lives in its panel and is hidden
  from bb's thread list; **Open in bb** in the panel's header shows it there from then on. bb sends no
  push notifications for a hidden chat, so a setting, **Always show agent chats in the sidebar**, puts
  them all back in the sidebar with notifications.
- **A resizable agent panel.** Drag the edge between the terminal and the panel (or use the arrow keys
  on it) to make the panel wider or narrower; the terminal refits, and this browser remembers the width.
- **Your own instructions for the agent.** A gear at the end of the tabs, and another in the agent
  panel, open the plugin's settings, where you can read what the agent is told, edit it or add to it,
  and restore the built-in text. The terminal's name and machine are always given to the agent,
  whatever you write.
- **After an ssh session ends,** the agent no longer finds the terminal stuck "running" a command when
  the remote shell reported its prompts and your own shell does not: your prompt coming back is enough.
- **Seeing failed commands** needs a shell that marks its prompts: fish 4 and later and nushell do; for
  zsh and bash, the README has lines to add to your shell's settings file.

## 0.4.0

### Fixed

- **Chinese and other late input on iPhone and iPad.** Text from the system Pinyin keyboard (and other
  keyboards that put in a chosen word a moment after the key) now reaches the shell. Before, the
  terminal missed it. bb 0.49 fixed the same thing in its own terminal.
- **A very quick drag of a tab no longer leaves the tabs stuck.** Letting go of a tab just as it began
  to drag could leave it drawn mid-drag and every later click on the tabs ignored until the page was
  reloaded.

### Changed

- **Agents use bb 0.49's terminal commands.** On bb 0.49 or later, agents told about the Terminals page
  read a tab as plain text, without colours and progress redraws, and run a command of their own in one
  step that gives back its output and exit code. On bb 0.48 they work as before.

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
