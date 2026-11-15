# AGENTS.md

`firstmate-voice` is FirstMate's real-time voice: the captain talks to the first mate out loud, on the
desktop or on the phone with bb in front. It is option B of the design
(`/Users/ci/repositories/firstmate/data/scout-firstmate-realtime-voice/report.html`): this plugin owns the
audio, the session, the tool policy and the credential, and `firstmate-crew` keeps the authority through
its narrow, caller-gated `voice.v1` API. Phase 1 ("ask and answer", design §13) is what is here: the brief,
asks and answers, and announcements of new captain's calls and first-mate replies. There are no button
presses by voice (below).

The repository root `AGENTS.md` covers what every plugin here shares. This file holds what is specific to
the voice, the decisions behind phase 1, and the phase 0 decision record.

## Orientation

| File | What it owns |
| --- | --- |
| `server/rpc.ts` | The app-facing RPC handlers, refusing any caller but bb's app. |
| `server.ts` | Wiring only: settings (model, reasoning, voice, turn taking), the app's RPCs (`session.start`, `renew`, `renewed`, `end`, `alive`, `current`, `mate.thread`, behind `server/rpc.ts`'s app-only gate), the thread events that make a live session read the brief again, `onDispose`. |
| `server/session.ts` | One live session (`VoiceSessions`): the call, the sideband, event dispatch, the tools, renewal at the hour's cap, the idle end, the app's heartbeat. |
| `server/policy.ts` | The utterance log, one send at a time, rate limits. |
| `server/brief-sync.ts` | Brief → diff → `[firstmate-update]` items, full replacement every 15 updates or 20 minutes, and the events worth announcing. |
| `server/announce.ts` | P1 announcements at gaps, once more when the captain talks over one, during the response or later while its audio plays. |
| `server/instructions.ts`, `server/tools.ts` | The standing instructions (design §8's outline) and the tool list with levels. |
| `server/openai-call.ts`, `server/openai-port.ts` | The SDP exchange, hangup and sideband socket (from the spike), and `RealtimePort` over them. |
| `server/credentials.ts`, `server/crew-client.ts` | codex-realtime's `realtimeConnection`; firstmate-crew's `voice.v1`. |
| `server/ports.ts`, `server/testing/fakes.ts` | The ports, and fakes for OpenAI (a sideband a test plays events into), the crew and time. |
| `shared/crew-voice.ts` | A copy of firstmate-crew's `shared/voice.ts`; `shared/crew-voice.test.ts` fails when they differ. |
| `app.tsx`, `app/*` | The pill (an app overlay), the WebRTC leg, the per-window controller, the palette command and the Talk button in the first mate's header. |
| `scripts/live-check-call.ts`, `scripts/probes.ts` | The phase 0 credential checks (`npm run live-check-call`). Spends a few seconds of voice time. |
| `scripts/e2e-desktop.ts` | A live end-to-end run in a dev bb (below). Spends a few minutes of voice time. |
| `phase1-results/`, `spike-results/` | What the live runs recorded. No tokens. |

## Invariants

- **The captain's words are copied, never written; the model's account goes beside them, marked.** An ask or
  an answer carries every segment of the call's input transcription since the last hand-off, joined in order
  (`UtteranceLog.sinceBoundary`), and the model's own account of the request (`request` / `answer`), which
  firstmate-crew puts under its own heading and tells the first mate to check against the words. A hand-off
  is a boundary: a send (through `markUsed`, which spends everything said before it too), or a voice reply
  heard to its end (`output_audio_buffer.stopped` for a response that is not an
  announcement and called no tool, at the moment that response started; a tool's spoken preamble is no
  answer). A send reads the boundary once as it starts, so a reply ending while a transcript is on its way
  cannot drop that transcript. A reply the captain talked over (`cleared`) is no boundary, so a request turn detection split at a pause
  goes whole. The account is the model's only text into bb: never let it stand
  for the captain's words, and add no other tool argument that reaches the first mate as text. The log
  records how many segments and characters went, never the words.
- **The talk goes too, and the voice's lines in it are only context.** Each send also carries the talk
  (`UtteranceLog.talk`): the captain's segments it sends and what the voice said aloud in the same span
  (each response's `response.output_audio_transcript.done`, timed by when the response started), in order,
  a talked-over line marked. It starts at the boundary, so the reply heard to its end that set it is in,
  and stops before the send's own response (its preamble is not part of the talk). A reading of the first
  mate's reply (the reply announcement, tracked by announcement id) since the last send leads when the
  span has none, since that is what a short reply most likely answers. A line goes once: `markUsed` spends
  the voice's lines that started before the send's response. firstmate-crew labels each line, the voice's
  as not the captain's. Added after a live run where "Hold it for now" reached the first mate without the
  reply the voice had just read out, and "it" read as the wrong PR. These lines, like the account, never
  stand for the captain's words.
- **No board button is pressed by voice.** There is no press tool, and `voice.v1` has no press verb; the
  model sees buttons and suggestions by label only. Asked to press one, the voice tells the captain to tap
  it on the board and offers to hand the request to the first mate, which then gets the captain's own words
  like any ask. Merges, anything destructive, publishing, credentials and settings are never the captain's
  word by voice; the first mate answers a spoken request for one with a board button.
- **Only bb's app opens or steers a session.** Every app-facing RPC (`server/rpc.ts`) refuses a caller bb
  does not name as a client, before anything runs: another plugin could otherwise spend the subscription
  and speak for the captain through this plugin's allowed identities.
- **A renewal completes on the device's word.** `session.renew` makes the new call; the old call is hung up
  only on `session.renewed`, which the app sends once its new leg connected. Without it the session ends
  within 30 s (`RENEW_ACK_MS`), and the app ends it at once when its leg fails. In the app, each Talk is an
  attempt every await checks, so an End while the microphone prompt or the start is pending leaves that
  attempt to stop its own tracks, close its leg and end its server session. End and a renewal check it again
  after their own RPCs answer: a late End answer or renewal acknowledgement never touches a newer Talk.
- **The token never reaches the app or the log.** The SDP exchange, the sideband and the hangup run on the
  server; `redact` covers every error body; the token is held for one call's life.
- **Transcripts live in memory for the session only.** The log gets tool names and session events, never
  what anyone said. The renewal recap is the last ten exchanges, in memory.
- **A session always ends.** The app ends it (End, the palette, "goodbye" by voice, the phone leaving the
  screen); the server ends it after ten quiet minutes, when the app's heartbeat stops for 50 s, when the
  sideband cannot be reopened, when a renewal does not come, and on dispose. It hangs up from the server and
  treats a call that already ended as ended. One session at a time: a new Talk takes over.
- **Herald is left alone.** Both may speak the same news while a session is live; the captain turns Herald
  off by hand when that matters (design §10, phase 2).

## Decisions for phase 1 (the design's open questions, the safe choice each time)

- **Credential:** the ChatGPT subscription through codex-realtime, which must list `firstmate-voice` in
  *Plugins that may use the sign-in*. No API key path.
- **Merges by voice:** never (above).
- **No presses in phase 1** (the captain's call, 2026-11-14, after four review passes of a read-back-and-yes
  press). Deciding which button prompts were safe to press on a spoken yes kept leaving holes: a deny list
  missed wordings, a bounded set of shapes still let a "report" publish or a decision card change a
  setting, and number words in a read-back made different labels match. The captain hears only a label,
  and a prompt is free text, so any press needs a design that does not judge free text; the history of
  https://github.com/gpambrozio/bb-plugins/pull/112 (`PressGuard`, `saidReadBack`, `tapOnlyReason`) holds the removed code.
- **Transcripts:** kept for the session only, not stored.
- **Standby:** none; ten quiet minutes end the session.
- **Herald:** no stand-down.
- **Release:** private. The plugin is in `.bb/plugins.json` so CI checks and tags it, and nothing is
  submitted to the marketplace. The id `firstmate-voice` was free there on 2026-11-14 (no
  `entries/firstmate-voice.json`; `firstmate.json`, `firstmate-crew.json`, `voice-mode.json` and
  `voice-input.json` exist) and is not a bb built-in.
- **No relay in phase 1.** The design kept the relayed transport for a token refused on `/calls`, which phase 0
  ruled out, and the iPhone ran WebRTC directly. It stays on the spike branch for networks that block WebRTC.
- **No `quiet` tool.** Every phase 1 announcement is P1, which quiet would not hold; it comes with phase 2's
  digests.
- **The model's account goes with the captain's words** (the captain's call, 2026-11-14, after a long request
  reached the first mate as its last segment only: turn detection split it at a pause and the model, asked
  for "how many of the latest utterances, usually 1", said one). The plugin sends every segment since the
  last hand-off, and the model's account of the request beside them, so the first mate has both the context
  the model heard and the words to check it against. The talk (the voice's own spoken lines beside the
  captain's, in order) was added on the captain's call of 2026-11-15, after "Hold it for now" went without
  the reply it answered.
- **Turn taking** stays `semantic_vad` at `auto`, a setting. The spike measured the end-of-turn wait as the
  largest part of the latency; *high* is the setting to try first.

## What the live run found (2026-11-14, `phase1-results/2026-11-14-e2e-desktop.json`)

One end-to-end run in a dev bb (root `AGENTS.md`), with a real first mate (Claude Code, Sonnet 5.5) and the
voice on the subscription: the greeting named the held merge from the brief; an ask reached the first mate as
`Spoken by the captain through FirstMate voice:` and the first mate's one-word answer was spoken back 13 s
after the captain stopped. The run also checked the voice press, since removed (above).

- **OpenAI keeps a call whose page vanished.** A closed headless browser left the sideband open with no
  event for over a minute. That is why the app beats every 15 s (`session.alive`) and the server ends a
  session it has not heard from for 50 s; on the phone it also ends one whose app was suspended.
- **A stand-in microphone needs a noise floor.** A Web Audio stream that falls silent after a clip never let
  the turn detection hear the speech end; `e2e-desktop.ts` mixes in faint noise, as a real room has.
- **The model speaks a preamble before a tool** ("let me set that up"), which is why a tool's response is
  never a boundary. About four minutes of voice time were spent across the phase 1 runs.

## The split-request fix, live (2026-11-14, `phase1-results/2026-11-14-e2e-split-ask.json`)

`e2e-desktop.ts --split-only` says one request in two clips: "Ask the first mate to reply with the word
apple, and then" and, after a short pause, "the word banana after it. Nothing else." Turn detection ended the
turn at the pause (committed at 17.6 s) and the voice began a reply; the second clip talked over it
(`cleared` at 19.0 s, so no boundary), was committed at 23.0 s, and the one `ask_first_mate` sent both
segments joined, with the model's account beside them. The first mate answered "Apple banana". Before the
fix, the model's "1" would have sent only the second clip, as it did for the captain.

- **A first breath that sounds finished still goes on its own.** An earlier run, with a complete sentence
  ("…write the word apple in its reply.") and a 3.3 s pause, had the model hand over before the second clip
  started; the second half would be a send of its own. Nothing on the server can wait for words not yet
  said; the instructions ask the model to wait when what it heard sounds unfinished.
- **The model quoted the transcript inside its account** on that run, because the tool's text said the words
  "go beside it". It now says not to quote them; the second run's account was clean.

## Live checks

Only in a dev bb, never the owner's: install `codex-realtime` (with `firstmate-voice` on its allow list),
`firstmate-crew` (home directory set to a scratch folder) and this plugin; launch a first mate; seed its
backlog with a held item whose actions include a Merge. Then
`node scripts/e2e-desktop.ts --mate <thread id> --bb <dev-bb CLI wrapper>`. Each run spends one to two minutes
of voice time; the script ends the session even when a step fails.

## Phase 0 decision record (2026-11-13, bb 0.49.0)

The spike's own code is on the `fm/firstmate-voice-spike` branch (66229c3); `spike-results/` here holds its raw
results, which hold no token (every error body passed through `redact`).

### Credential: the ChatGPT subscription, no API key

The Codex login's access token (read-only, never refreshed) was accepted everywhere phase 1 needs
(`spike-results/2026-11-13-live-check-call.json`):

| Check | Result |
| --- | --- |
| `POST /v1/realtime/calls`, multipart `sdp` + `session`, offer from the dev-bb page | **accepted**, 201, `Location: /v1/realtime/calls/rtc_…`, 1.7 KB SDP answer; the peer connected in 0.2 s |
| Sideband `wss://api.openai.com/v1/realtime?call_id=rtc_…` | **accepted**; `session.update` applied (`session.updated`) |
| `POST /v1/realtime/client_secrets` | **accepted**, 200, an `ek_` secret valid for the 60 s asked; that secret posting raw SDP to `/v1/realtime/calls` was accepted too (201) |
| `reasoning.effort` (`session.update` on a `?model=gpt-realtime-2.1` socket) | `minimal`, `low`, `medium`, `high`, `xhigh` **accepted** and echoed; `bogus` refused: `invalid_value`, "Supported values are: 'minimal', 'low', 'medium', 'high', and 'xhigh'.", `param: session.reasoning.effort` |
| `POST /v1/realtime/calls/{id}/hangup` | **accepted**, 200, on a live call |

The path is still undocumented for this token, and OpenAI can close it. codex-realtime's rules carry over
unchanged: never refresh, never write `auth.json`, never log the token, and hand it only to allowed plugins.

### Transport: WebRTC direct with a sideband; the relay stays as the fallback

Both paths work on desktop, with the same latency. WebRTC keeps audio off the Mac and off Connect, and the
sideband gives the server everything the design needs:

- The sideband receives **every** server event of the call: transcription deltas and `completed`,
  `output_audio_buffer.started`/`stopped`, function calls, `rate_limits.updated`. Its first event is
  `session.updated` (to its own update), not `session.created`.
- A tool declared from the sideband (`session.update` with `tools`) is called by the model, and the
  server answers on the sideband: arguments done → output sent in 0–4 ms → next `response.created` in
  100–120 ms. The model speaks a preamble first ("One moment while I check the current time.").
- An out-of-band `response.create` (`conversation: "none"`, `metadata.kind`, `input: []`) sent on the
  sideband is **spoken into the WebRTC call**: 78 ms to `response.created`, 875 ms to
  `output_audio_buffer.started`. That is the announcement mechanism for phase 1.
- When the page closes its peer, the call ends at once: the sideband closes with 1006, and a later
  `hangup` answers 404 `call_id_not_found` after about 5 s. Phase 1 should hang up from the server
  first, and treat 404 as "already ended".
- The SDP exchange through the bb server took 0.27–0.56 s, the peer connected 0.2 s later, and the data
  channel opened 0.15 s after that.

The relay (`server/relay.ts`) is ticket-gated rather than `auth: "local"`: the page asks for a one-time
ticket over RPC (bb authenticates RPC) and opens `…/http/relay?ticket=…` on an `auth: "none"` route. It
therefore works from any origin bb serves the app on, a Connect port share included. Both of the
owner's runs through the share (desktop Chrome and iPhone Safari) confirmed this. Phase 1 does not ship it (below);
it stays on the spike branch as the fallback for networks that block WebRTC.

### Default model: `gpt-realtime-2.1`, reasoning `low`

The perceived latency is from the end of speech on the microphone to the first reply sound, measured in
the page. Desktop runs used headless Chromium 151 (Electron's engine) against the dev bb on this Mac:

| Path, model, effort | Turn 1 (greeting) | Turn 2 (time; tool, preamble first) | VAD end-of-turn wait | `speech_stopped` → heard |
| --- | --- | --- | --- | --- |
| WebRTC, 2.1, low (run 1) | 1.89 s | 1.50 s | 0.84 / 0.88 s | 1.05 / 0.62 s |
| WebRTC, 2.1, low (run 3) | 2.46 s | 1.46 s | 1.47 / 0.82 s | 1.00 / 0.64 s |
| WebRTC, 2.1, minimal | 3.14 s | 2.66 s | 1.53 / 1.20 s | 1.61 / 1.46 s |
| WebRTC, 2.1-mini, low | 1.70 s | 1.60 s | 0.82 / 0.90 s | 0.88 / 0.70 s |
| Relay, 2.1, low (run 2) | 1.92 s | 1.68 s | 0.94 / 0.90 s | 0.98 / 0.78 s |
| Relay, 2.1, low (run 6) | 2.70 s | 1.58 s | 1.85 / 0.89 s | 0.86 / 0.69 s |

- With n = 2 per setting, the noise is as large as the differences. `minimal` was not faster in this sample.
  `mini` was a little faster and is the cost setting the design already planned.
- The largest and most variable part is `semantic_vad`'s wait for the end of the turn (0.8–1.8 s). Phase 1
  should try `eagerness: "high"` (or `server_vad`) before it tunes anything else.

### Clients

- **Desktop (Chromium):** `getUserMedia` 23–41 ms after the tap; the reply track played through an
  `<audio>` element that was started after several awaits, so the tap's activation lasted long enough.
  Electron itself was not run: the owner's bb app must not be touched, and Electron shares the engine.
- **The owner, through Connect (2026-11-14 02:31 UTC):** `spike-results/owner-1-remote-chrome-via-connect.json`,
  with the transcripts removed. The saved user agent is **desktop Chrome 157 on macOS** (`platform:
  "browser"`), not a phone. The run opened the Connect port share (`https://…--48886.getbb.app`) with a
  real microphone, and the owner answered "Yes, clearly" to hearing the replies.
  - The beep played through both Web Audio and an `<audio>` element. Wake Lock was granted.
  - WebRTC: `getUserMedia` took 11.5 s, which was the permission prompt. The SDP exchange through Connect
    and the bb server took 0.67 s, the peer connected 0.46 s later, and the data channel opened after 0.16 s.
  - Relay: the socket opened through Connect in 0.54 s, and the upstream 0.78 s after that.
  - `speech_stopped` → reply heard: 0.93 and 0.90 s on WebRTC, 0.92 s on the relay. That is the same as on
    loopback, so Connect added no latency that shows on the relay.
  - The page-measured turns (WebRTC 0.72 and 3.36 s, relay 2.32 s) mix in barge-in and room noise, since a
    person spoke over the reply once. Read the VAD-side numbers above instead.
- **The owner's iPhone, through Connect (2026-11-14 04:28 UTC):** `spike-results/owner-2-iphone-safari-via-connect.json`,
  with the transcripts removed. The saved user agent is **iPhone Mobile Safari** (`iPhone; CPU iPhone OS 18_7`,
  `Version/27.2 Mobile/15E148 Safari`; Safari freezes the OS part, so the iOS version is not in it) with
  `platform: "browser"`: Safari itself, not the bb app's WebView. The page shows the user agent from this run on.
  - Everything works in iPhone WebKit: `getUserMedia`, `RTCPeerConnection`, the data channel, Web Audio
    (`running`) and an `<audio>` element after a tap, the reply track through an `<audio>` element started after
    several awaits, and Wake Lock (granted, released). The owner answered "Yes, clearly" to hearing the replies.
  - WebRTC: `getUserMedia` took 2.8 s, which was the permission prompt. The SDP exchange through Connect and the
    bb server took 0.74 s (OpenAI's part 0.52 s), the peer connected 0.56 s later, and the data channel opened
    after 0.20 s.
  - WebRTC turn (the time question, tool with a preamble): 1.99 s from the end of speech to the first reply
    sound; VAD wait 0.97 s; `speech_stopped` → heard 1.02 s. The sideband answered the tool in 3 ms, with the
    next `response.created` 101 ms later.
  - The announcement began playing 0.84 s after it was sent, but the 25 s cap ended the call 31 ms later.
  - Relay: the socket opened through Connect in 0.71 s, the upstream 0.92 s later; the microphone (already
    granted) in 0.39 s, with a 48 kHz `AudioContext`. `speech_stopped` → heard was 0.51 s, but the page-measured
    turn was 4.16 s because the VAD waited 3.65 s for the end of the turn (room noise or a trailing word; one
    sample). The relay's tool answer worked too.
  - So the phone needs no fallback for WebRTC or the microphone. Phase 1 can make WebRTC direct the only path
    on the phone. The relay is still a fallback for networks that block WebRTC.
  - **Still not covered:** the bb mobile app's own WebView, which would need the plugin in the owner's bb, and
    a screen that locks during a call.
