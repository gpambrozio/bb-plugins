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
  asked beside it, marked as the voice's. Its answer is read to you when its turn ends.
- **Buttons pressed by voice after a read-back** and a plain yes: a hold, a review loop, a question or
  report, and your choice on a decision card. Every other button, and always merges, anything destructive,
  publishing, credentials and settings, is tapped on the board.
- **Spoken news:** a new call for you, a worker that failed, and the first mate waiting on a question.
- Sessions renew at OpenAI's one-hour limit and end after ten quiet minutes.
