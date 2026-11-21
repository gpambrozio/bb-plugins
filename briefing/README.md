# Briefing

Where every thread stands, in one command: `bb briefing` prints every root thread in bb — its title,
project and status, the message that started it, the user's latest message, the agent's latest reply and
any sub-thread that is blocked, failed or waiting on a decision — each project's description, and, when
FirstMate is aboard, the first mate's tasks by state.

It was made for a voice assistant's session-start briefing ([Handsfree](https://github.com/swairshah/bb-handsfree)
runs plugin commands as a tool), so the text always fits in 4,000 characters, and it reads everything
without moving the screen: it works with any thread on screen, or none.

The plugin only reads. It sends nothing to any thread, writes no file and keeps no state.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin briefing --tag-prefix briefing/
```

## Commands

| Command | What it prints |
| --- | --- |
| `bb briefing` | The whole briefing, at most 4,000 characters. |
| `bb briefing thread <id>` | One thread in depth: its opening message, the user's last three messages, the agent's whole latest reply, every sub-thread with its status line, and, for the first mate's thread, every task. Also at most 4,000 characters. |
| `--json` on either | The data instead of the text, with nothing left out for size. |

### What the briefing holds

- **Root threads**: every thread with no parent that is not archived (or hidden), most urgent first — the
  ones waiting on the user, then the first mate, then the most recently updated. Each one gets its title,
  project and status (working, idle, failed…), its opening message, the user's latest message, the agent's
  latest reply, and how many sub-threads it has, at any depth, naming any that is waiting for an answer,
  failed, or whose last line is a `blocked:`, `needs-decision:` or `failed:` status line, with its reason.
- **The user's messages** are what the user typed: bb's notices about sub-threads, messages from other
  threads and notes plugins send on someone's behalf are left out.
- **Projects**: what each project is about, from the opening of its `AGENTS.md`, else its `CLAUDE.md`, else
  its `README.md`, skipping titles, badges and the "This file provides guidance…" line. It is read from the
  project's checkout on whichever machine holds it, so projects on other bb machines work; when that machine
  is offline, a thread's workspace is tried instead, and the briefing says when neither answered.
- **FirstMate's tasks**, when the [FirstMate Crew](../firstmate-crew) plugin is installed and its first mate's
  thread is a root thread: what needs you (held tasks, with the question, and the captain's calls), what is
  blocked (waiting on another task, or a crewmate that is blocked, needs a decision, waits for an answer or
  failed), in flight, queued, done recently (newest first, by the date each landed), and the first mate's
  suggested next steps. Each is its title in plain words: no ids, links or notes. The data is FirstMate
  Crew's own board, so it matches what its board shows.

Messages and descriptions are cleaned for reading aloud: code blocks, links, URLs and bb ids are taken out,
and each is cut to its first sentences. Thread ids stay in square brackets after each title, so a voice
model can pass them to its tools.

### Fitting in 4,000 characters

When everything does not fit, detail goes in this order: messages are cut to one sentence; the user's
latest message is kept only for threads that need you; the threads after the first few keep one line
each; then the oldest threads go; then project descriptions and the remaining messages. The last line
before the hint says what was left out ("Left out to fit: …"), and `bb briefing thread <id>` gives any one
thread in full.

### A sample

From the live check in a throwaway bb (`briefing/shots/shots.mjs`), with four threads of interest and
twenty fillers:

```text
Briefing: 24 root threads, 1 needs you.

FirstMate's tasks:
Needs you: Postgres or SQLite for the analytics store? (Postgres or SQLite).
Blocked: Wire the payments sandbox (worker is blocked); Fix the login redirect (worker needs a decision); Add full-text search to the API (waits on another task).
Queued: Rewrite the onboarding emails.
Done recently: Add a captcha to sign-up; Publish the API reference.
Suggested next: Land the login fix; Pick the analytics store.

Threads, most urgent first:
- Clean the build folder (Acme Web, working, needs you) [thr_qkbrzd7rmv]
  Asked: Clean the build folder before the next deploy.
  Agent last: Cleaning it now.
- FirstMate thread: First mate (FirstMate, idle) [thr_b5kherk27f]
  2 sub-threads: Fix the login redirect needs a decision; Wire the payments sandbox is blocked.
  Asked: ahoy!
  Agent last: Captain, the login fix is green and waits on your word to merge.
- Filler thread 19 (Acme API, idle) [thr_eg5iy7d4tw]
  Asked: Filler task 19: a long opening message that goes on for a while to press on the briefing's size budget, with more…
  Agent last: Finished this filler task.
… (fillers 18 to 0 cut here: five more entries with their messages, then one line each)
- Profile search (Acme API, failed) [thr_4333u7bnme]
- Release notes for 2.4 (Acme API, idle) [thr_nayq54qqav]

Projects:
- Acme Web: Acme Web is the customer site: sign-up, sign-in and the dashboard.
- FirstMate: Home of the first mate, who runs a crew of worker threads across all the user's projects and keeps their task list.
- Acme API: The public Acme API, with keys per customer and rate limits per plan.

Left out to fit: messages cut to their first sentence; why sub-threads are blocked; the user's latest message except where a thread needs you; messages of every thread after the first 8.
More on one thread: bb briefing thread <id>.
```

The whole text was 3,598 characters.

## Using it from Handsfree

Handsfree's `run_plugin_command` tool reaches any installed plugin's command, as long as its *Plugin
commands* setting exposes `briefing` (its default, `all`, does). In a session-start briefing in
Handsfree's instructions, these lines replace the numbered steps that note the thread in view, list the
threads, read each one, read each project's AGENTS.md and return to the first thread:

```text
1. Get the whole briefing in one call: run_plugin_command with plugin_id "briefing" and argv []. It does not change the screen and works with any thread in view, or none, so there is no need to note or restore the thread in view. It returns:
   - "FirstMate's tasks": what needs the user (held decisions, with the question in brackets), what is blocked (with why), in flight, queued, done recently, and the first mate's suggested next steps.
   - "Threads, most urgent first": one entry per root thread, with its project and status ("needs you" when it waits on the user), how many sub-threads it has and which of them are blocked or waiting on a decision, "Asked:" (the user's opening message), "User last:" (the user's latest message) and "Agent last:" (the agent's latest reply). The FirstMate thread is marked "FirstMate thread:".
   - "Projects": what each project is about.
   - "Left out to fit:" when the briefing was too long to give everything.
   Sub-threads are already counted under their root; do not brief them on their own.
2. For more on one thread, when the user asks or the briefing left its details out: run_plugin_command with plugin_id "briefing" and argv ["thread", "<id>"], with the id from the square brackets after its title. It gives the thread's opening message, the user's last few messages, the agent's whole latest reply, every sub-thread with its last status line, and, for the FirstMate thread, every task.
3. Ids are in square brackets only so you can pass them to tools. Never read them aloud.
```

In the FirstMate paragraph, the bullets that read `data/backlog.md`, `data/suggestions.md` and each worker
with `read_thread` are no longer needed: the briefing's FirstMate section and the first mate's sub-thread
line hold the same, and `bb briefing thread <first mate id>` gives every task.

## Requirements

bb 0.49 or newer. FirstMate's section needs the FirstMate Crew plugin (0.4 or newer); without it the
briefing has no FirstMate section and says nothing about it.
