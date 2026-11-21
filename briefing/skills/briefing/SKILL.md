---
name: briefing
description: Get where every bb thread stands in one read with `bb briefing` — each root thread's opening message, latest user message, latest agent reply and blocked sub-threads, each project's description, and FirstMate's tasks by state — or one thread in depth with `bb briefing thread <id>`. Use when the user asks for a briefing, a status round-up of their threads, or what needs them across bb.
---
# Briefing

`bb briefing` prints a briefing on every root thread (no parent, not archived), most urgent first, in at
most 4,000 characters; `bb briefing thread <id>` gives one thread in depth, also within 4,000. Both only
read: they send nothing to any thread and change nothing, and they ignore which thread you call them from.
`--json` on either prints the data for a script; it has no size limit, so do not use it through a tool
that cuts its result (a voice assistant's).

- Each thread entry: `<title> (<project>, <status>[, needs you]) [<thread id>]`, then its sub-thread count
  with the ones that are blocked, failed or waiting on a decision, `Asked:` (the user's opening message),
  `User last:` (the user's latest message) and `Agent last:` (the agent's latest reply).
- `FirstMate's tasks:` appears when FirstMate Crew is installed and its first mate is a root thread:
  needs you, blocked, in flight, queued, done recently, suggested next.
- A `Left out to fit:` line says what was dropped for size; `bb briefing thread <id>` gives that thread in
  depth. Its own `Left out to fit:` line, when it has one, says how much of the agent's reply it gave; for
  the rest, read the thread itself.
- A sub-thread count says "none blocked" only when every idle sub-thread was checked; "could not be
  checked" means its status is not known.
- `Problems:` names what could not be read (an offline machine, FirstMate not running); the rest is still there.

Summarize it for the user; do not paste it whole, and leave the bracketed ids out of what you say.
