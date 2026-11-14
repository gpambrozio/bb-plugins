# AGENTS.md

`firstmate-voice` is, for now, the **phase 0 spike** of a real-time voice front end for FirstMate. The
design is in `/Users/ci/repositories/firstmate/data/scout-firstmate-realtime-voice/report.html`, option B.
Nothing here is released: the plugin is not in `.bb/plugins.json`, its version is `0.0.0` and the package is
`private`. Phase 1 replaces most of this folder.

The repository root `AGENTS.md` covers what every plugin here shares. This file holds the spike's decision
record and what phase 1 must not relearn.

## Orientation

| File | What it owns |
| --- | --- |
| `server/openai.ts` | Plain-Node calls to OpenAI: `/v1/realtime/calls` (SDP exchange), hangup, `client_secrets`, the `?call_id=` sideband and `?model=` sockets, the `reasoning.effort` probe, `redact`. Shared by the plugin and the scripts. |
| `server/credential.ts` | The bearer, from codex-realtime's `realtimeConnection` (this plugin must be on its allow list). |
| `server/calls.ts` | The WebRTC-direct path on the server: SDP exchange, sideband, the `get_time` tool, out-of-band announcements, an event log per call. |
| `server/relay.ts` | The relayed fallback: a ticket-gated plugin WebSocket forwarded to a server-side Realtime socket. |
| `app.tsx`, `app/*` | The spike page (nav panel "Voice spike"): Talk buttons for both paths, beep and Wake Lock checks, and the meters that measure latency. |
| `scripts/live-check-call.ts` | `npm run live-check-call`: the four credential checks. Manual; spends a few seconds of voice time. |
| `scripts/desktop-check.ts` | `npm run desktop-check`: drives the spike page in a dev bb with headless Chromium and a spoken clip as the microphone. |
| `spike-results/` | The raw results quoted below. They hold no token: every error body passes through `redact`. |

## Decision record (phase 0, 2026-11-13, bb 0.49.0)

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
owner's runs through the share (desktop Chrome and iPhone Safari) confirmed this. Keep it as the fallback for
networks that block WebRTC.

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

## What phase 1 should carry over

- Pass `ctx.experimental_signal` to `codex-realtime`'s `realtimeConnection` call, and keep the token in
  server memory only for the call's life.
- The bb build refuses a server import from outside the plugin folder (`server source import escapes the
  plugin directory`), although a local `bb plugin build` accepts it. That is why the credential comes from
  codex-realtime over RPC rather than its module.
- A call ends by itself after 90 s here (`MAX_CALL_MS`) to protect the plan's voice time. Phase 1 needs
  the real session lifecycle: renewal at the 60-minute cap and the idle end.
