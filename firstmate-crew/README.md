# FirstMate

A [bb](https://getbb.app) plugin: talk to one agent, ship with a crew.

You talk to a single agent, the **first mate**, and it runs the crew for you. Every task goes to a
**worker**: its own bb thread, in its own git worktree, so parallel work on one repository never
collides. The first mate writes each worker's instructions, supervises it to the end, and brings you
finished branches and pull requests, investigation findings, and only the decisions that are really
yours. You are the captain.

The first mate is an ordinary pinned thread, in bb's own chat, so you talk to it there and open its
tool calls like any other thread's. Its workers are its child threads in bb's sidebar. A **FirstMate**
tab on the first mate's thread puts a board of the crew beside it: Queued, Working, Blocked, Parked,
Done, Failed and Idle, each worker's last word on what it is doing, and a link to its pull request.

This is a bb port of the Paseo `firstmate` plugin in
[`gpambrozio/paseo-plugins`](https://github.com/gpambrozio/paseo-plugins), itself a take on
[firstmate](https://github.com/kunchenguid/firstmate) by Kun Chen. bb already supervises child threads
(it tells the first mate when a worker finishes, fails, is interrupted or needs attention) and already
has a chat, so the plugin is the charter, the board, the dispatch command and the watch runner, and
nothing else.

## What you need

- bb 0.44 or newer.
- A capable model for the first mate. It spends its day reading records and deciding who does what, and a
  small model gets the commands wrong. Claude Sonnet or better, or a comparable Codex model, works.
- `git` for the projects it works on, and, for the pull request watch, the `gh` command, logged in.

## Install

From the BB Community marketplace, once it is listed there: find **FirstMate Crew** under Plugins in bb,
or run

```bash
bb plugin install firstmate-crew@bb-community
```

Straight from this repository, tracking compatible releases:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin firstmate-crew --tag-prefix firstmate-crew/
```

Add `--yes` to skip the confirmation prompt, which a script needs. To hack on it, clone the repository,
run `npm install --include=dev` in `firstmate-crew/`, then `bb plugin install path:$PWD --yes` from
there, and `bb plugin dev` to rebuild on save. See [`AGENTS.md`](AGENTS.md).

## Getting started

1. Open bb's settings, find **FirstMate**, pick the first mate's provider and model, and press **Launch**.
   If you already started a thread in the first mate's home (the **Home directory** setting), open its
   **FirstMate** tab and press **Adopt this thread** instead. Only a thread working in the home can be
   adopted, because the charter the first mate follows is the home's `AGENTS.md`.
2. The first mate is now pinned in the sidebar, in a project called **FirstMate** (its home). Open it and
   tell it about a project: "the web app is in bb as `web` and ships through pull requests". It keeps a
   registry, so you say this once.
3. Ask for work: "fix the flaky login test and add dark mode". Two workers appear under it in the sidebar
   and on the board, each in its own worktree. Minutes later:

   > PR ready for review, captain: https://github.com/you/web/pull/42 (fix the flaky login test - risk: low - CI green)

4. "Merge it." The first mate never merges without your word, unless you have told it a project may.

## Talking to the first mate

- Type in the first mate's chat, or send from anywhere: `bb firstmate-crew tell "…"` reaches it from a shell.
- **Bearings** is where everything stands in four sections: what needs your call, what landed, what is
  under way, what is next. **Ahoy** is what happened since you last spoke, then each open decision, one at
  a time, with a recommendation. Both are buttons on the board and entries in the command palette
  (FirstMate: bearings, FirstMate: ahoy), next to FirstMate: open.
- **Suggestions.** When the first mate has an idea of what you will want next ("Land web#42"), it shows
  as a button above the columns. Pressing one sends that request to the first mate as if you had typed
  it; it joins a turn under way, or starts one, and never interrupts. The trash takes a suggestion off
  the list without sending it.
- **Compact** and **Restart** sit beside Bearings and Ahoy at the top of the board, with a gear that
  opens FirstMate's settings. Compact has bb summarise the first mate's conversation to free room, as
  bb's own `/compact` does. Restart starts the first mate afresh on the same thread, after asking you:
  the old conversation stays readable above bb's "context cleared" line, its records carry over, and the
  workers keep going and stay its crew. Both wait until the first mate is between turns.

## The board

Press **FirstMate** on the first mate's thread. Each card is a worker, a backlog item, or both:

- **Steer** sends a word straight to the worker. The first mate hears about it when the worker's turn
  ends, as with any turn.
- **Interrupt** stops the worker's current turn.
- **Relaunch** asks the first mate for a fresh worker in the same worktree, with your note. The work on
  disk carries over; the conversation does not.
- **End** archives the worker. If its task is not in Done, it asks first: bb removes the worktree after
  its grace period, and only committed work can be restored.
- **Open thread** goes to the worker's own thread.

The sections are stacked and foldable, empty ones are hidden, and the arrows on each section's header
move it up or down; this browser remembers the folds and the order. On a worker's own thread the
FirstMate tab shows just its card, with a note box that tells the first mate something about that worker
without touching the worker; on any other thread it offers to adopt it (when it works in the home), or a
way to the first mate.

Above the sections, the board shows a notice when FirstMate's own charter has moved on since you edited
yours, and below them the watches.

## The first mate's home

The first mate keeps its charter and records in a directory of its own, by default `~/FirstMate`, set in
the plugin's settings, and registered in bb as the **FirstMate** project. It writes there and nowhere
else: your projects are read-only to it, and every change is a worker's job. Open the home in bb's file
panel to read or edit any of it.

| File | What it is |
| --- | --- |
| `AGENTS.md` | The charter as the first mate reads it, filled in and rewritten by the plugin. Do not edit it. |
| `data/charter.md` | What that is written from. The plugin's charter until you edit it; then yours, and a changed plugin charter is put beside it as `data/charter.new.md` for you to compare. |
| `data/captain.md` | Your standing orders. They outrank the charter, except its hard rules. |
| `data/opening.md` | The first message a new first mate gets. Yours to change. |
| `data/projects.md` | How each project ships: direct pull request, local only, reviewed pull request, and whether it may merge green work itself. |
| `data/backlog.md` | Every work item; the board draws from it. |
| `data/suggestions.md` | The suggestion buttons. |
| `data/learnings.md` | Facts worth keeping across sessions. |
| `data/<task>/` | Each task's brief, and a scout's report. |
| `watches/` | The scripts the plugin runs on a schedule. |

The plugin never overwrites `captain.md`, `opening.md`, or the records once written.

## Watches

A watch is an executable in the home's `watches/` folder with a `# schedule: <crontab>` line near the top.
The plugin runs each on its schedule, in the server's local time, and whatever it prints reaches the first
mate as one note once the first mate is between turns. In chat the note is one line naming the watches,
with a **full note** chip that opens the whole message; the home keeps the last 50 in
`.firstmate/watch-notes/`. Printing nothing costs nothing. `pr-watch` comes
built in: every five minutes it checks the pull requests on the backlog and tells the first mate when one
is merged or closed, gets a review or comment, or has its checks go red or green. The Watches card lists
each watch with its last run, and switches any of them off or on. `watches/README.md` in the home explains
how to write one; the first mate adds none without your approval.

## Settings

- **Home directory**: where the first mate's records live. Default `~/FirstMate`.
- **Crew provider**, **crew model** and **crew reasoning**: what workers are started with. Left empty, the
  first mate chooses; a model is used only with a provider.
- **Board refresh**: how often the open board reloads, in seconds. Default 10.

The board's gear opens this page. The settings also hold the first mate's status, **Launch**, **Restart**
and **Release**. Release lets go
of the thread, leaving it and its crew as they are.

## Limitations

- **Watches run only while bb does, on the machine running the bb server**, and so does the home. The
  first mate's workers can be on any machine bb reaches, but a home on another machine is not supported.
- **End removes a worker's worktree after bb's grace period**; only committed work can be restored.
- There is no `/fm` slash command; bb has no composer command API. Use the command palette or
  `bb firstmate-crew tell`.
- Changing the crew settings changes what the charter says only on the next launch, restart or plugin
  reload.
- The Files view and the chat of the Paseo plugin are bb's own here.

## License

[MIT](../LICENSE)
