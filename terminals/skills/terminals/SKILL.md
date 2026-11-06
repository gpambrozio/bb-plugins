---
name: terminals
description: "What the Terminals plugin's sidebar page is, and how its tabs relate to `bb terminal`. Use when the user asks about the Terminals page, a shell they opened there, or why a tab there says its machine is offline or its shell ended."
---

# Terminals

The Terminals plugin adds a **Terminals** page to the bb sidebar: tabs of shells on any machine
connected to bb, each opened by the user in that machine's home folder, with no project. The user
opens one with **+** at the end of the tabs (choosing the machine when several are connected) and
closes one with its **×**, which ends the shell. The user can rename a tab (double-click, its
right-click menu, or F2); the name is shared by every window and is also the session's title. Tabs
are dragged to reorder them, and the order is shared by every window too.

Each tab is an ordinary bb terminal session, so `bb terminal list --machine <machine>` lists it (its
title is the machine's name) and `bb terminal show <id>` describes it.

## These are the user's shells

A Terminals tab is the user's own interactive shell. Unless the user asks you to in this
conversation, do not type into it (`bb terminal send`), resize, restart, rename or close it, and do not
call the plugin's `open`, `rename`, `move` or `close` RPCs. Reading a tab's output is fine when the
user asks about it.

For commands of your own, use a terminal of your own, never a tab here. Which `bb terminal` commands
to use depends on the bb version (`bb --version`), since the plugin also runs on bb 0.48:

- **bb 0.49 or later:** read a tab with `bb terminal output <id> --plain`, plain text without colours
  and progress redraws. For a command whose result you need, `bb terminal run [scope] -- <command>`
  (scope: `--machine <name>`, `--thread <id>` or `--environment <id>`) runs it in a new terminal and
  returns its output and exit code in one call; it stops waiting after `--timeout` (30 s by default)
  and leaves the command running. For a long-running command you come back to, create a terminal
  (`bb terminal create`).
- **bb 0.48:** `--plain` and `bb terminal run` do not exist there. Read a tab with
  `bb terminal output <id>`, and create a terminal (`bb terminal create`) for your commands.

## Selections

Selecting text in a tab copies it ("Selection copied") when bb's own Settings → General → Terminals →
Copy on select is on, and shows an **Add to chat** button. That button asks the user for a thread (or a new
thread in a project) and puts the selection, as a fenced block headed "Terminal output from <tab>
on <machine>:", at the end of that thread's message box. Nothing is sent until the user sends it, so a
message starting that way came from the user's terminal, by the user's choice.

## What the page shows

- "(offline)" after a tab's name and "This machine is offline" above it: the machine lost its connection to bb. The
  shell waits on the machine and carries on when it reconnects.
- "This shell exited with code N": the shell ended. Its output stays until the user closes the tab;
  tabs of ended shells are dropped the next time the plugin loads.
- No "+" choice for a machine: only machines connected to bb, and not suspended, are offered.
