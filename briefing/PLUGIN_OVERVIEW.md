Hear where every thread stands in one command. `bb briefing` gathers what you would otherwise open thread by thread, and keeps it short enough for a voice assistant to read in one go.

## What the briefing holds

- Every root thread that is not archived, the ones waiting on you first: its project and status, the message that started it, your latest message, and the agent's latest reply, each cut to a sentence or two.
- How many sub-threads each one has, naming any that is blocked, failed or waiting on a decision.
- What each project is about, from the opening of its AGENTS.md, CLAUDE.md or README. It is read on the machine that holds the project, so projects on your other bb machines are described too.
- With FirstMate Crew installed, the first mate's tasks: what needs you, with the question; what is blocked, and why; what is in flight, queued and done recently; and its suggested next steps. Each is a plain title, without ids, links or notes.

## Made for voice

The text is always under 4,000 characters, the most a voice assistant such as Handsfree reads from one tool. When everything does not fit, detail goes in a fixed order (longer messages first, then the oldest threads) and a closing line says what was left out. `bb briefing thread <id>` gives any one thread in depth: its opening message, your last few messages, the agent's latest reply (whole, unless it is too long for one read, and then as much as fits) and every sub-thread with its last status line.

It reads everything without moving your screen, so it gives the same briefing whatever thread is open, or none.

## For scripts

`--json` on either command prints the data instead, for scripts: it has no size limit, so it is not meant for a voice assistant.

## Privacy and cost

The plugin only reads. It never sends a message, changes a thread or writes a file, keeps no state, and sends nothing outside your bb. It needs no account, key or setup.
