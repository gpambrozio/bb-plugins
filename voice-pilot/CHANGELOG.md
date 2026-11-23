# Changelog

## 0.1.0

- First release. Tap Talk on the new Voice page, in any thread's header or from the command palette, and
  Voice Pilot says hi and names the running threads (and which one waits on you) in a few seconds, then
  listens.
- Ask what's going on, what a thread said, or what waits on you. It reads bb's questions aloud with their
  options and answers them with the choice you say, then tells you what it sent.
- Approvals (a command, a file change, a permission, a plan) are read out; one is sent only after you say yes
  to a read-back of exactly what will be sent.
- Send a message to a thread, start a thread in a project, stop a thread or show one on screen, by voice.
  Nothing is merged, archived, deleted or published by voice.
- Hears about threads that start waiting on you, fail, or finish after you messaged them by voice.
- Runs on an OpenAI API key or on your ChatGPT subscription through the codex-realtime plugin.
- Voice hooks: a script on each machine, run as listening starts and stops, as the voice speaks and as you
  talk.
- The Voice page shows the session's state and its log: what you said, what the voice said, what it did.
