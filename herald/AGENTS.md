# AGENTS.md

A bb plugin that tells the user, out loud, when one of their agent threads needs them: a short hidden
helper thread writes one sentence about the event, and the app speaks it. A **Herald** page lists every
waiting thread with its sentence. It is a port of
[`paseo-plugins/herald`](https://github.com/gpambrozio/paseo-plugins/tree/main/herald) 0.5.1. That
plugin's `AGENTS.md` is the long record of why each behaviour is the way it is; this file carries over
what still holds and says what bb changed. The repo root `AGENTS.md` covers what every plugin here shares.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring: settings, the store, the event listeners, the RPCs, and unload. |
| `server/hooks.ts` | Events → entries: helper routing, the turn-end dedupe, the two-slot summary queue, "outran", who is announced. |
| `server/summarize.ts` | One helper per summary: the prompt template, reading its reply, stopping and deleting it. |
| `server/helpers.ts` | `HelperOutcomes`: how each helper's turn ended, as its own events report it. |
| `server/store.ts` | One entry per thread, mirrored to storage; `load()` merges. |
| `server/kv-backend.ts` | The store's rows in `bb.storage.kv`, one per thread. |
| `server/liveness.ts` | Asks bb about each entry's thread before the list goes out: read, answered, gone, working again. |
| `server/timeline.ts` | Pure text: what an interaction asks, the user's last prompt, the no-model fallback sentence. |
| `server/say.ts` | `say` on the bb server's Mac, driven for its voices: text in on stdin, a WAV out, bytes back. |
| `server/ports.ts`, `server/bb-ports.ts` | The seams the logic is tested through, and their implementations over `bb.sdk`. |
| `shared/herald.ts` | The entry shape, the stored summariser and voices, the prompt vocabulary. No SDK import. |
| `shared/settings.ts` | The host-rendered form, and the speech gate (`blockedMessage`) both halves agree on. |
| `shared/contract.ts` | The RPC contract. The app imports it as a type only. |
| `app/bridge.tsx` | The app-wide overlay: reads the list on every nudge and reconnect, and runs the announcer. |
| `app/announcer.ts` | Speaks each new sentence once per window; the mute on this device. |
| `app/speech.ts` | Every browser audio global, and which bb client this is. |
| `app/rows.ts` | What the page lists: bb's unread and waiting-for-input joined with Herald's entries. |
| `app/panel.tsx`, `app/banner.tsx` | The Herald page (and its sidebar count), and the sentence above a waiting thread's composer. |
| `app/settings-section.tsx`, `app/voice-picker.tsx` | The model picker, the prompt editor, and the voice lists. |

## Where things run

Everything server-side runs in `server.ts`, inside the bb server's process — **no `bb.host` entry.** The
only machine-specific thing Herald does is render speech with `say`, and that needs *a* Mac, not a
particular one: the audio goes back to the app as bytes and plays on the device the user is looking at.
When bb's server is not a Mac, `speech.render` refuses and the app falls back to the browser voice.

Summary helpers run in bb's **personal project and workspace** on the server's machine
(`system.config().primaryHostId`), because a summary reads nothing from a repository.

## The events are announcements, and the summary does not wait

bb's events cannot block anything, and a handler runs inside the bb server. A summary is a full agent
turn, so `server/hooks.ts` never awaits one: the handler writes a `pending` entry and returns, and the
summary lands later through `AttentionStore.updateSummary`. That update is keyed by `eventId` and refused
when the thread has moved on to a newer event, which is what keeps a slow helper from overwriting a
fresher entry. `schedule` caps how many helpers run at once (two); a burst queues. Detached work catches
its own rejections — an unhandled one would land in the bb server.

| Paseo hook | bb event |
| --- | --- |
| `permission_requested` | `interaction.pending` (`user_question` → question, `approval` of a `plan` → plan, every other approval → permission) |
| `turn_started` | `thread.active` — bumps the generation and removes the entry |
| `turn_ended` (completed) | `thread.idle`, which carries `lastAssistantText` |
| `turn_ended` (failed) | `thread.failed`, which carries the error |
| `archived` | `thread.archived` and `thread.deleted` |
| `permission_resolved` | **nothing** — see *Answering an interaction fires nothing* |

There is no "canceled" reason any more: bb has no event for a turn the user stopped.

## The helper is hidden, and still fires our events

`threads.spawn({ visibility: "hidden", pluginMetadata })` keeps the helper out of the sidebar and out of
bb's unread attention. **It does not keep it out of `bb.events`**: bb's `emitThreadEvent` delivers every
thread's events to every plugin, with no visibility filter (checked in bb 0.44's server). bb stamps
`originPluginId` on every thread a plugin spawns with `pluginMetadata`, so `isHelper` is
`thread.originPluginId === bb.pluginId` — no title, no id set, nothing lost on a reload. Herald spawns
nothing but helpers.

A helper's events go to `HelperOutcomes`, which is what `summarize` waits on: `thread.idle` brings its
reply, `thread.failed` its error, `interaction.pending` means it tried a tool. An outcome that arrives
before anyone waits is held for two minutes. An idle with no text before the helper was ever seen
running is ignored, since a thread settling in is not a reply.

**The helper is not a child of the thread it describes.** Paseo made it a delegated child so it showed
in the agent's subagent track; in bb a child notifies its parent when it finishes, which would put a
message in the user's own thread.

`summarize` stops the helper in a `finally` — which releases its runtime and interrupts a turn still
running after a timeout — then deletes it, or archives it when *Delete each summary helper* is off.
Both are fire-and-forget, so the sentence does not wait on them. On unload, `HelperOutcomes.cancelAll`
fails every wait at once, so each running summary puts its helper away while bb still answers.

The helper spawns with `permissionMode: "accept-edits"`: everything but a file edit asks first, and a
helper that asks is stopped. A hidden thread burns a real concurrency slot, so with bb's concurrency
limit full a helper can wait past the summary time limit and the fallback sentence is used.

Dropped from Paseo: the `paseo` CLI delete, the startup sweep and its label, `HELPER_TITLE` as an
identity (it is only the helper's title now), and the capped helper-id set.

## The prompt is a template the user owns

Unchanged from Paseo except for the vocabulary: `{{thread}}`, `{{project}}`, `{{folder}}`, `{{event}}`,
`{{headline}}`, `{{detail}}`, `{{request}}`, `{{output}}` (`PROMPT_PLACEHOLDERS`). `renderPrompt` keeps two
rules the settings section states in the same words: **a line whose placeholder is empty for this event
is dropped whole**, and **an unknown `{{name}}` is left exactly as typed**. Blank is not empty —
`buildPrompt` reads a blank template as the default, and the editor saves blank when the draft matches
the default, so a user who never customised it follows the default as it changes.

**The model's reply is a request, not a guarantee.** Claude has returned the object inside a
```` ```json ```` fence and under a key of its own choosing. `parseSummaryText` strips fences, finds the
object anywhere, takes `speech` or else the first string, and only then falls back to the first 45 words
of prose. bb's spawn has no `outputSchema`, so the default prompt's closing line is the only ask; keep it
and keep the parser defensive. The editor warns when the word `speech` leaves the prompt.

The summariser (provider, model, reasoning, prompt) and the voices live in `bb.storage.kv` under
`config`, edited in the settings section — the model picker, a multi-line editor and two lists of
hundreds of voices do not fit the host form. Everything else is in the host-rendered form.

## Threads another thread started are their parent's to announce

`isAnnounced` treats a thread with a `parentThreadId` like a switched-off kind unless *Announce threads
started by another thread* is on: listed, with the fallback, no helper, nothing spoken. bb notifies a
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

## A completion that was not one, and an answer nobody heard

The check is made *after* the summary comes back (`outran`). The generation applies to every event.
Then one question for bb, depending on the event:

- a **finish**: is a turn in flight again (`isRunning`, uncached)? A provider can report a turn as
  finished and carry on. Never ask this about a question or an approval — a thread waiting on one is
  mid-turn, and asking would suppress every one of them.
- an **interaction**: is it still pending (`interactions.get`)?

If the thread has moved on, the entry is removed and nothing is said.

## Answering an interaction fires nothing

bb has no event for a resolved interaction, and the thread stays `active` across it. Three things cover
that: `outran` asks before a question's summary is spoken; `Liveness` asks before the list goes out and
removes an answered entry; and the app hides an interaction entry the moment bb's sidebar state says the
thread no longer waits for input (`hasPendingInteraction`, live through `experimental_useSidebarThreads`).

## What the store means

One entry per thread, the most recent reason it is waiting. Removed when the events show the thread
moving on (`thread.active`, archive, delete) and by `Liveness`. **There is no age limit, on purpose.** bb
decides who is waiting — its unread rule, `latestAttentionAt > lastReadAt`, and its pending
interactions; Herald explains why. `Liveness` (cached 30 s) removes an entry whose thread is **gone**,
whose interaction was **answered**, or which was **seen** — read since its attention, and at least
`SEEN_GRACE_MS` old so a thread the user is watching as it finishes still reaches the panel. A finish
on a thread that is working again is hidden but kept. A pending summary is never judged.

Hidden threads from other plugins are ignored entirely: bb keeps them out of the user's attention too.

**`load()` merges, it does not overwrite.** `server.ts` awaits it before registering any listener, but
the merge stays: a live upsert or removal during a read wins (`touched`), a conditional removal that
arrives before its entry was read is held and applied as it merges (`deferredRemovals`), and a write
queued during the read waits and mirrors the merged map. A summary still `pending` at load is marked
`failed` with the fallback. A reload starts the new instance *before* it disposes of the old one, so the
new one reads what has landed by then.

Rows are one kv value per thread (`entry:<threadId>`) rather than one array, because a value is capped
at 256 KB; a write touches only rows that changed.

## Speech happens in the app

The bb app is web React on every client — Electron on the desktop, a browser tab, and the mobile app,
which is a native shell around the same web app in a WebView. So both engines exist everywhere:

- **`say` (default):** `speech.render` has the server's Mac run `say -o … --file-format=WAVE` with the
  sentence on stdin (16 kHz mono) and returns the WAV as base64; the app plays it through one reused
  `<audio>` element. A render that fails or a playback that is refused falls through to the browser voice,
  reported once.
- **`web`:** the Web Speech API with this device's voices. `speak()` also resolves on a guard timer,
  because a browser that refused it fires no event.

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
never start.

**The switches mean what they say, and a blocked press says so.** `blockedMessage()` is the single gate —
*Mute here*, the master switch, then the platform switch — and returns the reason. An announcement that
is blocked is dropped silently; a pressed speaker hands the reason to a toast. *Test voice* passes
`{ force: true }`: it is how the voice is checked while announcements are off, and the press that
unlocks audio. Every play control is hidden where `canPlaySpeech()` is false.

**One window speaks.** Windows of one app share an origin, so a Web Lock (`<pluginId>:announcer`) elects
the one whose announcer speaks on its own; every window keeps count of what was said, so a window that
takes the lead later does not repeat it. Different devices each speak, by their own switches.

The first list a window reads only seeds what has been said: what was waiting when the window opened is
not news. After that the list is re-read on every realtime nudge (`entries`), on every reconnect, and once
a minute as a backstop.

## The sentence in the thread

A plugin cannot add a row to a thread's timeline, so Paseo's transcript card is gone. The sentence sits
in a **composer banner** instead (`app.composer.customize`, thread scope) — where the user is about to
answer — for as long as the thread waits on them, with a play button. A switched-off kind gets no banner.

## Checking it

`npm test` covers everything without a running bb: the text, the store, the summariser and the hooks
against fakes, the server end to end against the SDK's fake host (event → hidden helper → sentence →
realtime → list), the announcer with fake audio, and the app's slots rendered with the SDK's app harness.
What it cannot cover, check by hand after `bb plugin reload herald` — **each of these runs a real model
turn**:

1. Let a thread finish a turn. Within seconds the page shows it with "Writing the summary…", then the
   sentence, and the desktop app speaks it. `bb plugin logs herald` shows any summary or render failure.
2. Ask a thread something that makes it ask you a question; answer it; the row and the banner go at once.
3. In a browser tab, nothing is spoken until **Test voice** has been pressed once.
4. Switch a kind off in Settings → Plugins → Herald and trigger it: the row says "Not announced" and no
   helper is spawned (`bb thread list --include-hidden` shows none).
5. Edit the summary prompt — "Answer in French" is enough — and trigger an event.
