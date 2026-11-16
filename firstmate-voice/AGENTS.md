# AGENTS.md

`firstmate-voice` is FirstMate's real-time voice: the captain talks to the first mate out loud, on the
desktop or on the phone with bb in front. It is option B of the design
(`/Users/ci/repositories/firstmate/data/scout-firstmate-realtime-voice/report.html`): this plugin owns the
audio, the session, the tool policy and the credential, and `firstmate-crew` keeps the authority through
its narrow, caller-gated `voice.v1` API. Phase 1 ("ask and answer", design §13) is what is here: the brief,
asks and answers, and announcements of new captain's calls and of every first-mate message. There are no button
presses by voice (below).

The repository root `AGENTS.md` covers what every plugin here shares. This file holds what is specific to
the voice, the decisions behind phase 1, and the phase 0 decision record.

## Orientation

| File | What it owns |
| --- | --- |
| `server/rpc.ts` | The app-facing RPC handlers, refusing any caller but bb's app. |
| `server.ts` | Wiring only: settings (model, reasoning, voice, turn taking), the app's RPCs (`session.start`, `renew`, `renewed`, `end`, `alive`, `current`, `mate.thread`, `debug.log`, `hooks.list`, `hooks.set`, behind `server/rpc.ts`'s client-only gate), the thread events that make a live session read the brief again, `onDispose`. |
| `server/session.ts` | One live session (`VoiceSessions`): the call, the sideband, event dispatch, the tools, renewal at the hour's cap, the idle end, the app's heartbeat. |
| `server/policy.ts` | The utterance log, one send at a time, rate limits. |
| `server/brief-sync.ts` | Brief → diff → `[firstmate-update]` items, full replacement every 15 updates or 20 minutes, and the events worth announcing. |
| `server/hooks.ts`, `host.ts`, `host/run-hook.ts`, `shared/hooks.ts`, `shared/host-contract.ts`, `app/machine.ts`, `app/hooks-section.tsx` | The voice hooks: each machine's command (kv, by host id), when a session runs it (pairs, lanes, time limits), the host entry that runs it on the window's machine, the window's machine lookup, and the settings section. |
| `server/debug-log.ts`, `app/debug.tsx`, `app/debug-view.ts` | The debug log of the current (or last) session, its client-only `debug.log` RPC, and the debug tab in a thread's side panel, with the request that opens it from where no thread panel is at hand. |
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
- **No other plugin opens or steers a session.** Every app-facing RPC (`server/rpc.ts`) refuses a caller bb
  does not name as a client, before anything runs: another plugin could otherwise spend the subscription
  and speak for the captain through this plugin's allowed identities.
- **Who can reach the RPCs.** bb 0.49 names its app and its command line (`bb plugin rpc call`) the same
  `client`, with nothing else to tell them apart, so `requireApp` admits both: anything that can run `bb`
  against the owner's bb, an agent in a thread included, can read the debug log, set a machine's hook
  command and start a session. The `client` and `hostId` a `session.start` names are claims, not proof.
  What holds: no hook runs until OpenAI has made the call (a real WebRTC offer and the ChatGPT sign-in),
  and a hook runs only on a machine bb lists as active. The same command line can already change any
  plugin's settings (`bb plugin config <id> set`), install a full-trust plugin and open a terminal on any
  machine, so moving the commands into settings would not shut it out. Whether to keep the hook commands
  on this surface is the owner's decision, open as of 2026-11-16 (review pass 1 of
  https://github.com/gpambrozio/bb-plugins/pull/112).
- **A renewal completes on the device's word.** `session.renew` makes the new call; the old call is hung up
  only on `session.renewed`, which the app sends once its new leg connected. Without it the session ends
  within 30 s (`RENEW_ACK_MS`), and the app ends it at once when its leg fails. In the app, each Talk is an
  attempt every await checks, so an End while the microphone prompt or the start is pending leaves that
  attempt to stop its own tracks, close its leg and end its server session. End and a renewal check it again
  after their own RPCs answer: a late End answer or renewal acknowledgement never touches a newer Talk.
- **The token never reaches the app or the log.** The SDP exchange, the sideband and the hangup run on the
  server; `redact` covers every error body; the token is held for one call's life.
- **Transcripts live in memory, never in the log.** The log gets tool names and session events, never
  what anyone said. The renewal recap is the last ten exchanges, in memory.
- **The debug log stays on this bb.** `DebugLog` keeps everything the session got and did (the call's
  session and standing instructions, every item and response it was sent, transcripts, tool calls and
  answers, each send as firstmate-crew worded it, the first mate's messages, interruptions, errors) in the
  server's memory, one session's worth: a new Talk replaces it, a reload forgets it, and it is capped at
  2,000 entries. Only a client reads it (`debug.log`, behind `requireApp`: bb's app, or its command line
  on this bb, never another plugin), the app by polling while the tab
  shows; nothing publishes, stores or logs it. Every text passes `scrub` (bearer headers, JWTs, `ek_` and
  `sk-` keys). Log an event there, not in `bb.log`, when it carries anyone's words.
- **A session always ends.** The app ends it (End, the palette, "goodbye" by voice, the phone leaving the
  screen); the server ends it after ten quiet minutes, when the app's heartbeat stops for 50 s, when the
  sideband cannot be reopened, when a renewal does not come, and on dispose. It hangs up from the server and
  treats a call that already ended as ended. One session at a time: a new Talk takes over.
- **A hook never holds the call up.** Nothing in the call awaits one: the session hands each moment to
  `SessionHooks` and goes on. Runs queue in three lanes (listening, speaking, talking). Each run's process
  group is killed on its machine after 5 s, and at once when its shell exits, so a background child (`… &`)
  never outlives it; the server stops waiting after 10 s. Within a pair the stopped follows its started, and
  the speaking and talking lanes wait for `listening-started`, which runs only once OpenAI has made the
  call. A session that ends, however it ends, closes its open pairs and reserves its `listening-stopped`
  (with the reason) in the listening lane at once, behind those closing hooks, so a session that takes over
  starts its own hooks only after them (`dispose` waits up to 3 s for them). The command runs only on a machine bb lists as active, the one the
  desktop window names (`hookTarget`), and is always the one stored for it. The debug log records the
  moment, the machine, the exit status and the duration of each run; the host entry never reads the
  output, so nothing a command prints can reach the log.
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
- **Every first-mate message is announced, not only answers to a voice ask** (the captain's call,
  2026-11-15). The session announces the brief's last first-mate message whenever its text differs from
  the last one it saw (`noticeMate`): the first brief only sets it, so nothing from before the session is
  said; a turn with no text of its own (a compaction) repeats the old text and is skipped; two turns ending
  between reads are one announcement, of the later, since the brief and `voice.v1.reply` give only the
  last. Each message is its own `[firstmate-reply #n]` item and its announcement names that item. A burst
  that queues (the captain speaking, another announcement playing) goes in order, one sentence each
  (`Announcer.enqueueMate` shortens those still waiting); one already playing is not cut. The answer to a
  voice ask opens "The first mate answered you", any other "From the first mate". All of them count as
  the first mate's reply read aloud in the talk.
- **A card's announcement is a script built from the card** (`callScript`): title, project, pull request,
  hold and button labels from the brief, said word for word, no ref. The model once announced a call
  with "web pull request 42" and buttons lifted from its own instructions' example while the update gave
  no buttons; the instructions now carry no example identifiers (a test checks), and a new card's update
  line lists its project, pull request and buttons.
- **A debug view for tuning the loop** (the owner's call, 2026-11-15). First a full-window overlay; the owner then
  asked for a side panel kept open beside the chat, so it is an action tab of the thread's side panel
  (`DEBUG_TAB`), marked Debug, opened through bb's panel controller from the pill's bug button, the
  palette and the first mate's header menu, and full screen on a phone. The palette and the menu get the
  focused thread's controller. The pill is an app overlay, and an overlay's `experimental_useAppPanel()`
  is bb's default controller, which declines every call (bb 0.49.0: only the thread view, plugin pages and
  the New thread screen provide one). So the pill leaves a request (`debugOpen`) that `DebugOpener`, a
  composer action in each thread view that renders nothing, opens with its thread's controller; with no
  thread in view, the overlay sends it to the first mate's thread and navigates there. Checked in a dev bb:
  the palette and the bug button both opened the tab, at desktop and phone widths. It
  is a poll over a client-only RPC rather than a realtime channel, so nothing leaves the server unasked. For
  the exact text a send relayed, `voice.v1`'s ask and answer now return the message and the agent-only
  note as firstmate-crew sent them (optional fields: an older crew answers without them, and the panel then
  shows the parts the voice sent).
- **Voice hooks** (the owner's call, 2026-11-16, after Herald's speech hooks): one command per machine,
  with `FIRSTMATE_VOICE_HOOK` naming the moment (`listening-`, `speaking-` for the voice, `talking-` for the
  captain, each `started`/`stopped`) and `FIRSTMATE_VOICE_REASON` why listening stopped. The server drives
  them from the call's sideband, which carries the captain's and the voice's speech events as the data
  channel does, so a window that goes away still gets its closing hooks when the session ends. The window
  only names its machine at Talk, as Herald's does (the local host daemon's `/status`, desktop app only).
  Unlike Herald's before hook, `speaking-started` cannot hold speech back: the audio is a live WebRTC
  stream, so it runs at the first sign of a spoken reply (`response.output_item.added` with a message item,
  else `output_audio_buffer.started`), usually some hundreds of milliseconds before the first word, and a
  slower command overlaps the start. `speaking-stopped` waits until the audio has stopped, no response is
  under way and a second has passed quietly, so a tool call between two spoken replies keeps one pair.
  Checked in a dev bb: a Talk that failed at once (no codex-realtime there, so no voice time) ran
  `listening-started` and `listening-stopped` (with "the call could not be made") through the host entry
  on that bb's machine, from the home folder, and both runs showed in the debug tab.
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
