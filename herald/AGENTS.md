# AGENTS.md

A bb plugin that tells the user, out loud, when one of their agent threads needs them: one sentence
built from the event, and the app speaks it. A **Herald** page lists every waiting thread with its
sentence. It is a port of
[`paseo-plugins/herald`](https://github.com/gpambrozio/paseo-plugins/tree/main/herald) 0.5.1. That
plugin's `AGENTS.md` is the long record of why each behaviour is the way it is; this file carries over
what still holds and says what bb changed. The repo root `AGENTS.md` covers what every plugin here shares.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring: settings, the store, the event listeners, the RPCs, and unload. |
| `server/hooks.ts` | Events → entries: the turn-end dedupe, event ordering, who is announced, the sentence. |
| `server/reload-signal.ts` | What an old instance tells its replacement: storage closed and flushed, read it again. |
| `server/store.ts` | One entry per thread, mirrored to storage; `load()` merges. |
| `server/kv-backend.ts` | The store's rows in `bb.storage.kv`, one per thread. |
| `server/liveness.ts` | Asks bb about each entry's thread before the list goes out: read, answered, gone, working again. |
| `server/timeline.ts` | Pure text: what an interaction asks, the user's last prompt, the spoken sentence. |
| `server/say.ts` | `say` on the bb server's Mac, driven for its voices: text in on stdin, a WAV out, bytes back. |
| `server/writer.ts` | The optional sentence-writing tool, run as a child process: prompt in on stdin, one line out; the timeout, the cap, the empty folder. |
| `server/command-line.ts` | The user's command split into words without a shell, and the prompt template filled in. |
| `server/ports.ts`, `server/bb-ports.ts` | The seams the logic is tested through, and their implementations over `bb.sdk`. |
| `shared/herald.ts` | The entry shape and the stored voices. No SDK import. |
| `shared/settings.ts` | The host-rendered form, and the speech gate (`blockedMessage`) both halves agree on. |
| `shared/contract.ts` | The RPC contract. The app imports it as a type only. |
| `app/bridge.tsx` | The app-wide overlay: reads the list on every nudge and reconnect, and runs the announcer. |
| `app/announcer.ts` | Speaks each new sentence; the mute on this device; reports what it did to the server log. |
| `app/claims.ts` | Which window of the app says an announcement: a claim per event id. |
| `app/icons.ts`, `icons/` | The icon names Herald draws, and the three SVGs it declares because bb has none. |
| `app/open-settings.ts` | The page's Settings button: bb's own route for a plugin's settings. |
| `app/tip-button.tsx` | An icon button with bb's tooltip. |
| `app/speech.ts` | Every browser audio global, and which bb client this is. |
| `app/rows.ts` | What the page lists: bb's unread and waiting-for-input joined with Herald's entries. |
| `app/panel.tsx`, `app/banner.tsx` | The Herald page (and its sidebar count), and the sentence above a waiting thread's composer. |
| `app/settings-section.tsx`, `app/voice-picker.tsx` | The voice lists and *Test voice*. |

## Where things run

Everything server-side runs in `server.ts`, inside the bb server's process — **no `bb.host` entry.** The
two machine-specific things Herald does need *a* machine, not a particular one: `say` renders speech on
the server's Mac and the audio goes back to the app as bytes, played on the device the user is looking
at; and the optional sentence-writing tool runs as a child of the bb server, where the user installed
and logged into it. When bb's server is not a Mac, `speech.render` refuses and the app falls back to the
browser voice.

## Herald starts no threads

Herald announces the plain sentence `fallbackSpeech` builds from the event, and **no code path spawns a
thread** — `server.test.ts` checks `threads.spawn` is never called, with the model switch on too.
Paseo's Herald had a hidden helper agent write each sentence, and bb cannot make such a helper tool-free
(its least privileged mode reads and edits files, `threads.spawn` takes no tool list), nor keep helpers
bounded across a reload without machinery the feature is not worth. bb's own thread titles do not use a
thread either: they go through an internal AI-services registry that bb 0.44 lets plugins register into
but not call. The whole story is in
[issue #11](https://github.com/gpambrozio/bb-plugins/issues/11).

## The model-written sentence is a child process

With *Write each sentence with a model* on, each announced event runs the chosen tool **once, as a plain
child process of the bb server** (`server/writer.ts`): the filled prompt on stdin, the sentence on stdout,
no shell. What that buys, and what must stay true:

- **Tool-free where the tool allows it.** The Claude Code preset runs `claude -p --tools "" --max-turns 1
  --no-session-persistence --setting-sources "" --strict-mcp-config`, which is a model turn with no tools,
  no settings-file hooks and no MCP servers. Codex and Gemini have no "no tools" switch; their presets run
  read-only (`--sandbox read-only`, `--approval-mode plan`). `--bare` is **not** in the Claude preset: with
  it the CLI reported *Not logged in* on the machine this was built on. Every preset was checked by hand
  against its CLI's `--help`; only the Claude one has been run end to end here (Codex could not run inside
  the build sandbox, Gemini is not installed).
- **An empty working folder per run.** Each run gets its own `mkdtemp` folder under the temp directory,
  removed in a `finally`, so no project instructions, hooks or repository are in reach. One folder for
  the life of the plugin was the first version: macOS purges unused temp entries after a few days and a
  bb server runs for weeks, after which every spawn failed with an ENOENT that named the *tool*.
- **A kill takes the tool's helpers with it.** The child is spawned `detached`, leading its own process
  group, and a kill — timeout, abort, too much output — is `process.kill(-pid)`; `codex` and `claude`
  start children of their own, and a tool stuck mid-call is exactly the one that times out.
- **Fail closed, never queue, never wait long.** At most `MAX_IN_FLIGHT` (2) tools run at once; a third
  request gets the plain sentence at once. A run is killed after `WRITE_TIMEOUT_MS` (20 s), or once it
  has written `MAX_OUTPUT_BYTES` (256 KB) without finishing. A missing tool, a non-zero exit, an empty
  reply or an unreadable command all mean the plain sentence, with the reason in `bb plugin logs herald`.
  A Claude run measured about 10 s end to end.
- **The prompt is bounded.** The agent's output is cut at `PROMPT_OUTPUT_MAX` and the headline, detail
  and request at `PROMPT_PART_MAX` before they go into the template — a permission's command and a
  pasted-in request can both run to kilobytes.
- **The reply is data.** `cleanSentence` keeps the last paragraph of stdout as one line, strips markdown
  and wrapping quotes, and cuts at `MAX_SENTENCE_CHARS`; it then goes through the same `speakable` and
  `MAX_SPEECH_CHARS` limits as every sentence. The prompt tells the model that the data lines are not
  instructions, which a one-sentence Haiku turn honoured when tried; the real protection is that the tool
  has nothing to act with.
- **No sentence lands on a newer event.** The entry is stored at once as `pending` with the plain sentence
  as `fallback`, and `settleSentence` replaces it only while the entry is still that event and still
  pending; a thread that moved on, or an entry a newer event replaced, drops the late sentence. After
  `hooks.dispose()` nothing lands at all.
- **A reload settles, it does not resume.** On unload the hooks close first, then the writer kills its
  children, then the store freezes — so a killed tool cannot write, and storage keeps the entry pending.
  The next load calls `store.settlePending()` after `load()` and again after the post-drain `reconcile()`,
  promoting every pending fallback to `ready`. There is nothing to find and put away.
- **The custom command is seeded, not defaulted.** The host form cannot derive one field from another, so
  `settings.onChange` writes the previously selected tool's command into a blank *Custom command*
  (`customCommandSeed`, with `experimental_set`) — only on the change *into* custom. A command the user
  clears while already on custom stays blank (and means the plain sentence); the first version re-filled
  it with the Claude command, which fought the user. The seed makes the field non-blank, so the `onChange`
  it fires in turn seeds nothing. A preset's command is never read from that field, so a plugin release
  can improve the presets without touching what users wrote. The command runs with the bb server's
  environment and no shell: no `~` or `$VAR` expansion, which the field's description says.
- **The announcer waits.** A `pending` entry is not counted as spoken when first listed — not even in the
  seeding list a window reads when it opens — so the list that brings it `ready` speaks it, once
  (`app/announcer.ts`). The card and the composer banner say *Writing the sentence…* meanwhile, and the
  card's *Read again* is disabled.
- **"Read-only" is weaker than "no tools".** Only the Claude preset runs with no tools. Codex's read-only
  sandbox also cuts the network; Gemini's plan mode keeps its read and web tools, so an instruction
  smuggled through the agent's output has a read-and-send path there. The README says so.

## The events are announcements

bb's events cannot block anything, and a handler runs inside the bb server. Each handler looks up the
thread's names, records the entry with its sentence, publishes, and returns; a failure is logged through
`guarded`, never thrown into the bb server. The thread can move on while a handler awaits its lookups;
each handler takes the thread's generation first and records nothing if a new turn started meanwhile.

**Each recording takes a sequence number before its first await** (`beginEvent`) and drops out unless it
is still the newest for its thread (`isLatest`). Two events can share a turn — two questions — and so a
generation, and their lookups (config, names) can answer in either order; without it the older one
landed on top of the newer.

| Paseo hook | bb event |
| --- | --- |
| `permission_requested` | `interaction.pending` (`user_question` → question, `approval` of a `plan` → plan, every other approval → permission) |
| `turn_started` | `thread.active` — bumps the generation and removes the entry |
| `turn_ended` (completed) | `thread.idle`, which carries `lastAssistantText` |
| `turn_ended` (failed) | `thread.failed`, which carries the error |
| `archived` | `thread.archived` and `thread.deleted` |
| `permission_resolved` | **nothing** — see *Answering an interaction fires nothing* |

There is no "canceled" reason any more: bb has no event for a turn the user stopped.

## Threads another thread started are their parent's to announce

`isAnnounced` treats a thread with a `parentThreadId` like a switched-off kind unless *Announce threads
started by another thread* is on: listed, with its sentence, nothing spoken. bb notifies a
parent when its child completes, fails or is interrupted, so the parent's turn — and its sentence —
covers it. bb's own push-notifications plugin skips a child's finished turn for the same reason.

## Turn ends: repeats, silence, interruptions

- **A repeated turn end is dropped.** `thread.idle` has no turn id, so a repeat is a second idle for the
  same thread inside `TURN_REPEAT_WINDOW_MS` with no `thread.active` between them (the generation).
- **An empty turn is dropped** — a compaction, a bare tool run. This is checked *before* the repeat
  test, so a silent end cannot stand in for the real turn end that follows it.
- **A failure within `INTERRUPT_GRACE_MS` of an interaction that was interrupted** is dropped: the user
  stopped the turn while it waited on them. bb records that as the interaction's `interrupted` status,
  read through `interactions.list` when the failure arrives.
- **Streamed chunks are not re-joined.** bb assembles `lastAssistantText` itself (the same way
  `GET /threads/:id/output` does); Herald uses it as it comes, trimmed, with nothing added between the
  pieces. Paseo's `latestOutputText`, which joined Paseo timeline chunks, is gone with the timeline.

## Answering an interaction fires nothing

bb has no event for a resolved interaction, and the thread stays `active` across it. Two things cover
that: `Liveness` asks before the list goes out and removes an answered entry; and the app hides an
interaction entry the moment bb's sidebar state says the thread no longer waits for input
(`hasPendingInteraction`, live through `experimental_useSidebarThreads`). The announcer checks that an
announcement is still in the latest list before it speaks.

A finish is not always one: a provider can report a turn as finished and carry on. `Liveness` hides a
finish whose thread is running again, on a reading at most `RUNNING_TTL_MS` old, and so does the app's
join. Never apply that to a question or an approval — a thread waiting on one is mid-turn, and the rule
would hide every one of them.

## What the store means

One entry per thread, the most recent reason it is waiting. Removed when the events show the thread
moving on (`thread.active`, archive, delete) and by `Liveness`. **There is no age limit, on purpose.** bb
decides who is waiting — its unread rule, `latestAttentionAt > lastReadAt`, and its pending
interactions; Herald explains why. `Liveness` (cached 30 s) removes an entry whose thread is **gone**,
whose interaction was **answered**, or which was **seen** — read since its attention, and at least
`SEEN_GRACE_MS` old so a thread the user is watching as it finishes still reaches the panel. A finish
on a thread that is working again is hidden but kept.

Hidden threads are ignored entirely — another plugin's background workers: bb keeps them out of the
user's attention too.

**`load()` merges, it does not overwrite.** `server.ts` awaits it before registering any listener, but
the merge stays: a live upsert or removal during a read wins (`touched`), a conditional removal that
arrives before its entry was read is held and applied as it merges (`deferredRemovals`), and a write
queued during the read waits and mirrors the merged map. A saved entry this version cannot read is
dropped, with a warning.

**A reload reconciles.** Storage is **closed, then flushed** (`store.shutdown()`) before the old instance
signals its replacement to read it again; closing freezes the map, so nothing requested afterwards
reaches storage. bb starts the new instance *before* it disposes of the old one, so the new one
reads storage while the old one may still be writing. When the old one has drained and flushed, it says
so (`server/reload-signal.ts`: an `EventTarget` on `globalThis`, keyed by plugin id — both instances run
in the bb server's one process), and the new one calls `store.reconcile()`: storage wins for every
thread this instance has not itself changed since it last read, including removals.

**A read waits for any write already under way**, and then mirrors the merged map. Mixing them broke the
kv backend's bookkeeping: the read recorded a row the older write's snapshot did not have, and the write
then deleted it.

Rows are one kv value per thread (`entry:<threadId>`) rather than one array, because a value is capped
at 256 KB; a write touches only rows that changed.

## Speech happens in the app

The bb app is web React on every client — Electron on the desktop, a browser tab, and the mobile app,
which is a native shell around the same web app in a WebView. So both engines exist everywhere:

- **`say` (default):** `speech.render` has the server's Mac run `say -o … --file-format=WAVE` with the
  sentence on stdin (16 kHz mono) and returns the WAV as base64; the app plays it through one reused
  `<audio>` element. A render that fails or a playback that is refused falls through to the browser voice,
  reported once.
- **`web`:** the Web Speech API with this device's voices. `speak()` resolves `true` when the utterance
  was heard and `false` when it was refused — a guard timer resolves it too, because a browser that
  refused it fires no event, and then it counts as heard only if it had started.

`speechPlatform()` tells the clients apart the way bb's push-notifications plugin does: `window.bbDesktop`
is the desktop shell, a `window.bb.native` bridge is the mobile app, anything else a browser tab. These
are bb internals, not SDK; if a later bb renames them, every client reads as a browser tab.

- **Desktop** plays unprompted.
- **Browser tab and mobile app** play only after the page has been tapped once, and the mobile app only
  while it is on screen — a locked or backgrounded phone is suspended, and push-notifications reaches it
  instead. Android's WebView has no `speechSynthesis`, so there only `say` speaks. *Speak in the mobile
  app* is off by default (Paseo could not speak on a phone at all).

**A browser grants audio to the task its gesture ran in, so every press handler calls `primeSpeech()`
before its first `await`.** It starts a silent clip on the element every later playback reuses — WebKit
unlocks the element, not the page — and an inaudible utterance. Take it out and browser announcements
never start. **Whether the page is unlocked is tracked explicitly** (`isAudioUnlocked`: a playback or an
utterance was heard, or a prime played), never read off the element's `src` — a refused automatic
playback sets that too, and must not stop the next press from priming.

**The switches mean what they say.** `blockedMessage()` is the single gate — *Mute here*, the master
switch, then the platform switch — and returns the reason. An announcement is gated when it is about to
be said, not when it arrived, and a blocked one is logged and dropped. **An explicit press is forced
through**: *Test voice* and *Read again* (on each card and on the composer banner) pass `{ force: true }`
and speak even with announcements off or this device muted — the owner's choice, and it is also the
press that unlocks audio. Every play control is hidden where `canPlaySpeech()` is false.

**What is spoken is short.** The plain sentence says the start of a name (`SPOKEN_NAME_MAX`), a headline
and a detail (`SPOKEN_PART_MAX`) — a permission can carry a command kilobytes long, which the card keeps
whole; and `speechText` never returns more than `MAX_SPEECH_CHARS`, the server's render limit, whatever
an older entry stored.

**One window speaks each announcement.** Windows of one app share an origin, so each announcement is
claimed by event id (`app/claims.ts`): a `localStorage` marker checked under a Web Lock named for the
event, held only for the check. Three rules keep a window that cannot play from silencing one that can:

- a window claims only if it may play unprompted — the desktop app, or a page already unlocked;
- a window whose playback is refused (the `<audio>` rejects and the voice is not heard) releases its
  claim;
- a window that lost the claim keeps the announcement and **hears the release**: the refused window
  writes the event id to one notification key (`releaseKey`), which fires `storage` in every other window
  of the origin (`onClaimReleased`), and the window tries again then — however long the refused attempt
  took. **Only that write notifies.** A claim key removed for any other reason — the day-old pruning —
  is silent; when every removal counted, a window that had lost an announcement said it again the next
  day. It checks again that the
  announcement is still current and not blocked, and forgets it once the announcement is withdrawn.
  (Timed retries were tried first; a slow render plus a refused voice outlasted any fixed window.)

The first build elected one window with a lock held for its lifetime instead; a window or a replaced
plugin generation that never released it would have kept every other window quiet. Different devices
each speak, by their own switches.

**An announcement withdrawn while it waited is not said.** Deliveries queue; when one's turn comes, its
event id must still be in the latest list (the thread may have resumed, or been answered). *Read again*
and *Test voice* are exempt.

**The announcer reports to the server.** What it spoke, and why it stayed quiet, goes through the `log`
RPC into `bb plugin logs herald` (prefixed `app:`), because the app's console is out of reach on the
desktop and mobile apps. Read that first when the user hears nothing.

The first list a window reads only seeds what has been said: what was waiting when the window opened is
not news. After that the list is re-read on every realtime nudge (`entries`), on every reconnect, and once
a minute as a backstop — so the page has no Refresh button. Its header has *Mute here*, *Test voice* and a
Settings button that goes where bb's own `openSettings()` goes (`/settings/plugins/<pluginId>`); the
panel SDK has no call for it, so `app/open-settings.ts` pushes that route as `firstmate-crew` does.

## Icons

bb's icon names are its own set (about 170, listed in `app/testing/bb-icon-names.ts`), not Lucide's: there
is no `Volume2`, `RefreshCw`, `Megaphone`, `Shield` or `Loader2`, and a name bb does not know renders as its
generic bolt with no error — the first build shipped three such buttons. The megaphone and the two speakers
are Lucide SVGs (ISC, `icons/LICENSE`) declared in `bb.branding.experimental_icons` and drawn as
`herald/<name>`; the branding icon is the megaphone file. `app/icons.test.ts` checks every name Herald uses
against bb's list and the manifest. Refresh the list from bb's app bundle (`ICON_NAMES`) when the SDK moves.

## The sentence in the thread

A plugin cannot add a row to a thread's timeline, so Paseo's transcript card is gone. The sentence sits
in a **composer banner** instead (`app.composer.customize`, thread scope) — where the user is about to
answer — for as long as the thread waits on them, with a play button. A switched-off kind gets no banner.

## Checking it

`npm test` covers everything without a running bb: the text, the store, the hooks against fakes, the
server end to end against the SDK's fake host (event → entry → realtime → list, and no thread spawned),
the announcer with fake audio, and the app's slots rendered with the SDK's app harness. What it cannot
cover, check by hand after `bb plugin reload herald`:

1. Let a thread finish a turn. The page shows it with its sentence at once, and the desktop app speaks
   it. The `app:` lines in `bb plugin logs herald` say what was spoken, or why not.
2. Ask a thread something that makes it ask you a question; answer it; the row and the banner go at once.
3. In a browser tab, nothing is spoken until **Test voice** has been pressed once.
4. Switch a kind off in Settings → Plugins → Herald and trigger it: the row says "Not announced" and
   nothing is spoken.
5. Switch *Write each sentence with a model* on with the Claude tool and let a thread finish: the row and
   the banner say "Writing the sentence…" for a few seconds, then the model's sentence replaces it and is
   spoken once. Then pick the tool *custom*: the custom command fills in with the Claude command. Set it
   to a command that does not exist: the plain sentence is spoken and the log says why.
