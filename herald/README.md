# Herald

Tells you, out loud, when one of your agent threads needs you. Ported from
[`paseo-plugins/herald`](https://github.com/gpambrozio/paseo-plugins/tree/main/herald).

When an agent asks a question, waits for a plan or a permission to be approved, finishes its turn, or
fails, Herald says one sentence about it — what is being asked and the choices, the command, or the start
of what was done — and the bb app speaks it.

- A **Herald** page in the sidebar lists every thread waiting on you, each with that sentence and how
  long ago it happened; the sidebar entry shows how many. The list keeps itself up to date. Tap a row to
  open the thread, or **Read again** on it to hear the sentence again. Below them, **Recent sentences**
  lists what Herald last said about any thread, in every project — the last 20 by default — with the
  thread, its project and how long ago; tap one to open its thread.
- The sentence also sits above the thread's composer, with a Read again button, and stays there — whether
  or not you have read the thread, and through your next turn — until the next event replaces it.
- A **Herald** tab in each thread's side panel lists what Herald said about that thread's past turns,
  newest first, with when and a Read again button — a way to find a turn by its sentence. The last 50
  are kept per thread. The megaphone button in the thread's header opens it, and closes it again (on bb
  0.47 it only opens it).
- **Herald** in a thread's menu (the sidebar row's menu, right-click, or the thread's header) chooses what
  Herald announces for that thread: *Announce*, *Questions only* (a question, a plan or a permission to
  approve, but not a finished or failed turn), or *Silent*. *Default* follows the thread that started it
  — so silencing a coordinator silences its workers — and otherwise Herald's settings. On bb 0.48, select
  several threads in the sidebar to set them all at once. See [Per-thread choice](#per-thread-choice).
- *Mute here* silences announcements on the device you are on until the app reloads; *Test voice* says a
  sample sentence; the gear opens Herald's settings. Read again and Test voice speak even when muted —
  you pressed them.
- Herald speaks whatever page you are on, with the Herald page open or not.

## What Herald adds to bb's push notifications

bb's built-in Push notifications plugin already tells you when a thread finishes, fails or waits for
input, with the thread's own last words as the text. By default Herald runs beside it and changes
nothing there. What it adds:

- **A sentence written for the ear** — which piece of work it is about, what kind of event, and the
  question, the command or the start of the reply, kept short — instead of the first characters of the
  agent's reply.
- **Speech**, on the desktop app, in a browser tab, and in the mobile app while it is open.
- **One list of everything waiting on you**, with the reason and the sentence for each, which stays until
  you have read or answered the thread.

### Herald's sentences as your push notifications

Switch on **Send Herald's sentences as push notifications instead of bb's** (off by default) and the
notifications on your phone, desktop and browser carry Herald's sentence instead of the agent's last
words, for every thread Herald announces:

- **Which threads.** Every thread whose Herald choice is *Announce* or *Questions only* — the thread's
  own, or with *Default* the one it follows through the thread that started it and Herald's settings. A
  *Silent* thread keeps bb's own notifications.
- **How.** The first time Herald handles such a thread (a turn starting, or an event), it sets bb's
  notification level for the thread to *Muted* and remembers the level it had. From then on Herald sends
  the notifications that mute holds back — the same events bb would have notified at the level it
  remembered, each once — through bb's own Push notifications plugin. The title is the thread's name and
  its project (when both fit in bb's 80 characters); the text is Herald's sentence, cut at a word to bb's
  180. Tapping or clicking it opens that thread, on the phone, the desktop app and in a browser.
- **Questions only, and the per-kind switches.** These decide what Herald *speaks*; which events
  *notify* still follows bb's level. A Questions-only thread still notifies a failed turn, and a
  finished turn when bb's level for it is *All activity*; an event Herald does not speak goes out with
  the plain sentence. That way turning this on never loses a notification bb would have sent. A worker
  thread that Herald does not announce, under a coordinator it muted, still gets its questions and
  errors notified by Herald, because bb's mute on a thread also mutes the threads it started.
- **bb's Notifications menu shows such a thread as Muted.** Pick another level there and Herald leaves it
  alone; at the thread's next event it takes the thread over again and notifies at the level you
  picked. A thread you muted yourself, or that another plugin muted, before Herald took it over is never
  taken over. bb does not record who set a level, though: if you or another plugin set *Muted* on a
  thread Herald already holds, Herald cannot tell that mute from its own and gives the thread its old
  level back with it. To keep a thread muted in bb, set it to *Silent* in Herald first, then mute it.
- **Giving the level back.** Herald puts the remembered level back when you switch this off, when the
  thread's choice becomes *Silent*, when the thread is archived, when Herald is disabled, removed or
  reloaded (bb has one hook for all of them; a reload takes the threads over again as they next run),
  and when a notification fails to send. It waits until the thread and the threads it started have been
  quiet for three seconds, so an event that just happened is notified once, by Herald. It never
  overwrites a level that is no longer Muted. If bb cannot take a level back, Herald keeps notifying
  for that thread, tries again every minute, and the Herald page says how many threads are waiting.
- **When it cannot.** It needs bb 0.48.1 or newer with bb's Push notifications plugin on. Otherwise
  Herald changes no level, bb sends its own notifications, and the Herald page says why. After a failed
  send, Herald gives every level back, says so on the page, and takes no thread over until you switch
  the setting off and on again or Herald reloads. The notification that failed is tried again for a few
  minutes, and the ones Herald already owed still go out: bb had held them back.
- **With FirstMate Crew.** FirstMate Crew can send the first mate's own notifications for its thread
  too. If you use both, set the first mate's thread to *Silent* in Herald's thread menu *before* turning
  on FirstMate Crew's notifications, so only one of them notifies for it. Setting it to Silent afterwards
  can undo FirstMate Crew's mute, for the reason above.

What differs from bb's own: a turn that ends without any text (a compaction, say) is not notified, as
Herald does not announce it; bb's notifications arrive about two seconds after an event, Herald's as
soon as its sentence is ready — up to 45 seconds later with *Write each sentence with a model* on; the
first event of a thread Herald takes over may notify twice, once from bb; and a reload during an event
can, rarely, do the same.

## What you need

- bb 0.47 or later. On bb 0.44 to 0.46, install with `@^0.2.0` instead of `@^0.5.0`.
- For the default voice, **bb running on a Mac**: its `say` voices render each sentence and the app plays
  the audio, so you hear the Mac's voices on every device. Otherwise each device's own browser voice is
  used.
- Sound needs a tap first everywhere but the desktop app: in a **browser tab**, press *Test voice* once.
  The **mobile app** speaks only while it is open on screen, after one press of *Test voice*, and only
  with *Speak in the mobile app* on (it is off by default); a locked phone hears nothing, and bb's push
  notifications reach it instead.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.5.0' --plugin herald --tag-prefix herald/
```

The page is **Herald** in the sidebar.

## Settings

On the plugin's settings page (Settings → Plugins → Herald):

- **Speech** — the master switch; whether the desktop app, browser tabs and the mobile app speak; the
  voice source (the voices of the Mac running bb, or this device's browser voice); the speech rate.
- **Which events are announced** — questions, plans, permissions, finished turns, errors. A kind that is
  switched off is still listed on the page, without being spoken.
- **Threads started by another thread** — off by default. A child thread reports to the thread that
  started it, and you hear the parent's announcement rather than two. It is still listed. A choice made
  on the child thread itself, from its menu, overrides this.
- **Voices** — the Mac voice and the browser voice, and *Test voice*.
- **Herald page** — how many recent sentences the page lists below the waiting threads: 20 by default,
  from 1 to 50.
- **Write each sentence with a model** — off by default. On, a command-line tool on the Mac running bb
  writes each sentence from the event, the request and the agent's reply, so you hear "Login fix is
  done; nothing is left for you" rather than the start of the reply. Which tool, and the prompt, are
  under **Model-written sentences** further down the same page. See below.
- **Send Herald's sentences as push notifications instead of bb's** — off by default. See
  [Herald's sentences as your push notifications](#heralds-sentences-as-your-push-notifications).

## Per-thread choice

**Herald** in bb's thread menu sets what Herald announces for one thread. It is stored on the thread, so
every device and window sees the same choice.

- **Announce** — every kind of event the settings above switch on.
- **Questions only** — only what waits on you: a question, a plan or a permission to approve. A finished
  or failed turn is listed, not spoken.
- **Silent** — nothing is spoken. The thread is still listed on the Herald page.
- **Default** — no choice of its own. A thread started by another thread follows the nearest thread above
  it that has a choice (a worker follows its coordinator), as long as *Announce threads started by
  another thread* is on; with it off, such a thread stays quiet, as before. Any other thread announces
  as the settings say.

A choice set on a thread itself always wins: a worker set to *Announce* is announced even under a Silent
coordinator, and even with *Announce threads started by another thread* off. The per-kind switches still
apply on top of every choice. *Mute here* is separate: it silences one device, for every thread.

On bb 0.48, where the sidebar can select several threads, **Herald** is also in the menu of a selection
and sets the same choice on every selected thread. A choice is checked there only when every selected
thread has it as its own; archived threads are left out.

## Model-written sentences

With the switch on, each announcement runs the tool you pick once, as a plain process on the Mac running
bb, with the prompt on its standard input. The tool must be installed and logged in there. Herald looks
for it where bb looks for its own tools — the login shell's PATH, `~/.local/bin`, mise and asdf shims,
Volta and Homebrew — and finds one installed after a failed run on the next try. The tool, the
custom command and the prompt sit together in the *Model-written sentences* section of Herald's settings
page, below bb's own form. The presets:

- **claude** — Claude Code, with no tools, no settings-file hooks and no MCP servers, one turn of the
  Haiku model at low effort.
- **codex** — OpenAI Codex without its user configuration (so none of your MCP servers or hooks),
  read-only, nothing saved to disk. Its login still comes from your Codex home.
- **gemini** — Gemini CLI, in its read-only plan mode.
- **custom** — a command of your own. A *Custom command* field appears under the tool only while custom
  is selected, filled in with the command of the tool you had selected, to start from. The prompt
  arrives on standard input; the last paragraph of the standard output becomes the sentence. No shell
  runs the command: quote as you would in one, but `~` and `$VARIABLES` are not expanded, and it sees
  the bb server's environment.

Only the Claude preset runs with no tools at all, and as one bounded call. Codex runs without your
configuration and its read-only sandbox cuts the network for the commands it runs; Gemini's plan mode
keeps its read and web tools, so an instruction hidden in an agent's reply could in principle have it
read a file and send it somewhere. Neither Codex nor Gemini can be told to stop after one turn from the
command line, so if the bb server crashed mid-run, one of those could keep working on its own for a
while; the Claude preset cannot. Pick claude if any of that matters to you.

The *Sentence prompt* is yours to edit, with a button to get the default back; it has placeholders for
the thread, project, folder, event, headline, detail, the request and the agent's output.

While the tool runs, the row and the banner say *Writing the sentence…*; the plain sentence is spoken
instead if the tool fails, is missing, or takes longer than 45 seconds. A sentence still being written
when Herald itself is reloaded is dropped rather than spoken late. The prompt includes the agent's
own reply, which can carry instructions: that is why the presets run with no tools or read-only, and why
the switch is off by default. A Claude run takes about ten seconds end to end.

## Limitations

- bb has no way for a plugin to add a row to a thread's conversation, so the sentence is a banner above
  the composer and a list in the thread's side panel rather than a card in the transcript beside each
  turn.
- The model that writes a sentence is a command-line tool, not one of bb's own providers: bb 0.44 lets a
  plugin register an AI service for its thread titles but not call one. The plain sentence is built from
  the event alone.
