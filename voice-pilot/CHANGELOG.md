# Changelog

## 0.1.0

- First release. Tap Talk on the new Voice page, in any thread's header or from the command palette, and
  Voice Pilot says hi and names the running threads (and which one waits on you) in a few seconds, then
  listens.
- Ask what's going on, what a thread said, or what waits on you. It reads bb's questions aloud with their
  options and answers them with the choice you say, then tells you what it sent.
- Approvals (a command, a file change, a permission, a plan) are read out; one is sent only after you say yes
  to a read-back of exactly what will be sent. A command too long to read aloud in full is approved in bb,
  never by voice on a part of it.
- With several questions in one, the voice asks them one at a time and sends all the answers together, so
  each answer in your own words goes to its own question.
- Send a message to a thread, start a thread in a project, stop a thread or show one on screen, by voice.
  Nothing is merged, archived, deleted or published by voice.
- Reads everything in a thread's reply, tables, cards and lists included, and opens a link you ask for (a
  web page in a new tab, a thread in bb); the session's card says what it opened. A web address that was not
  in anything it read is read back to you first.
- Hears about threads that start waiting on you, fail, or finish after you messaged them by voice. A finished
  turn is told from the agent's reply: what it did, any pull request, anything it waits on you for.
- Background noise, a cough or an "um" no longer gets an answer: the voice answers only once it has heard
  real words.
- On a phone, switching away from bb pauses the session instead of ending it. Come back to bb and the voice
  says it is back and carries on where you left off, then tells you what happened meanwhile; the card says
  Paused with Resume and End until then. A pause of half an hour ends the session.
- Ask the voice to change how it behaves from now on ("call me Sam") and it proposes an edit of its own
  instructions instead of changing them: the Voice page shows what would change, and you apply it, tweak it
  first, or reject it. A pencil on the Voice entry in the sidebar says one is waiting. One waits at a time; a
  newer proposal replaces it and the page says so. An applied edit takes effect from the next voice session.
- Say "mute" and the voice mutes your microphone, as the Mute button does, without ending the session; it
  tells you to tap Unmute to talk again, and the card says so too.
- Runs on an OpenAI API key or on your ChatGPT subscription through the codex-realtime plugin.
- Voice hooks: a script on each machine, run as listening starts and stops, as the voice speaks and as you
  talk. Name it `hook`, or `hook.sh`, `hook.py` and the like. The settings list which machines have one, and
  Open the script edits it in place on its machine, keeping it executable, with a warning when it changed on
  disk since you opened it.
- The Voice page shows the session's state and its log: what you said, what the voice said, what it did.
  The log's Settings button opens Voice Pilot's settings.
