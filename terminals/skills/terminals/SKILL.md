---
name: terminals
description: "What the Terminals plugin's sidebar page is, and how its tabs relate to `bb terminal`. Use when the user asks about the Terminals page, a shell they opened there, or why a tab there says its machine is offline or its shell ended."
---

# Terminals

The Terminals plugin adds a **Terminals** page to the bb sidebar: tabs of shells on any machine
connected to bb, each opened by the user in that machine's home folder, with no project. The user
opens one with **+** at the end of the tabs (choosing the machine when several are connected) and
closes one with its **×**, which ends the shell. The user can rename a tab (double-click, its
right-click menu, or F2); the name is shared by every window and is also the session's title.

Each tab is an ordinary bb terminal session, so `bb terminal list --machine <machine>` lists it (its
title is the machine's name) and `bb terminal show <id>` describes it.

## These are the user's shells

A Terminals tab is the user's own interactive shell. Unless the user asks you to in this
conversation, do not type into it (`bb terminal send`), resize, restart, rename or close it, and do not
call the plugin's `open`, `rename` or `close` RPCs. Reading a tab's output with `bb terminal output
<id>` is fine when the user asks about it. For your own long-running commands, create your own
terminal (`bb terminal create`), not a tab here.

## What the page shows

- A dot on a tab and "This machine is offline" above it: the machine lost its connection to bb. The
  shell waits on the machine and carries on when it reconnects.
- "This shell exited with code N": the shell ended. Its output stays until the user closes the tab;
  tabs of ended shells are dropped the next time the plugin loads.
- No "+" choice for a machine: only machines connected to bb, and not suspended, are offered.
