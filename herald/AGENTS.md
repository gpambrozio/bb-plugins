# AGENTS.md

A bb plugin that tells the user, out loud, when one of their agent threads needs them: one sentence
about the event — a plain one built from the event, or, when the user opts in, one a short hidden helper
thread writes — and the app speaks it. A **Herald** page lists every
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
| `server/reload-signal.ts` | What an old instance tells its replacement: storage flushed (read it again), and helpers handed over. |
| `server/helper-ownership.ts` | The helpers this instance owns; after unload, handing them to the live instance. |
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
| `app/announcer.ts` | Speaks each new sentence; the mute on this device; reports what it did to the server log. |
| `app/claims.ts` | Which window of the app says an announcement: a claim per event id. |
| `app/icons.ts`, `icons/` | The icon names Herald draws, and the three SVGs it declares because bb has none. |
| `app/open-settings.ts` | The page's Settings button: bb's own route for a plugin's settings. |
| `app/tip-button.tsx` | An icon button with bb's tooltip. |
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
(`system.config().primaryHostId`), because a summary reads nothing from a repository. Every bb has the
personal project (`proj_personal`), but `projects.list()` **leaves it out unless called with
`{ includePersonal: true }`** — the first build missed that, and every summary failed with "no personal
project" (pinned by `server.test.ts`).

## Summaries need a model that can use tools — so they are opt-in

The helper's prompt contains the agent's own output, which can carry instructions. Paseo's own
`AGENTS.md` assumed the prompt's "do not run tools" was enough; it is not, and bb gives a plugin no way
to make a helper tool-free (checked in bb 0.44 and SDK 0.5.29):

- `permissionMode` is `accept-edits | auto | full`, and `accept-edits` is bb's least privileged mode. The
  Claude Code bridge maps it to Claude Code's `acceptEdits`, which reads files and edits files in the
  workspace (bb's personal workspace for a helper) without asking.
- `threads.spawn` takes no tool list; the only plugin hook is `message.dispatch`; `bb.agents.configure`
  selects only this plugin's own tools and skills.
- bb's AI services (`experimental_aiServices`) are services a plugin *provides* to bb, for bb's own
  prompts (thread titles, commit messages); a plugin cannot call one with its prompt.

So *Write each sentence with a model* (`modelSummaries`) is **off by default**, and off, Herald announces
the plain `fallbackSpeech` sentence and spawns nothing. On, the setting's description states the risk. A
helper that does ask for anything is still stopped (`interaction.pending` → "tried to use a tool").

## The events are announcements, and the summary does not wait

bb's events cannot block anything, and a handler runs inside the bb server. A summary is a full agent
turn, so `server/hooks.ts` never awaits one: the handler writes a `pending` entry and returns, and the
summary lands later through `AttentionStore.updateSummary`. That update is keyed by `eventId` and refused
when the thread has moved on to a newer event, which is what keeps a slow helper from overwriting a
fresher entry. `schedule` caps how many helpers run at once (two); a burst queues. **A slot is held until
the helper is put away**, not until its sentence is out: `summarize` returns `{ result, finished }`, the
sentence is settled from `result`, and the task awaits `finished` (stopped, then deleted or archived)
before the next helper starts — otherwise slow-to-stop helpers pile up past the cap. Detached work
catches its own rejections — an unhandled one would land in the bb server.

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

**Unload drains, and never abandons a helper.** `bb.onDispose` calls `HelperOutcomes.cancelAll`, which
fails every wait *and every wait that starts later* (a spawn that answers after unload began), then awaits
`hooks.drain()`: no new events are recorded, the queue is dropped, and it resolves once every running
summary has put its helper away. The SDK handles are still valid until unload returns, and stale after.

The drain waits at most `DRAIN_TIMEOUT_MS`, since a spawn or a stop can hang. Past that,
`HelperOwnership.release()` hands every helper this instance still owns — and any whose spawn answers
later — to the live instance over `server/reload-signal.ts`; calls the old instance would make to bb go
the same way. The live instance stops and deletes them with its own SDK (`retireLeftover`). A handover
nobody receives (the plugin was disabled rather than reloaded) and a process that stopped mid-summary
leave helpers behind, so each load sweeps them (the `leftover-helpers` service): hidden threads of this
plugin, not archived, **created before this instance started** — so a helper of its own is never touched.

Storage is flushed and then **closed** (`store.close()`) before the old instance signals its replacement
to read it again: a summary still settling after the deadline changes only the old instance's memory.

The helper spawns with `permissionMode: "accept-edits"`, bb's least privileged mode — which is not
tool-free (see *Summaries need a model that can use tools*); a helper that asks for anything is stopped. A hidden thread burns a real concurrency slot, so with bb's concurrency
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
`failed` with the fallback.

**A reload reconciles.** bb starts the new instance *before* it disposes of the old one, so the new one
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

**A failed summary is still spoken**: its entry carries the fallback sentence, and `speechText` returns it,
as Paseo did. A failure is never silence.

**What is spoken is short.** The plain sentence says the start of a name (`SPOKEN_NAME_MAX`), a headline
and a detail (`SPOKEN_PART_MAX`) — a permission can carry a command kilobytes long, which the card keeps
whole; a model's sentence is cut at `MAX_SUMMARY_CHARS`; and `speechText` never returns more than
`MAX_SPEECH_CHARS`, the server's render limit, whatever an older entry stored.

**One window speaks each announcement.** Windows of one app share an origin, so each announcement is
claimed by event id (`app/claims.ts`): a `localStorage` marker checked under a Web Lock named for the
event, held only for the check. Three rules keep a window that cannot play from silencing one that can:

- a window claims only if it may play unprompted — the desktop app, or a page already unlocked;
- a window whose playback is refused (the `<audio>` rejects and the voice is not heard) releases its
  claim;
- a window that lost the claim looks again every `CLAIM_RETRY_MS` for `CLAIM_RETRY_WINDOW_MS` (60 s) —
  the winner's whole attempt: a `say` render can take 30 s and a refused browser voice 8 s or more before
  the claim comes back. Each look checks again that the announcement is still current and not blocked.

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

`npm test` covers everything without a running bb: the text, the store, the summariser and the hooks
against fakes, the server end to end against the SDK's fake host (event → hidden helper → sentence →
realtime → list), the announcer with fake audio, and the app's slots rendered with the SDK's app harness.
What it cannot cover, check by hand after `bb plugin reload herald` — **with model summaries on, each of
these runs a real model turn**:

1. Let a thread finish a turn. The page shows it with the plain sentence at once (or, with model
   summaries on, "Writing the summary…" and then the sentence), and the desktop app speaks it.
   `bb plugin logs herald` shows any summary or render failure, and the `app:` lines say what was spoken.
2. Ask a thread something that makes it ask you a question; answer it; the row and the banner go at once.
3. In a browser tab, nothing is spoken until **Test voice** has been pressed once.
4. Switch a kind off in Settings → Plugins → Herald and trigger it: the row says "Not announced" and no
   helper is spawned (`bb thread list --include-hidden` shows none).
5. Edit the summary prompt — "Answer in French" is enough — and trigger an event.
