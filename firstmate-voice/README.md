# FirstMate Voice (firstmate-voice)

Talk to your [FirstMate](../firstmate-crew) first mate out loud. Ask what needs you, hand it work in your
own words, and hear its answers, on the desktop or on your phone with bb in front.

It runs on your ChatGPT subscription through the [codex-realtime](../codex-realtime) plugin: no API key,
but an undocumented use of the subscription that OpenAI can close at any time, and your voice time counts
against your ChatGPT plan. Read codex-realtime's README first.

## What it does

- **Answers from the board without waking the first mate:** "what needs me?", "what's running?", "what did
  the review worker say?", "what's next?". It reads the same board FirstMate draws, kept current while you
  talk.
- **Hands everything else to the first mate in your own words.** Everything you said since it last handed
  over goes exactly as it was transcribed, under the line `Spoken by the captain through FirstMate voice:`,
  so a request you made in several breaths goes whole. Beside it, marked as the voice's own, goes its
  account of what you asked, with what the talk made clear, and the talk itself: your words and what the
  voice said aloud to you in that time, in order, the first mate's reply it read out included, each line
  marked as yours or the voice's. So a short "hold it" arrives with what "it" was. The first mate acts on
  the account but checks it against your words, which alone count as yours. Its answer is read back to
  you when its turn ends.
- **Never presses a button.** It can tell you which buttons a card offers, but you tap them on the board.
  Ask it to press one and it says so, and offers to hand the request to the first mate in your own words
  instead.
- **Never merges by voice.** Merges, anything destructive or irreversible, publishing, credentials and
  settings are never your word by voice: ask for one and the first mate puts up a button for you to tap.
- **Tells you what changed:** a new call for you on the board (its title, project, pull request, question
  and buttons as the board has them), a worker that failed, the first mate waiting on a question in its
  chat, and every message the first mate posts while you talk: its answers to what you asked, its reports
  when a worker finishes, its replies to what you typed or tapped on the board, first sentence first. It
  waits for a pause, says one again if you talked over it, and never says one twice; several at once go in
  order, one sentence each.

## What you need

- bb 0.49 or newer, with [firstmate-crew](../firstmate-crew) 0.11 or newer and a first mate aboard.
- [codex-realtime](../codex-realtime), with `codex login` done on the machine running the bb server, and
  `firstmate-voice` added to its **Plugins that may use the sign-in** setting.
- `firstmate-voice` in FirstMate's **Plugins that may talk to the first mate by voice** setting (it is
  there by default).
- A microphone. On a phone, bb must stay on screen: the session ends when bb leaves it.

## Install

The plugin is not in the BB Community marketplace. Install it from this repository and follow its
releases:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin firstmate-voice --tag-prefix firstmate-voice/
```

## Using it

- **Talk** is a button in the first mate's thread header, and **FirstMate voice: talk or end** is in the
  command palette. The first time, bb asks for the microphone.
- While you talk, a small bar at the bottom right says whether it is listening or speaking, with **Mute**
  and **End**. It sits beside Screen Sharing's bar there, closer to the corner, rather than over it. Saying "goodbye" ends it too.
- A session ends by itself after ten quiet minutes, and is renewed without a break at OpenAI's one-hour
  limit.
- **Debug log.** The bug button on the bar, **FirstMate voice: debug log** in the palette, or **Voice debug
  log** in the first mate's header menu opens **Voice debug**, a tab in the thread's side panel that you can
  keep open beside the chat (full screen on a phone), marked *Debug*, of everything since you
  last tapped Talk, oldest first, each with its time and seconds since the start: the standing instructions
  and session the call was made with, every item put in the voice's conversation (the brief, its updates,
  the first mate's messages), what you said and what the voice said (the transcripts), tool calls and their
  answers, each message handed to the first mate exactly as its thread got it (with the note only the first
  mate sees), announcements, interruptions, turns and errors. *Hide turns* hides the speech and audio
  markers; *Copy* copies it all as text. It works on the phone, and shows the last session after one ends.

## Settings

- **Voice hooks** are not a setting: each machine runs its own `~/.config/firstmate-voice/hook`, and the
  settings page says which machines have one. See [Voice hooks](#voice-hooks).
- **Voice model:** `gpt-realtime-2.1` (default) or `gpt-realtime-2.1-mini`.
- **Reasoning:** how much it thinks before speaking. Default *low*.
- **Voice:** default *marin*.
- **Turn taking:** how soon it answers once you stop. *High* answers sooner and may cut in on a pause.

## Voice hooks

A voice hook is a script on a machine, run as listening starts and stops, as the voice speaks and as you
talk. Use it to pause your music while you talk to the first mate, turn on a light while it listens, or
duck the volume while it speaks. Each machine runs its own, from one fixed file in its home folder:

```
~/.config/firstmate-voice/hook
```

The file must be executable, and its first line names what runs it. To pause Apple Music for the length of
a session on a Mac:

```sh
mkdir -p ~/.config/firstmate-voice
cat > ~/.config/firstmate-voice/hook <<'EOF'
#!/bin/sh
case "$FIRSTMATE_VOICE_HOOK" in
  listening-started) osascript -e 'tell application "Music" to pause' ;;
  listening-stopped) osascript -e 'tell application "Music" to play' ;;
esac
EOF
chmod +x ~/.config/firstmate-voice/hook
```

Delete the file, or make it not executable, and no hook runs there. There is none until you make one.

- **Only you set it.** No setting, RPC or command in bb sets a hook, reads the file or shows what is in it:
  bb's command line can do anything bb's app can, so a hook kept in bb could be changed by any agent with
  access to `bb`. Under **Voice hooks** on the plugin's settings page, each of bb's machines says only
  whether it has a hook file and whether it can run, and the machine you are on is marked *this machine*.
- **When:** `FIRSTMATE_VOICE_HOOK` says which moment it is, in pairs, so one script handles all six:
  - `listening-started` when a session starts (once OpenAI has taken the call), and `listening-stopped`
    when it ends, however it ends, with the reason in `FIRSTMATE_VOICE_REASON` ("ended by the captain",
    "quiet for ten minutes", "the app stopped answering"…).
  - `speaking-started` when the voice is about to speak, and `speaking-stopped` once it has finished and
    nothing more is on its way: replies back to back, a tool call between them included, share one pair.
    The voice's audio is live and cannot be held back, so `speaking-started` runs at the first sign of a
    spoken reply, usually a fraction of a second before the first word, and the voice does not wait for it.
  - `talking-started` when you start talking, and `talking-stopped` when you stop.

  Each stopped runs after its started has finished, and a session that ends runs the stopped of every open
  pair before `listening-stopped`. A new session's hooks wait for the last one's to finish. Whether the file
  is there is checked when a session starts; a file made during a session runs from the next one.
- **Where it runs:** on the machine whose **bb desktop app** is in the call, not on the machine running
  bb's server. The window finds its machine through the bb host daemon beside the desktop app, so the
  machine must be one of bb's machines. bb's **mobile app** and a **browser tab** run no hooks. macOS and
  Linux only.
- **How it runs:** the file itself, from your home folder, as the user bb's host daemon runs as. Output is
  ignored.
- **Never in the way:** a run gets five seconds and is then stopped, with whatever it started; anything it
  leaves running in the background (`… &`) is stopped as soon as it exits. The call never waits for one,
  and one that fails or is slow changes nothing in the call. Each run is in the debug log: the moment, the
  machine, the exit status and how long it took, never the output.

## Privacy

Audio goes from your device straight to OpenAI. Task titles, project names, what the first mate and its
workers last said (cut short, with links and ids removed) and the first mate's answers go to OpenAI under
the ChatGPT account. No code, diffs or files. What you say is kept in memory and is never written to a log
or a file. The debug log holds it, with everything else the session got and did, in the bb server's memory
until you next tap Talk (or the plugin reloads); only bb's app and bb's command line on your own bb can
read it (no other plugin), and anything
shaped like a credential is removed from it. [Herald](../herald) keeps speaking while a session is live; turn it off if you
hear both.

## Limitations

- Phase 1: no digests of routine crew news, no steering or interrupting workers by voice, no push-to-talk,
  and no fallback for networks that block WebRTC.
- Checked live on the desktop. The phone path was checked in Safari during the design; the bb mobile app's
  own web view has not been.

## License

MIT
