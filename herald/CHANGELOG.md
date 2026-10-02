# Changelog

Notable changes to `herald`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Added

- **Write each sentence with a model**, off by default. Switched on, a command-line tool on the Mac
  running bb — Claude Code, OpenAI Codex, Gemini CLI, or a command of your own — writes each sentence
  from the event, your request and the agent's reply, so you hear what was done rather than the start of
  the reply. The tool runs with no tools or read-only, in an empty folder, and the plain sentence is spoken
  instead whenever it fails or takes longer than 20 seconds.
- **A Model-written sentences section** on Herald's settings page with the tool, the prompt it is
  given (with placeholders you can move around, and a button to get the default back) and, only while
  the tool is *custom*, the custom command, filled in from the tool you had selected.
- The Herald page and the banner above the composer say **Writing the sentence…** while the tool runs.
- **A Herald tab in each thread's side panel** listing what Herald said about the thread's past turns,
  newest first, with when and a Read again button: a way to find a turn by its sentence. The last 50
  are kept per thread. A megaphone in the thread's header opens it.

### Changed

- **The sentence stays.** A turn that ends on the thread you are looking at is spoken, and its sentence
  stays above the composer — through your next prompt — until the next event replaces it. Before, bb
  marking the thread read at once made it vanish unspoken. The one exception: a sentence still being
  written when the agent starts working again is withdrawn and never spoken.

## 0.1.0

The first release: Herald for bb, ported from the Paseo plugin of the same name (0.5.1).

### Added

- **A spoken sentence when an agent needs you** — a question, a plan or a permission to approve, a
  finished turn, or an error — spoken by the bb app, in the voice of the Mac running bb or in the
  browser's own voice.
- **A Herald page** listing every thread waiting on you, with the reason, the sentence and how long ago
  it happened, and a count beside its sidebar entry. It keeps itself up to date. Tap a row to open the
  thread.
- **The sentence above a waiting thread's composer**, with a Read again button, until you answer.
- **Mute here**, **Test voice** and a **settings** button on the page, and **Read again** on every card.
  Read again and Test voice speak even when this device is muted.
- **Speaks from any page**, whether or not the Herald page is open, and in one window at a time.
- **Settings** for where to speak, the voice, the speech rate, which events are announced, and threads
  started by another thread; and a section for the voices.

### Changed from the Paseo plugin

- The sentence is always the plain one built from the event. Having a model write it, as the Paseo
  plugin could, is not part of this release (it arrived in 0.2.0, as a command-line tool rather than a
  helper agent).
- The sentence sits above the composer instead of in the conversation; bb has no way for a plugin to add
  a row there.
- The mobile app can speak, while it is open on screen and once *Test voice* has been pressed. It is off
  by default. Phones no longer vibrate.
- Only one window of the app speaks, so two open windows no longer say everything twice.
- A question you answer before it is announced is not announced.
- Interrupted turns are no longer announced as their own kind of event.
