# Changelog

Notable changes to `firstmate-voice`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **Talk to your first mate out loud.** A Talk button on the first mate's thread and a command in the
  palette start a voice session on the desktop or on your phone, with a small bar to mute or end it.
- **Answers from the board,** without waking the first mate: what needs you, what is running, what a
  worker last said, what is next.
- **Requests in your own words.** Anything else goes to the first mate exactly as you said it, all of it
  since the voice last handed over, even when you paused midway, with the voice's own account of what you
  asked beside it, marked as the voice's, and what the voice said aloud to you in that time (the first
  mate's reply it read out included), so a short "hold it" arrives with what "it" was. Its answer is read
  to you when its turn ends.
- **Buttons stay a tap on the board.** The voice tells you which buttons a card offers but never presses
  one; asked to, it offers to hand your request to the first mate in your own words. Merges, anything
  destructive, publishing, credentials and settings are never your word by voice.
- **Spoken news:** a new call for you, named as the board names it (title, project, pull request,
  question, buttons), a worker that failed, the first mate waiting on a question, and every message the
  first mate posts while you talk (not only answers to what you asked by voice), first sentence first.
  Several at once go in order, one sentence each.
- Sessions renew at OpenAI's one-hour limit and end after ten quiet minutes.
- **A debug log of the session,** for tuning the voice: the bug button on the voice bar, "FirstMate voice:
  debug log" in the palette, or the first mate's header menu opens it as a "Voice debug" tab in the thread's
  side panel, beside the chat, on the desktop or the phone. It shows, in order and timed, what the voice was told at the start, what you said and what it
  said, its tool calls and their answers, each message it handed the first mate word for word, each message
  from the first mate, announcements, interruptions and errors. It stays on your bb, in memory, until you
  next tap Talk, and never shows a credential.
- **Voice hooks:** a script you put at `~/.config/firstmate-voice/hook` on a machine runs as listening
  starts and stops, as the voice starts and finishes speaking, and as you start and stop talking, with the
  moment (and why listening stopped) in an environment variable, so one script handles them all. It runs on
  the machine whose bb desktop app is in the call, from your home folder, for at most five seconds, and
  never holds the call up. Nothing in bb can set it: the plugin's settings page shows only which machines
  have one, with yours marked. The mobile app and a browser tab run none. Each run shows in the debug log
  with its exit status and how long it took.
