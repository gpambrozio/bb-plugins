# AGENTS.md

`firstmate-voice` is FirstMate's real-time voice: the captain talks to the first mate out loud, on the
desktop or on the phone with bb in front. It is option B of the design
(`/Users/ci/repositories/firstmate/data/scout-firstmate-realtime-voice/report.html`): this plugin owns the
audio, the session, the tool policy and the credential, and `firstmate-crew` keeps the authority through
its narrow, caller-gated `voice.v1` API. Phase 1 ("ask and answer", design §13) is what is here: the brief,
asks and answers, confirmed presses, and announcements of new captain's calls and first-mate replies.

The repository root `AGENTS.md` covers what every plugin here shares. This file holds what is specific to
the voice, the decisions behind phase 1, and the phase 0 decision record.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring only: settings (model, reasoning, voice, turn taking), the app's RPCs (`session.start`, `renew`, `end`, `alive`, `current`, `mate.thread`), the thread events that make a live session read the brief again, `onDispose`. |
| `server/session.ts` | One live session (`VoiceSessions`): the call, the sideband, event dispatch, the tools, renewal at the hour's cap, the idle end, the app's heartbeat. |
| `server/policy.ts` | The utterance log, yes and no, the two-phase press (`PressGuard`), one send at a time, rate limits. |
| `server/brief-sync.ts` | Brief → diff → `[firstmate-update]` items, full replacement every 15 updates or 20 minutes, and the events worth announcing. |
| `server/announce.ts` | P1 announcements at gaps, once more when the captain talks over one. |
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

- **The model has no free-text channel into bb.** Asks and answers carry the captain's words copied from the
  call's input transcription (the model names how many of the latest utterances, never the words), and a
  press carries the button's own prompt, which firstmate-crew looks up. The agent-only note on a send is the
  crew's template, not model text. Do not add a tool argument that reaches the first mate as text.
- **Presses are two-phase and checked against the captain's transcript, not the model's claim.**
  `propose_press` returns a server-written read-back; it counts as read back only when the model's own output
  transcript says most of it and that audio then plays to its end (`output_audio_buffer.stopped`; a reply the
  captain talked over, `cleared`, does not count); `confirm_press` needs the captain's first utterance committed after that to be
  a short yes with no negation, within 30 s, on a single-use token, one press in 10 s. firstmate-crew checks
  the card's etag again and refuses tap-only buttons again.
- **Merges, anything destructive, publishing, credentials and settings are never pressed by voice** in phase
  1, read-back or not. firstmate-crew marks them `tapOnly` (a wide word net) and refuses the press; this
  plugin refuses to propose one. The voice may offer to ask the first mate, which answers with a board button.
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
- **Merges by voice:** never, even after a read-back and a yes (above).
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
- **No model words in the ask's note.** The design's agent-only part "says what the voice had just asked"; here
  the note is firstmate-crew's fixed text, so the model has no channel at all.
- **Turn taking** stays `semantic_vad` at `auto`, a setting. The spike measured the end-of-turn wait as the
  largest part of the latency; *high* is the setting to try first.

## What the live run found (2026-11-14, `phase1-results/2026-11-14-e2e-desktop.json`)

One end-to-end run in a dev bb (root `AGENTS.md`), with a real first mate (Claude Code, Sonnet 5.5) and the
voice on the subscription: the greeting named the held merge from the brief; an ask reached the first mate as
`Spoken by the captain through FirstMate voice:` and the first mate's one-word answer was spoken back 13 s
after the captain stopped; a suggestion was read back, confirmed with "Yes." and reached the first mate as
`Pressed by the captain through FirstMate voice:`; "Press merge" was refused as tap-only, and a following
"Yes." sent nothing.

- **OpenAI keeps a call whose page vanished.** A closed headless browser left the sideband open with no
  event for over a minute. That is why the app beats every 15 s (`session.alive`) and the server ends a
  session it has not heard from for 50 s; on the phone it also ends one whose app was suspended.
- **A stand-in microphone needs a noise floor.** A Web Audio stream that falls silent after a clip never let
  the turn detection hear the speech end; `e2e-desktop.ts` mixes in faint noise, as a real room has.
- **The model speaks a preamble before a tool** ("let me set that up"), so the read-back is its own response;
  the press guard matches it there.
- **The press re-check** (`phase1-results/2026-11-14-e2e-desktop-press-recheck.json`), after the guard began
  waiting for the read-back's audio to end: the read-back's audio stopped at 25.8 s, the captain's "Yes." was
  committed at 33.1 s, and the suggestion was pressed; "Press merge" was refused from the brief without a
  proposal. About four minutes of voice time were spent across the phase 1 runs.

## Live checks

Only in a dev bb, never the owner's: install `codex-realtime` (with `firstmate-voice` on its allow list),
`firstmate-crew` (home directory set to a scratch folder) and this plugin; launch a first mate; seed its
backlog with a held item whose actions include a Merge, and a harmless suggestion. Then
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
