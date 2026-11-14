Talk to your FirstMate first mate out loud. Ask what needs you and hear the answer from the board at once, hand it work in your own words, hear its replies when its turn ends, and press its buttons with a spoken yes after a read-back, on the desktop or on your phone with bb in front.

## What you get

- **Answers from the board.** "What needs me?", "what's running?", "what did the review worker say?" are answered at once, without waking the first mate.
- **Your own words, never a paraphrase.** Anything else goes to the first mate exactly as transcribed, marked as spoken, and its answer is read back to you.
- **Buttons by voice, with a read-back.** A card's button or a suggestion is pressed only after it is read back and you say a plain yes.
- **Never a merge by voice.** Merges, destructive actions, publishing, credentials and settings stay a tap on the board.
- **News when it matters.** A new call for you, a failed worker, or the first mate waiting on a question, spoken at the next pause.

## How it works

Audio goes from your device to OpenAI's Realtime voice model over WebRTC. The bb server makes the call and holds a side channel to it for the board, the tools and the announcements, so no credential reaches the app. The first mate stays in charge: FirstMate decides what a button sends and checks the board has not changed since the read-back.

## Requirements

- bb 0.49 or newer, with FirstMate Crew 0.11 or newer and a first mate aboard.
- The codex-realtime plugin and a `codex login` on the bb server's machine: it uses your ChatGPT subscription, in a way OpenAI does not document and can stop. Voice time counts against your plan.
- A microphone; on a phone, bb in front.

## Good to know

- What you say is kept for the session only and never logged.
- Task titles, workers' last words and the first mate's answers go to OpenAI.
- A session ends after ten quiet minutes.
