# Changelog

Notable changes to `herald`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

The first release: Herald for bb, ported from the Paseo plugin of the same name (0.5.1).

### Added

- **A spoken sentence when an agent needs you** — a question, a plan or a permission to approve, a
  finished turn, or an error — written by a short helper agent and spoken by the bb app, in the voice of
  the Mac running bb or in the browser's own voice.
- **A Herald page** listing every thread waiting on you, with the reason, the sentence and how long ago
  it happened, and a count beside its sidebar entry. It keeps itself up to date. Tap a row to open the
  thread.
- **The sentence above a waiting thread's composer**, with a Read again button, until you answer.
- **Mute here**, **Test voice** and a **settings** button on the page, and **Read again** on every card.
  Read again and Test voice speak even when this device is muted.
- **Speaks from any page**, whether or not the Herald page is open, and in one window at a time.
- **A failed summary is still announced**, in a plain sentence, so a failure never means silence.
- **Settings** for where to speak, the voice, the speech rate, which events are announced, threads
  started by another thread, keeping the helpers, and how long a summary may take; and a section for
  the summary model, the prompt, and the voices.

### Changed from the Paseo plugin

- The summary helpers are hidden threads: they never appear in the sidebar, and they are deleted without
  any separate command-line tool.
- The sentence sits above the composer instead of in the conversation; bb has no way for a plugin to add
  a row there.
- The mobile app can speak, while it is open on screen and once *Test voice* has been pressed. It is off
  by default. Phones no longer vibrate.
- Only one window of the app speaks, so two open windows no longer say everything twice.
- A question you answer while its summary is still being written is not announced.
- Interrupted turns are no longer announced as their own kind of event.
- The prompt's placeholders are named after bb's threads and projects: `{{thread}}` and `{{project}}`
  replace `{{agent}}` and `{{workspace}}`.
