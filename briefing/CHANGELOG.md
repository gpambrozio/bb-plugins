# Changelog

Notable changes to `briefing`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **A briefing on every thread in one command.** `bb briefing` lists every root thread that is not
  archived, the ones waiting on you first: its project and status, the message that started it, your
  latest message, the agent's latest reply, and any sub-thread that is blocked, failed or waiting on a
  decision.
- **What each project is about**, from the opening of its AGENTS.md, CLAUDE.md or README, read on the
  machine that holds the project, so projects on your other bb machines are described too.
- **FirstMate's tasks by state**, when FirstMate Crew is installed: what needs you (with the question),
  what is blocked and why, in flight, queued, done recently, and the first mate's suggested next steps,
  each in plain words.
- **Always under 4,000 characters**, the most a voice assistant such as Handsfree reads from one tool.
  When everything does not fit, it drops detail in a fixed order and says what it left out.
- **One thread in depth** with `bb briefing thread <id>`: its opening message, your last few messages,
  the agent's whole latest reply, every sub-thread with its last status line, and every FirstMate task
  for the first mate's thread.
- **`--json`** on either command for the data, with nothing left out.
- **Read-only**: it never sends a message, changes a thread or writes a file, and it gives the same
  briefing whatever thread is on screen.
