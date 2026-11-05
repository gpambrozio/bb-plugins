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
  own words. What you have typed but not sent is saved as you go, so leaving the thread, a reload or
  another device brings the card back as you left it.
- **Feedback you can still read.** bb folds a turn's earlier messages away when the turn ends, so the
  agent's feedback on your answer would vanish once the next card opens. The card shows it above the
  next question instead, and the Learning tab keeps it with each question, read from the thread's own
  messages (a session started before this version gets its feedback back too).
- **Questions that stand on their own.** The agent is told to put any code a question relies on in the
  question itself (an earlier version of a function, say), never to point "above"; a question with a
  code block left open is refused before you see it.
- **Answers in the shape the question asks for.** A question with several parts can come with an
  answer form instead of one text box: short and long text, code, numbers, sliders, single and
  multiple choice, yes/no, a 1–5 scale, putting items in order, matching pairs, a list of entries, or
  a table to fill in, laid out in sections and side by side when the card is wide enough. The agent
  is told to keep forms small and use one only when it makes answering easier; a plain question
  stays a text box. Form answers show part by part in the transcript and in the Learning tab.
- **Caps that hold.** At most 2 finished sessions per thread, 3 offers you see per day, 2 hours between
  them; **Later** snoozes the thread for 45 minutes and 3 turns; three Laters in a row keep only
  commit and pull-request offers for a week. Offers nobody sees expire and never count.
- **The Learning tab** on the side panel's tab bar, in every thread, shows this thread's offer or session (Pause, Resume,
  Finish), starts an exercise on a topic taken from the thread (its last commit, its new files, its
  title) or one you type, and lists the project's paused and previous sessions with your answers and the
  agent's feedback; the session in progress lists its questions and feedback so far.
- **Files open from the question.** File names in a question, its list of files to open, your past
  answers and an offer are links that open the file in bb, at the line or range the question points to.
- **Pause and come back.** A paused session — by you, by a 30-minute timeout, or by a bb restart —
  resumes in its thread, with the open question shown again.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin learning-exercises --tag-prefix learning-exercises/
```

Needs bb 0.48.1 or later, with bb's bundled **Git** plugin on (it reads commits) and, for pull-request
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
- In those threads the Learning tab is still on the tab bar, so you can start or resume a session by
  hand, with that thread as the source. A session run "here" in a child thread is a turn like any other, so its parent hears when
  it ends; the side-thread default keeps it out of the child.
- Each question card counts as "waiting for you" like any question an agent asks, so push
  notifications and Herald announce it.
- While a card is open it takes the composer's place in that thread: answer, skip or pause it.
- In a thread run "here", the session's instructions stay in that thread's history (even after a
  compaction) until the session finishes; the side-thread default avoids that.
- Your answers are stored on this machine only, in the plugin's database. Delete a session from the
  Learning tab to remove them.
- Commits made in the same workspace by another thread at the same time are not offered, since the
  plugin cannot tell whose they are.
- Answers are capped at 20,000 characters; the card says so when you reach it. A form's text fields
  have their own, smaller limits, and a form has at most 24 fields and tables of at most 60 cells.
- The `bb learning` commands act on the session of the thread they say they come from (`BB_THREAD_ID`);
  bb gives a plugin command no way to verify that, so they trust it, like everything on your machine
  that bb trusts. Other plugins cannot change your offers or sessions.

## How it works

See [AGENTS.md](AGENTS.md).
