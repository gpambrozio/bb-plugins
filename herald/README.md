# Herald

Tells you, out loud, when one of your agent threads needs you. Ported from
[`paseo-plugins/herald`](https://github.com/gpambrozio/paseo-plugins/tree/main/herald).

When an agent asks a question, waits for a plan or a permission to be approved, finishes its turn, or
fails, Herald says one sentence about it — what is being asked and the choices, the command, or the start
of what was done — and the bb app speaks it.

- A **Herald** page in the sidebar lists every thread waiting on you, each with that sentence and how
  long ago it happened; the sidebar entry shows how many. The list keeps itself up to date. Tap a row to
  open the thread, or **Read again** on it to hear the sentence again.
- The sentence also sits above the thread's composer, with a Read again button, and stays there — whether
  or not you have read the thread, and through your next turn — until the next event replaces it.
- A **Herald** tab in each thread's side panel lists what Herald said about that thread's past turns,
  newest first, with when and a Read again button — a way to find a turn by its sentence. The last 50
  are kept per thread. The megaphone in the thread's header opens it.
- *Mute here* silences announcements on the device you are on until the app reloads; *Test voice* says a
  sample sentence; the gear opens Herald's settings. Read again and Test voice speak even when muted —
  you pressed them.
- Herald speaks whatever page you are on, with the Herald page open or not.

## What Herald adds to bb's push notifications

bb's built-in Push notifications plugin already tells you when a thread finishes, fails or waits for
input, with the thread's own last words as the text. Herald does not replace it, and can run beside it.
What it adds:

- **A sentence written for the ear** — which piece of work it is about, what kind of event, and the
  question, the command or the start of the reply, kept short — instead of the first characters of the
  agent's reply.
- **Speech**, on the desktop app, in a browser tab, and in the mobile app while it is open.
- **One list of everything waiting on you**, with the reason and the sentence for each, which stays until
  you have read or answered the thread.

## What you need

- bb 0.44 or later.
- For the default voice, **bb running on a Mac**: its `say` voices render each sentence and the app plays
  the audio, so you hear the Mac's voices on every device. Otherwise each device's own browser voice is
  used.
- Sound needs a tap first everywhere but the desktop app: in a **browser tab**, press *Test voice* once.
  The **mobile app** speaks only while it is open on screen, after one press of *Test voice*, and only
  with *Speak in the mobile app* on (it is off by default); a locked phone hears nothing, and bb's push
  notifications reach it instead.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.2.0' --plugin herald --tag-prefix herald/
```

The page is **Herald** in the sidebar.

## Settings

On the plugin's settings page (Settings → Plugins → Herald):

- **Speech** — the master switch; whether the desktop app, browser tabs and the mobile app speak; the
  voice source (`say`, the Mac running bb, or `web`, this device's browser voice); the speech rate.
- **Which events are announced** — questions, plans, permissions, finished turns, errors. A kind that is
  switched off is still listed on the page, without being spoken.
- **Threads started by another thread** — off by default. A child thread reports to the thread that
  started it, and you hear the parent's announcement rather than two. It is still listed.
- **Voices** — the Mac voice and the browser voice, and *Test voice*.
- **Write each sentence with a model** — off by default. On, a command-line tool on the Mac running bb
  writes each sentence from the event, the request and the agent's reply, so you hear "Login fix is
  done; nothing is left for you" rather than the start of the reply. Which tool, and the prompt, are
  under **Model-written sentences** further down the same page. See below.

## Model-written sentences

With the switch on, each announcement runs the tool you pick once, as a plain process on the Mac running
bb, with the prompt on its standard input. The tool must be installed and logged in there. The tool, the
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
