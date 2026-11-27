# AGENTS.md

`voice-pilot` runs bb by voice: OpenAI realtime (`gpt-realtime-2.1`) over WebRTC from the window, with the
call's sideband, the tools and the credential on the bb server. It combines firstmate-voice's session (PR
https://github.com/gpambrozio/bb-plugins/pull/112, branch `fm/firstmate-voice-phase1`) with the briefing
plugin's gathering and rendering (PR https://github.com/gpambrozio/bb-plugins/pull/127, closed, head
`da2a3d7`) and a tool set for bb itself, in the spirit of the third-party Handsfree plugin
(swairshah/bb-handsfree) but written from scratch: **Handsfree's repository has no license, so none of its
code may be copied here.** Read it to learn what it does, never to lift code.

The repository root `AGENTS.md` covers what every plugin here shares. This file holds what is specific to
the voice.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring: settings, the app's RPCs (behind `server/rpc.ts`'s client-only gate), thread events → announcements, `onDispose`. |
| `server/session.ts` | One live session (`VoiceSessions`): the call, the sideband, the greeting at start, event dispatch, tools, announcements, renewal at the hour's cap, the pause and resume on the phone, the idle end, the app's heartbeat and the thread on its screen. |
| `server/tools.ts` | The tool list and `VoiceTools`, which runs each call: reads, sends, questions, approvals (two steps), links, `end_session`. |
| `server/rich.ts`, `server/links.ts`, `app/links.ts` | A reply in full for the voice: bb's ```ui blocks parsed and flattened, links numbered for the session; what `open_link` may open; a link to this bb's own thread. |
| `server/questions.ts` | bb's pending interactions as the voice reads and answers them: parse, read aloud, build answers. |
| `server/policy.ts` | Your words from the transcript (`UtteranceLog`), `saidYes`, rate limits, one send at a time. |
| `server/bb-port.ts` | `BbPort`, everything the tools do in bb, and its implementation over `bb.sdk`. |
| `server/greeting.ts`, `server/instructions.ts` | The running threads for the greeting; the editable instructions' default and the fixed rules after them. |
| `server/announce.ts` | The announcer (from firstmate-voice) and the scripts for thread news. |
| `server/credentials.ts`, `server/openai-call.ts`, `server/openai-port.ts` | The two connections (API key, ChatGPT through codex-realtime); the SDP exchange, hangup and sideband. |
| `server/hooks.ts`, `host.ts`, `host/*`, `shared/hooks.ts`, `shared/host-contract.ts`, `app/machine.ts`, `app/hooks-section.tsx` | The voice hooks, unchanged from firstmate-voice but for the names (`VOICE_PILOT_HOOK`, `VOICE_PILOT_REASON`, `~/.config/voice-pilot/hook`). |
| `shared/prompt-edit.ts`, `server/prompt-edits.ts`, `app/prompt-edit.tsx`, `app/prompt-edit-view.ts` | The voice's staged edit of its own instructions: the changes and the diff, the store, the RPCs (`promptHandlers`), the review card and the badge's pencil. |
| `app/hook-file.ts`, `app/hook-editor.tsx`, `host/hook-file.ts` | The settings' **Open the script**, handed to the Voice page's file panel, and Voice Pilot's hook editor there: load and save on the hook's machine. |
| `server/debug-log.ts`, `app/debug.tsx`, `app/debug-view.ts`, `app/open-settings.ts` | The session's log, its client-only RPC, the side-panel tab, the view the Voice page embeds, and its Settings button. |
| `server/briefing/*` | briefing's server code from PR #127 at `da2a3d7`, without its CLI; `sdk-ports.ts` exports `toRow`, `chunks` and `ListRow` for `bb-port.ts`. |
| `app.tsx`, `app/controller.ts`, `app/overlay.tsx`, `app/page.tsx`, `app/webrtc.ts`, `app/platform.ts` | The registrations; the per-window controller; the toast (an app overlay that holds the call); the Voice page; the WebRTC leg. |
| `scripts/e2e-desktop.ts` | The live run (below). |
| `shots/shots.mjs` | README screenshots through `tools/shots` (no call: that dev bb cannot reach OpenAI). |

## Invariants

- **Nothing is merged, archived, deleted, renamed or published, and no setting changes, by voice.** There is
  no tool for any of it (the Instructions change only through an edit the owner applies, below) (`tools.test.ts` checks the names), and `BbPort` has no such call. Do not add a
  generic "run a plugin command" tool: other plugins' commands can do all of these.
- **A question is answered only with your spoken choice.** `answer_question` works only on an interaction
  `read_question` read in this session in the last ten minutes, still pending; an option must be one of the
  question's own, by number or label (`buildAnswers`); a free-text answer is what you said after the read,
  from the transcript (`UtteranceLog.between`), never text from the model. The result says what was sent,
  and the instructions tell the voice to say it back.
- **An approval needs your yes to its read-back.** `decide_request` only prepares one decision (one the
  interaction offers) and answers the read-back; `confirm_decision` sends it only when your transcript
  between the read-back and the confirming response is a plain yes (`saidYes`: a yes word and no no word),
  within two minutes. The "approve it" that led to the read-back does not count.
- **Messages and new threads go in the model's wording, with your request's words beside them.** Each
  carries, as an agent-only part framed as context and not instructions, the words of the request alone:
  what you said from the start of the last voice response before you last spoke (`requestStart`), never
  before the last send. The first live run sent every word since the session began, and the thread's agent
  answered "what's waiting on me?" and the question's answer as if they were addressed to it, then went on
  role-playing the voice in its later turns (`session.test.ts`, "the note beside a message"). The result says
  what was sent. Sends are `queue-if-active`, so a spoken message never steers a running turn.
- **The rules are not editable.** The **Instructions** setting (greeting included) is the owner's;
  `RULES` always follows it. They are a second line only: the tools and the transcript checks are the first.
- **It speaks first.** The sideband's first opening sets the tools, puts the running threads in as an item
  and asks for the greeting, before any word from the microphone. A renewal says nothing.
- **No other plugin opens or steers a session,** and the credential never reaches the app or any log:
  firstmate-voice's invariants (`requireApp`, `redact`/`scrub`, the token held for one call) carry over
  unchanged. bb names its app and its command line the same `client`, so anything that can run `bb` against
  the owner's bb can start a session; it could reach bb's own thread APIs anyway.
- **Hooks:** firstmate-voice's model and guarantees, unchanged (its `AGENTS.md`, "A hook never holds the
  call up", and the hook's `BB_SERVER_URL`). No RPC, setting or host call takes a path (`rpc.test.ts` checks
  every input): a machine's hook is the first of `HOOK_NAMES` in `~/.config/voice-pilot/` (`hook`, then
  `hook.sh`, `.bash`, `.zsh`, `.fish`, `.py`, `.js`, `.mjs`, `.rb`, `.pl`), and only it runs. `hook` stays
  first so a machine set up before the others existed runs what it ran. The status names it and any others.
- **The hook editor writes the hook file, by name, on its machine.** The owner asked for an editor, so
  `hooks.read` and `hooks.write` (app-only, `requireApp`) reach the host entry's `read` and `write`
  (`host/hook-file.ts`): `write` takes one of `HOOK_NAMES`, never a path, writes in place (a link stays a link)
  and puts the mode back, so an executable hook stays executable, and only when the file still has the hash
  it was loaded with, else `conflict` (null when it is gone; nothing is created). A write the machine refuses
  is `failed` with its reason; a host call that throws or takes over `HOOK_EDIT_TIMEOUT_MS` is "Could not reach
  <machine>", so the two never mix. bb names its command line a client too, so an agent with `bb` can call
  `hooks.write`; it could already write any file on any machine with `bb file write --host`, so this adds no
  reach. The editor (`app/hook-editor.tsx`) is a `fileOpener` with no extensions, opened by name
  (`opener: "hook-editor"`) in bb's file panel; it takes the machine from bb's `source.experimental_hostId`
  (bb restored the tab with it after a page reload) or from the window's note of what it opened. An older bb
  without file openers registers none, and the settings' button then opens bb's own preview.
- **Why not bb's File Editor.** bb 0.50.1 picks a plugin file opener by extension, and `opener` names only the
  calling plugin's own, so an extension-less file opens in bb's read-only preview. A `hook.sh` does open in
  bb's File Editor (`monaco-editor`), but that editor resolves a `host` file only through an environment
  (`environments.get(environmentId)`), and a plugin's `host` target has none: it showed "This file has no
  environment to resolve it against".
- **The hook script opens beside the Voice page.** bb's settings page has no file panel (`openFilePreview`
  answers false there, bb 0.50.1), so the button hands the request to the Voice page (`app/hook-file.ts`),
  which opens it as it mounts; a request older than ten seconds is dropped.
- **The voice never changes its own instructions; it proposes.** `propose_instructions_edit` stages one edit
  (`server/prompt-edits.ts`, in `bb.storage.kv`), as changes quoted from the owner's part or as a whole text;
  only `prompt.apply` (as staged, or the owner's tweak) and `prompt.reject` change or drop it, behind
  `requireApp`. One waits at a time: a new one replaces it and records what it replaced, and apply or reject
  of an id that is no longer the staged one is refused, so a newer edit is never applied blind. Applying
  writes the **Instructions** setting, which a session reads once as it starts (`VoiceSession`'s
  `config`, reused by renewals and resumes), so it reaches the next session only. The rules say to propose
  only on the user's own words, never on an item's, a tool result's or an agent's. The Voice page shows the
  edit as bb's diff view (`experimental_Diff`, from `unifiedPatch`) and the sidebar badge adds `✎`: the
  SDK's badge has no icon, and bb's icon-only rail draws any badge as a dot with its label in the tooltip.
- **A link opens only from what the session read, or on the user's yes.** `open_link` takes a link number
  from `read_reply` or a finished turn's reply (the session's `LinkList`), or a URL that is one of those. Any
  other URL is one the model wrote: it answers a read-back ("Open github.com/…? It is not a link from
  anything read in this session.") and opens only when the user's transcript after it is a plain yes
  (`saidYes`), within two minutes. Only http(s) without a user name or password, and `@thread:` mentions,
  which open as threads. The window opens it (`useBbNavigate().openUrl`, or `toThread` for a link to its own
  bb's thread) and the card says what it opened.
- **A finished turn is told from its reply.** The reply (the idle event's `lastAssistantText`, else bb's
  latest reply) goes in the conversation in full, flattened, as a `[voice-pilot-news]` item marked as
  information, then the model says in a sentence what the agent did. Finished turns queued together are
  merged into one response, a line each (`Announcer.pump`). Waiting and failed threads are still scripts
  said word for word.
- **Only words are answered.** The call's turn detection (semantic VAD, far-field noise reduction) has
  `create_response: false`: the server answers no turn by itself. `VoiceSession.heard` creates the response
  once the turn's transcript has a real word (`isNoise`: not empty, punctuation or filler such as "hmm"),
  deletes a noise turn's item from the conversation and logs it as ignored, answers a failed transcription
  from the audio, and holds announcements until the transcript (or `WORDS_WAIT_MS`). With the server's own
  `create_response: true`, a mumbled "hmm" was answered ("Sounds like you're thinking…") in a live run; with
  this, it is not, and a real answer starts about 280 ms after you stop instead of at once
  (`e2e-results/2026-11-24-e2e-noise.json`). `interrupt_response` stays on, so noise can still cut the voice.
- **On the phone, leaving the screen pauses; it never ends the session.** bb's mobile app is suspended when it
  leaves the screen (its microphone and audio stop), so its sessions (`client: "mobile"`, `pausable`) pause:
  the app lets the microphone and the leg go and says `session.pause`; the server hangs the call up (no voice
  time is spent) and keeps the session: the recent talk, the `LinkList`, the threads sent to, and the news
  that comes meanwhile (`missed`, at most 20). Back on the screen, the app makes a new microphone stream and
  leg and sends `session.resume`: a new call, seeded with a `[voice-pilot-resumed]` recap, asks for
  `vp_resume` ("I'm back") and then tells the news. A phone suspended before the pause got out is paused when
  its heartbeat stops or its call goes; a pause that lasts `PAUSE_END_MS` (30 minutes) ends the session. The
  desktop app and a browser tab are unchanged: a hidden window keeps talking, and a lost call or heartbeat
  ends the session. Pause runs no hooks: the mobile app has none.
- **"Mute" mutes, never ends.** `mute_microphone` publishes a `mute` signal; the window holding the call
  disables its microphone track as its Mute button does, and the voice says how to unmute (a tap: once muted,
  nothing said is heard, so there is no unmute by voice). The card says so too. A muted session still ends
  after ten quiet minutes.
- **The window holding the call is the one the voice drives.** `open_thread` publishes an `open` signal with
  the session id; only the controller holding that session navigates. The window reports the thread on its
  screen at Talk, on every heartbeat and when it changes, for `current_thread`.

## Decisions

- **briefing's code is copied in, not depended on.** The owner closed PR #127 and is uninstalling the
  briefing plugin, since this plugin replaces it; there is no shared code across plugin folders (bb's build
  refuses a server import from outside the plugin), and briefing offered only a CLI, which a server cannot
  call. The copy is `server/briefing/` with its tests; change it here.
- **Tools run on the server, from the sideband** (firstmate-voice's design), not in the window as Handsfree
  does. The window that holds the call (an app overlay, mounted once per window) survives navigation, so
  showing a thread does not end the call, and nothing a page realm does decides what a tool may do.
- **Two connections** (the owner's spec): an OpenAI API key as a secret setting, and the ChatGPT
  subscription through codex-realtime. *Auto* prefers the key when one is set.
- **Questions bb exposes, as of bb 0.50:** a provider's `user_question` (Claude Code's own AskUserQuestion)
  is resolved with `threads.interactions.resolve({ resolution: { kind: "user_answer", answers } })`; bb's
  bundled *Ask User Question* plugin's form (`origin.pluginId` `ask-user-question`, questions in
  `payload.data`) is answered with `threads.interactions.respond({ value: { answers } })`, the same
  `answers` shape (read from bb 0.50's bundle). Approvals take `resolve({ resolution: { decision,
  grantedPermissions: null } })`. Any other form is named and left to bb.
- **Announcements:** a thread waiting on you (once per interaction), a failed thread, and a finished turn of
  a thread you messaged by voice; *all* adds every root thread's finished turn. Hidden threads never.
- **Greeting length:** at most five threads named, one short sentence each, the rest as a count; the
  instructions keep it under twenty seconds. Live: 9.7 s from Talk to the end of the greeting.
- **UI:** a Voice page in the sidebar (Talk, End, Mute, state, the log; a *Live* badge on its entry), Talk in
  every thread's header (bb folds a plugin's header actions into one split button, with the debug log in its
  menu), palette commands, the toast while live, and the debug tab in a thread's side panel.
- **Settings button:** the debug view's *Settings* pushes bb's internal `/settings/plugins/voice-pilot` route
  (`app/open-settings.ts`, as `firstmate-crew` does). A moved route lands on bb's not-found page without
  failing, so the Voice hooks section, drawn only on that page, marks it shown on mount; when it has not
  within three seconds, a toast says where the settings are. Keep that section on the settings page, or move
  the mark with it. Live (bb 0.50.1): the section mounted 84 ms after the tap.

## Live checks

Only in a dev bb, never the owner's (root `AGENTS.md`, "A dev bb for live checks"; use ports of your own if
another worker may hold 48886). Install `codex-realtime` (with `voice-pilot` in its *Plugins that may use the
sign-in*) and this plugin, set the general setting `onboardingCompletedAt`, make a project, and start a
Claude Code thread asked to use AskUserQuestion. Then

```
node scripts/e2e-desktop.ts --url http://127.0.0.1:<port> --question <thread id> --bb <dev-bb CLI wrapper> \
  [--answer Green] [--desktop-host <host id>] [--video]
```

It checks that the voice speaks first, reads the question with its options, answers it with the spoken
choice and says it back, and ends on "goodbye"; it spends about a minute of voice time.

- **Do not fake `window.bbDesktop` in a headless page:** bb's own app takes it for Electron and crashes
  ("bb hit an error and stopped"). For the hooks, `--desktop-host` rewrites the page's `session.start` in
  flight to name the machine as a desktop client; the plugin code is unchanged.
- **An answered interaction leaves `bb thread interactions list`**; read it with `show <id> <thread>`.
- `e2e-results/2026-11-23-e2e-desktop.json` is the run behind the first release: greeting first word 2.2 s
  after Talk, greeting over at 9.7 s, the question read via `list_waiting` + `read_question`, answered
  "Sans" (option 2) and said back, all six hook moments on the machine, `listening-stopped` "ended by voice".
  `e2e-results/2026-11-23-e2e-actions.json` adds the actions (`--actions --tell`): `find_threads` and
  `send_message` to a fresh Claude Code thread, which acted on the message; `start_thread` in the project
  (a new worktree, from `environment: { type: "project-default" }`); announcements of both threads finishing
  their turns. One earlier run answered a question with `use_spoken_words` though the user named an option;
  the rules now say to pass the option.
- `e2e-results/2026-11-24-e2e-rich.json` (`--rich <thread>`): a Claude Code thread whose reply held a ```ui
  table of two pull requests; the voice named both from `read_reply`, opened the first by voice (a new tab in
  headless Chromium; the card said "Opened example.com/acme/web/pull/20"), messaged the thread and told its
  finished turn from the reply. The run before it found the receiving agent reading "tell the release review
  thread to…" in the request's note as a request to message another thread; the note now names the thread.
- `e2e-results/2026-11-25-e2e-pause.json` (`--pause`): the page set a `window.bb.native` bridge once bb's
  app had loaded (bb reads it only at start), so the session was a phone's, and was hidden and shown again
  as bb leaving the phone's screen. Hidden: the card said Paused, the server logged the pause and hung up the
  call, and no call event came for the 10 s away. Shown: the card was back in 0.8 s, the voice said "I'm
  back and listening." 1.7 s after, on a new call, and recalled the word it was told before the pause. "Mute
  the microphone, please" muted (card: Muted, "Tap Unmute to talk again"), the voice said "You're muted now.
  Tap Unmute to come back.", and a question asked while muted got no event at all.
- `e2e-results/2026-11-27-e2e-prompt-edit.json` (`--prompt-edit`): "call me Captain" staged an edit (the
  voice: "It's staged on the Voice page for you to review…next voice session"), and "make that Skipper"
  replaced it (`replaced` named the Captain edit, the card said so); the setting stayed as it was. Tweak
  (Skipper → Commodore) and Apply tweak wrote it; the session in progress kept its instructions, and after
  goodbye the next one greeted "Hi Commodore." An "answer only in French" edit was then rejected on the page,
  and the instructions stayed as applied. The badge: bb's icon-only rail drew a dot on the Mic icon. The
  settings' **Open the script** was checked in a dev bb started with a throwaway `HOME` (so the host entry
  read a scratch hook file, not the owner's): it landed on the Voice page with the script in bb's file panel.
- `e2e-results/2026-11-27-hook-editor.json`: the hook editor, in a dev bb with a throwaway `HOME` holding a
  `hook.sh` (755). It loaded the script, saved an edit (file changed, still 755), warned when a line was
  appended on disk behind it (file untouched) and Save anyway replaced it (still 755); a page reload restored
  the tab and it loaded again; with the dev bb's host daemon stopped (SIGSTOP), Save said "Could not reach
  MacMini…" after 10 s, keeping the edit. Never point such a check at the owner's home folder.
- **Not checked live:** the badge's `✎` text in bb's list layout of the sidebar (the run's was the rail),
  several turns finishing together (unit-tested), a bb link opened from the voice
  (unit-tested), a link in a real browser tab or bb's mobile app, an approval by voice (unit-tested; needs
  a provider that asks), the API-key connection, a real microphone and speaker, bb's desktop app (the hooks
  were driven by the rewrite above) and the phone: a real suspension of bb's mobile app (whether its web view
  lets a microphone be asked for again, and audio play, on return without a tap; Resume is the fallback),
  and a phone that never got to say it left (the heartbeat path is unit-tested).
