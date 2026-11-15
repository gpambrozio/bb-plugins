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
- **Tells you what changed:** a new call for you on the board, a worker that failed, the first mate waiting
  on a question in its chat, and the first mate's answers to what you asked. It waits for a pause, and stops
  when you talk over it.

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
  and **End**. Saying "goodbye" ends it too.
- A session ends by itself after ten quiet minutes, and is renewed without a break at OpenAI's one-hour
  limit.

## Settings

- **Voice model:** `gpt-realtime-2.1` (default) or `gpt-realtime-2.1-mini`.
- **Reasoning:** how much it thinks before speaking. Default *low*.
- **Voice:** default *marin*.
- **Turn taking:** how soon it answers once you stop. *High* answers sooner and may cut in on a pause.

## Privacy

Audio goes from your device straight to OpenAI. Task titles, project names, what the first mate and its
workers last said (cut short, with links and ids removed) and the first mate's answers go to OpenAI under
the ChatGPT account. No code, diffs or files. What you say is kept in memory for the session only and is
never written to a log. [Herald](../herald) keeps speaking while a session is live; turn it off if you
hear both.

## Limitations

- Phase 1: no digests of routine crew news, no steering or interrupting workers by voice, no push-to-talk,
  and no fallback for networks that block WebRTC.
- Checked live on the desktop. The phone path was checked in Safari during the design; the bb mobile app's
  own web view has not been.

## License

MIT
