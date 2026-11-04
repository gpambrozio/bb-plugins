# Learning Exercises

A [bb](https://getbb.app) plugin that offers you a short exercise on work you just did with an agent —
after a commit, new files, a schema change or a merged pull request — and runs it in a side thread
with a real answer card, so you keep learning the code your agents write.

The exercises are adapted from Dr. Cat Hicks's
[Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities) (CC BY 4.0). This plugin
is not affiliated with or endorsed by the author; see [NOTICE.md](NOTICE.md).

## What it does

- **Offers at the right moment, and only then.** When a turn in one of your threads ends after a
  commit, new source files, a schema or interface change, or when the thread's pull request merges,
  a one-line offer appears above the composer: *"Learning: you just committed "Retry turns after a
  rate limit". Want a 10–15 minute exercise on it?"* with **Start**, **Later** and **Not in this
  thread**. The decision is made from bb's own data (HEAD, the turn's file changes, PR Status), never
  by a model, so offers cost no tokens.
- **Nothing reaches an agent until you say Start.** The plugin ships no skill and adds no
  instructions or tools to your threads. Only a session you start gets the exercise instructions.
- **Sessions run beside your work.** Start forks the thread: the session's agent sees what was just
  built, and the work thread is left alone. A provider that cannot fork runs it in the thread itself
  (or choose **Run it in this thread** under More).
- **A real pause.** Each question is a card with your answer, how sure you are (1–5), **Make it more
  specific**, **Skip** and **Pause session**. The agent's turn is over while the card is open, so
  there are no hints after the question. Your answer and confidence stay in the transcript as your
  own words.
- **Caps that hold.** At most 2 finished sessions per thread, 3 offers you see per day, 2 hours between
  them; **Later** snoozes the thread for 45 minutes and 3 turns; three Laters in a row keep only
  commit and pull-request offers for a week. Offers nobody sees expire and never count.
- **The Learning tab** in each thread's side panel shows this thread's offer or session (Pause, Resume,
  Finish), starts an exercise on a topic taken from the thread (its last commit, its new files, its
  title) or one you type, and lists the project's paused and previous sessions with your answers.
- **Pause and come back.** A paused session — by you, by a 30-minute timeout, or by a bb restart —
  resumes in its thread, with the open question shown again.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin learning-exercises --tag-prefix learning-exercises/
```

Needs bb 0.48 or later, with bb's bundled **Git** plugin on (it reads commits) and, for pull-request
offers, **GitHub PR Status**.

## Settings

Settings → Plugins → Learning Exercises:

| Setting | Default | |
| --- | --- | --- |
| Offer exercises | On | Off: no offers; the Learning tab still starts sessions |
| After a commit / new files / a schema change / a pull request merges | On | Each trigger on its own |
| After a working streak | Off | After *Turns in a streak* turns with file changes |
| Sessions per thread, Offers per day, Hours between offers | 2, 3, 2 | The caps |
| Questions per session | 8 | The card refuses more |
| Where a session runs | A side thread | Or the work thread |
| About you | — | Your experience and goals; every session reads it |
| Files that are not new work | lockfiles, docs, generated, vendored, snapshots | gitignore patterns |
| Schema and interface files | `migrations/`, `*.sql`, `schema.prisma`, `*.proto`, `*.graphql`, `openapi.*` | gitignore patterns |

The thread menu has **Learning offers: On / Off** per thread. Projects marked **Never for this
project** are listed under the settings, each with Undo.

## Good to know

- Offers appear only in your own top-level threads: never in child threads (crew, sub-agents),
  automations, other plugins' threads or hidden workers.
- Each question card counts as "waiting for you" like any question an agent asks, so push
  notifications and Herald announce it.
- While a card is open it takes the composer's place in that thread: answer, skip or pause it.
- In a thread run "here", the session's instructions stay in that thread's history (even after a
  compaction) until the session finishes; the side-thread default avoids that.
- Your answers are stored on this machine only, in the plugin's database. Delete a session from the
  Learning tab to remove them.
- Commits made in the same workspace by another thread at the same time are not offered, since the
  plugin cannot tell whose they are.

## How it works

See [AGENTS.md](AGENTS.md).
