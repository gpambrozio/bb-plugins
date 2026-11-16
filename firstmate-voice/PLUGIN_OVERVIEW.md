Talk to your FirstMate first mate out loud. Ask what needs you and hear the answer from the board at once, hand it work in your own words, and hear its replies when its turn ends, on the desktop or on your phone with bb in front.

## What you get

- **Answers from the board.** "What needs me?", "what's running?", "what did the review worker say?" are answered at once, without waking the first mate.
- **Your own words, with the voice's account beside them.** Anything else goes to the first mate exactly as transcribed, all you said since the last hand-off, marked as spoken, with the voice's account of what you asked and what it said aloud to you in that time, marked as its own, so a short "hold it" arrives with what "it" was. The first mate checks one against the other, and its answer is read back to you.
- **Buttons stay a tap on the board.** The voice names a card's buttons but never presses one; asked to, it offers to pass your request to the first mate in your own words.
- **Never a merge by voice.** Merges, destructive actions, publishing, credentials and settings are never your word by voice.
- **News when it matters.** A new call for you, named as the board names it, a failed worker, the first mate waiting on a question, and every message the first mate posts while you talk, first sentence first, spoken at the next pause.

## How it works

Audio goes from your device to OpenAI's Realtime voice model over WebRTC. The bb server makes the call and holds a side channel to it for the board, the tools and the announcements, so no credential reaches the app. The first mate stays in charge: the voice reads the board and passes your words on, and every button is yours to tap.

## Requirements

- bb 0.49 or newer, with FirstMate Crew 0.11 or newer and a first mate aboard.
- The codex-realtime plugin and a `codex login` on the bb server's machine: it uses your ChatGPT subscription, in a way OpenAI does not document and can stop. Voice time counts against your plan.
- A microphone; on a phone, bb in front.

## Good to know

- What you say is kept in memory and never logged.
- A debug view, from the command palette or the first mate's menu, shows the last session step by step (instructions, transcripts, tool calls, messages to and from the first mate, errors) for tuning; it stays on your bb until you next talk.
- Voice hooks: a script you put at `~/.config/firstmate-voice/hook` on a machine runs there as listening starts and stops, as the voice speaks and as you talk, to pause music or dim a light. Nothing in bb can set it. It gets five seconds and never holds the call up.
- Task titles, workers' last words and the first mate's answers go to OpenAI.
- A session ends after ten quiet minutes.
