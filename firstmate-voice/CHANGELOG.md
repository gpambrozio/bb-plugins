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
- **Requests in your own words.** Anything else goes to the first mate exactly as you said it, and its
  answer is read to you when its turn ends.
- **Buttons pressed by voice after a read-back** and a plain yes. Merges, anything destructive,
  publishing, credentials and settings are never pressed by voice.
- **Spoken news:** a new call for you, a worker that failed, and the first mate waiting on a question.
- Sessions renew at OpenAI's one-hour limit and end after ten quiet minutes.
