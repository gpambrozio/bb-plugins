# Changelog

Notable changes to `skills`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0

### Changed

- **Add to chat** now puts the skill in the message box as a pill, the same one bb's own `/` menu
  inserts, instead of as typed text. The message you send is the same. If the message already starts
  with a command, the skill replaces it instead of being added in front of it.
- **The Skills button** opens its list in the same pop-up bb uses for its `/` menu, above the message
  box, instead of a pop-up of its own. Pressing the button again closes it. After **Add to chat** the
  cursor goes straight back to the message box.

### Added

- **A keyboard command, *Skills: browse this thread's skills***, opens and closes the list from
  whichever message box has the cursor. It has no key until you give it one in bb's keyboard
  settings, and it is in the command palette.

## 0.2.0

### Changed

- **Needs bb 0.45 or later.** bb 0.45 changed how a plugin writes into the message box, and Skills now
  uses the new way. On bb 0.44, keep Skills 0.1.0.
- **Add to chat** still puts the skill's command at the start of the message box without sending it.
  Files, threads and attachments already in the message box stay where they were.

## 0.1.0

The first release: Skills for bb, ported from the Paseo plugin of the same name (0.4.0). Unlike the
Paseo plugin, it does not run a skill for you: it puts the skill's command in the message box, and
you send it.

### Added

- **A Skills tab** in each thread's side panel, listing every skill the thread's agent can use,
  grouped by where it comes from: the project, the repository, your personal folder, an admin folder,
  a Claude Code or Codex plugin, or bb itself.
- **Each skill's full text**, rendered, with where it lives on disk and a button to copy the path.
- **Add to chat**: puts the skill's command at the start of the thread's message box, with the cursor
  after it, ready for any arguments. Nothing is sent until you send it.
- **A Skills button in the composer** with a count, opening the same list in a popover — or a sheet,
  in a narrow window — with a way to the full tab, which opens on the skill you were reading.
- **A palette command** that opens the tab.
- Claude Code, Codex and Hermes threads have their skill files read off disk, in the order that agent
  reads them, so the copy listed is the copy it uses — in a worktree too. Every thread, on any
  provider, also lists bb's own skills and what bb's `/` menu offers.
