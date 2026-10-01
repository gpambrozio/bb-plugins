# Herald

Tells you, out loud, when one of your agent threads needs you. Ported from
[`paseo-plugins/herald`](https://github.com/gpambrozio/paseo-plugins/tree/main/herald).

When an agent asks a question, waits for a plan or a permission to be approved, finishes its turn, or
fails, Herald says one sentence about it — what is being asked and the choices, the command, or the start
of what was done — and the bb app speaks it.

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
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin herald --tag-prefix herald/
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

## Limitations

- bb has no way for a plugin to add a row to a thread's conversation, so the sentence is a banner above
  the composer rather than a card in the transcript, and it goes once the thread moves on.
- The sentence is built from the event, not written by a model, so it says what is asked or the start
  of what was done rather than summing a long reply up. Model-written sentences, as the Paseo plugin
  had, are tracked in [issue #11](https://github.com/gpambrozio/bb-plugins/issues/11).
