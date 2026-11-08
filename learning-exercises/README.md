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
- **Feedback you can still read.** bb folds a turn's work and earlier messages into "Worked for" when
  the turn ends, so feedback written as an ordinary message would vanish from view. The agent hands its
  feedback over with its verdict instead, and the chat shows it as a card, with the verdict, just above
  the last message of that turn: above "I've asked the next question", and above the closing line after
  the last answer. The next question's card shows it above the question too, and the Learning tab keeps
  it with each question. It is stored by the plugin, so it is still there after a reload or on another
  device. A session started before this version gets its feedback back from the thread's own messages.
- **Questions that stand on their own.** The agent is told to put any code a question relies on in the
  question itself (an earlier version of a function, say), never to point "above"; a question with a
  code block left open is refused before you see it.
- **Answers in the shape the question asks for.** A question with several parts can come with an
  answer form instead of one text box: short and long text, code, numbers, sliders, single and
  multiple choice, yes/no, a 1–5 scale, putting items in order, matching pairs, a list of entries, or
  a table to fill in, laid out in sections and side by side when the card is wide enough. The agent
  is told to keep forms small and use one only when it makes answering easier; a plain question
  stays a text box. Form answers show part by part in the transcript and in the Learning tab.
- **Caps that hold.** At most 2 finished sessions per thread, 3 answered offers per day, 2 hours after
  an answer before the next; **Later** snoozes the thread for 45 minutes and 3 turns; three Laters in a
  row keep only commit and pull-request offers for a week. Only an answer counts: offers you leave
  unanswered, seen or not, expire and count toward nothing. Several can show at once; when an answer
  reaches the limit or starts the wait, the others go away.
- **The Learning tab** on the side panel's tab bar, in every thread, shows this thread's offer or session (Pause, Resume,
  Finish), starts an exercise on a topic taken from the thread (its last commit, its new files, its
  title) or one you type, and lists the project's paused and previous sessions with your answers and the
  agent's feedback; the session in progress lists its questions and feedback so far.
- **Orientation.** The Learning tab can orient you in a project you did not write. Start builds, in
  the background, a short guide to the repository: its purpose, languages, stages, key files, concepts
  and gotchas, and two exercises on the files to read first. Optionally it also writes a **walkthrough**,
  a linear tour in chapters whose code listings the plugin copies from your files itself and can
  **Verify** later (unchanged, changed or missing). **Start orientation session** runs the two exercises
  in a thread of their own; **Export to repo…** saves it as a Markdown file in the repository (the
  walkthrough in the format of [showboat](https://github.com/simonw/showboat), so `showboat verify`
  can check it). The builder is a hidden agent thread with permission to read and edit files in your
  checkout; it is told not to edit, and Start says so. Orientations are never offered, only started.
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
| Plugins whose threads get no offers | `automations` | One plugin id per line; its top-level threads get no offers. The plugin's own session threads never do, whatever it says |
| After a commit / new files / a schema change / a pull request merges | On | Each trigger on its own |
| After a working streak | Off | After *Turns in a streak* turns with file changes |
| Sessions per thread, Offers per day, Hours between offers | 2, 3, 2 | The caps; only answered offers count toward them |
| Questions per session | 8 | The card refuses more |
| Where a session runs | A side thread | Or the work thread |
| About you | — | Your experience and goals; every session reads it |
| Files that are not new work | lockfiles, docs, generated, vendored, snapshots | gitignore patterns |
| Schema and interface files | `migrations/`, `*.sql`, `schema.prisma`, `*.proto`, `*.graphql`, `openapi.*` | gitignore patterns |

The thread menu has **Learning offers: On / Off** per thread. Projects marked **Never for this
project** are listed under the settings, each with Undo.

## Good to know

- Offers appear only in top-level threads, and that includes a top-level thread another plugin
  started for you, such as one from a GitHub board card or a diff-review run. Never in child threads
  (crew, sub-agents, whoever started them), hidden workers or side chats, the plugin's own session
  threads, or the threads of plugins listed under *Plugins whose threads get no offers* (automations
  by default; add any plugin's id there).
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
