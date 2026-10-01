# Herald

Tells you, out loud, when one of your agent threads needs you. Ported from
[`paseo-plugins/herald`](https://github.com/gpambrozio/paseo-plugins/tree/main/herald).

When an agent asks a question, waits for a plan or a permission to be approved, finishes its turn, or
fails, Herald says one sentence about it — what is being asked and the choices, the command, or the start
of what was done — and the bb app speaks it. If you switch it on, a short helper agent writes that
sentence instead, to say what was done and whether anything is left (see *Model-written sentences*).

- A **Herald** page in the sidebar lists every thread waiting on you, each with that sentence and how
  long ago it happened; the sidebar entry shows how many. The list keeps itself up to date. Tap a row to
  open the thread, or **Read again** on it to hear the sentence again.
- The sentence also sits above the waiting thread's composer, with a Read again button, until you answer.
- *Mute here* silences announcements on the device you are on until the app reloads; *Test voice* says a
  sample sentence; the gear opens Herald's settings. Read again and Test voice speak even when muted —
  you pressed them.
- Herald speaks whatever page you are on, with the Herald page open or not.

## What Herald adds to bb's push notifications

bb's built-in Push notifications plugin already tells you when a thread finishes, fails or waits for
input, with the thread's own last words as the text. Herald does not replace it, and can run beside it.
What it adds:

- **A sentence written for the ear** — a model reads what happened and says it in one or two sentences,
  starting with which piece of work it is about — instead of the first characters of the agent's reply.
- **Speech**, on the desktop app, in a browser tab, and in the mobile app while it is open.
- **One list of everything waiting on you**, with the reason and the sentence for each, which stays until
  you have read or answered the thread.

## What you need

- bb 0.44 or later.
- Nothing else for the plain sentence. For model-written sentences, an agent provider account (see below).
- For the default voice, **bb running on a Mac**: its `say` voices render each sentence and the app plays
  the audio, so you hear the Mac's voices on every device. Otherwise each device's own browser voice is
  used.
- Sound needs a tap first everywhere but the desktop app: in a **browser tab**, press *Test voice* once.
  The **mobile app** speaks only while it is open on screen, after one press of *Test voice*, and only
  with *Speak in the mobile app* on (it is off by default); a locked phone hears nothing, and bb's push
  notifications reach it instead.

## Model-written sentences

Off by default. Switch on *Write each sentence with a model* and each announced event becomes one short
turn of the model you pick — Claude Haiku 4.5 through Claude Code by default — in a hidden thread that
is stopped and deleted once its sentence is written. The model sees the question and its choices, or the
agent's final message and your last message to it.

**Why it is off:** bb gives a plugin no way to stop that helper from using tools. In bb's most restricted
mode, Claude Code still reads files and edits files in bb's personal workspace without asking, and the
helper is shown your agents' output, which could steer it. Turn it on only if you accept that.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin herald --tag-prefix herald/
```

The page is **Herald** in the sidebar.

## Settings

On the plugin's settings page (Settings → Plugins → Herald):

- **Speech** — the master switch; whether the desktop app, browser tabs and the mobile app speak; the
  voice source (`say`, the Mac running bb, or `web`, this device's browser voice); the speech rate.
- **Which events are announced** — questions, plans, permissions, finished turns, errors. A kind that is
  switched off is still listed on the page, without a summary and without being spoken.
- **Threads started by another thread** — off by default. A child thread reports to the thread that
  started it, and you hear the parent's announcement rather than two. It is still listed.
- **Delete each summary helper when it is done** — on by default. Turn it off to keep each helper,
  archived, to read what it was asked when a summary comes out wrong.
- **Summary time limit** — how long one summary may take before Herald says a plain sentence instead.
- **Summaries and voices** — the model that writes the summaries, the prompt they are written from, and
  the voices.

### The prompt

*Summary prompt* holds the whole prompt the helper is given, to edit however you like — shorter
sentences, another language, more about what matters to you. Herald fills in the parts that change per
event wherever you put them:

| Placeholder | Filled with |
| --- | --- |
| `{{thread}}` | What the work is called: the thread's title, or its project's name. |
| `{{project}}` | The project's name, or the folder name when bb has none. |
| `{{folder}}` | The last part of the thread's working directory. |
| `{{event}}` | A sentence saying why the thread is waiting. |
| `{{headline}}` | The one line Herald builds without a model: the question, the command, "Finished". |
| `{{detail}}` | The choices, the command, or the start of the final message. Often empty. |
| `{{request}}` | What you last asked this thread for. Empty when the thread paused without one. |
| `{{output}}` | What the agent said at the end of its turn. Empty for a pause. |

A **line** whose placeholder has nothing to fill it for that event is left out whole, so keep a label
and its placeholder on the same line. Anything else in double braces is sent as you typed it. *Restore
the default* brings the original prompt back.

The default prompt ends by asking for a small JSON object, which is what Herald reads the sentence out
of. You can drop that — Herald then speaks the first 45 words of whatever the model replies — but the
result is less predictable, so the editor says so.

## Limitations

- bb has no way for a plugin to add a row to a thread's conversation, so the sentence is a banner above
  the composer rather than a card in the transcript, and it goes once the thread moves on.
- A summary helper takes a concurrency slot like any thread. With bb's concurrency limit full, a summary
  can wait past its time limit, and Herald says the plain sentence instead.
