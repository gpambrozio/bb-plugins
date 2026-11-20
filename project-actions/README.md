# Project Actions

Runs your project's named commands — start the dev server, run the tests, seed the database — from a
menu in each thread's header. Each one runs in a terminal of that thread, in the thread's own
workspace (its worktree), and opens in bb's terminal panel.

The list lives in the project, in `.bb/actions.json`, committed like any other file, so every worktree
reads its own branch's version and everyone who opens the project gets the same menu. Write it by hand,
or with the editor the menu opens beside the thread.

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/menu-dark.png">
  <img alt="The Project actions menu open below its play button in a thread's header: Run in a terminal, then Dev server (Vite on http://localhost:5173), Run tests (node scripts/test.mjs), Storybook (The component gallery) and Seed database (Reset the local database with sample data), then Edit actions…" src="docs/screenshots/menu-light.png">
</picture>

_The menu, from the play button in the thread's header. Each action shows its description, or its command when it has none._

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/running-dark.png">
  <img alt="The thread beside bb's terminal panel, whose Dev server tab shows the dev server's output: VITE ready in 312 ms, Local: http://localhost:5173/" src="docs/screenshots/running-light.png">
</picture>

_Picking an action opens a terminal titled with its name in the thread's terminal panel._

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/menu-running-dark.png">
  <img alt="The menu again, with Running beside Dev server" src="docs/screenshots/menu-running-light.png">
</picture>

_An action still running says so. Picking it again shows its terminal instead of starting a second one._

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/invalid-dark.png">
  <img alt="The menu of a project whose actions file has a mistake: The actions file has a problem. Unknown field &quot;comand&quot;; an action has name, command, cwd and description. .bb/actions.json, line 6, column 7 (actions[1].comand). Try again, and How to write the actions file" src="docs/screenshots/invalid-light.png">
</picture>

_A mistake in the file is shown with the line, the column and the action it is in._

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/empty-dark.png">
  <img alt="The menu of a project without an actions file: No actions in this project, how to add .bb/actions.json at the project's root, and a link to how to write it" src="docs/screenshots/empty-light.png">
</picture>

_A project without the file explains how to add one, and **Add actions** opens the editor._

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/editor-dark.png">
  <img alt="The Edit actions tab beside a thread: a note that the file is saved in this thread's workspace and needs committing to reach other branches, Form and JSON views, and each action as a card with Name, Folder, Command and Description fields, move up, move down and delete buttons; Run tests' folder ../tests is marked &quot;cwd&quot; must stay inside the project (no ..)" src="docs/screenshots/editor-light.png">
</picture>

_The editor checks each change as the menu does and will not save a file with a mistake._

![In a project with no actions, Add actions opens the editor; an action named Docs preview is typed in with its command and description, saved, and the menu then lists it](docs/screenshots/editor-demo.gif)

![Picking Dev server from the menu starts it in a terminal; picking it again from the menu, where it says Running, shows the same terminal; then Run tests runs in a second terminal and ends with its exit code; and picking Dev server once more brings back its terminal](docs/screenshots/demo.gif)

## The actions file

`.bb/actions.json` at the root of the project's repository:

```json
{
  "actions": [
    { "name": "Dev server", "command": "npm run dev", "description": "Vite on http://localhost:5173" },
    { "name": "Run tests", "command": "npm test" },
    { "name": "Storybook", "command": "npm run storybook", "cwd": "packages/ui" },
    { "name": "Seed database", "command": "./scripts/seed.sh --reset", "description": "Sample data for local work" }
  ]
}
```

| Field | Required | What it does |
| --- | --- | --- |
| `name` | required | What the menu and the terminal's tab say. Unique in the file (ignoring case), up to 80 characters. |
| `command` | required | What runs, as you would type it in a terminal. It runs in your login shell (`$SHELL -lc`, as bb's own `bb terminal create --command` does), so your `PATH` from your login files and your shell's syntax, such as `&&`, work. |
| `cwd` | optional | The folder to run in, relative to the repository's root (`packages/ui`). It cannot leave the repository. The root by default. |
| `description` | optional | A line under the name in the menu, in place of the command. |

The file is strict JSON: no comments and no trailing commas, so `jq` and other tools read it too. An
optional `$schema` key is allowed. Anything else, such as a misspelt field, is refused with where it is,
rather than ignored.

The menu reads the file each time it opens, from the thread's own workspace, on the machine that holds
it — a thread on another bb machine reads that machine's copy. An edit shows up the next time you open
the menu, with no reload.

## Editing actions

**Edit actions…** at the bottom of the menu (or **Add actions** when there are none, and **Fix it in the
editor** when the file has a mistake) opens the editor in a tab beside the thread. It edits the thread's
own copy of `.bb/actions.json`, on the machine that holds the workspace.

- **Form or JSON.** The form lists each action with its name, command, folder and description; add one,
  move it up or down, or delete it. The JSON view shows the same file as text. A file the form cannot
  hold, such as one with a syntax error, opens as JSON to be fixed there.
- **Checked as the menu checks it.** Each mistake shows on its field with the menu's own message, and Save
  stays off until the file is valid. A new action shows no errors until you start filling it in.
- **Stable formatting.** The form writes 2-space JSON with a trailing newline, each action's fields in the
  order name, command, cwd, description, and leaves out empty optional fields; a `$schema` key is kept.
- **Saved in the workspace, not committed.** Saving creates `.bb/` and the file when needed. The change
  is in this thread's worktree only: commit it to share it with other branches.
- **No lost edits.** If the file changed on disk since the editor opened it, the save is refused and the
  editor offers to reload it.
- Actions already running keep running. The menu shows the new list the next time it opens.

## Running an action

Picking an action starts a terminal in the thread, titled with the action's name, in the thread's
workspace (or its `cwd`), and opens it in bb's terminal panel beside the thread.

- **Still running?** Picking it again shows its terminal; it does not start a second copy. The menu says
  *Running* beside it.
- **Finished?** The terminal stays open with the output and a line saying how it ended, such as
  *[Run tests ended with exit code 0. Press Enter to close this terminal.]*, and the menu says
  *Finished*. Picking it again closes that terminal and starts a fresh run.
- **Stopping one:** Ctrl+C in its terminal stops the command and shows how it ended; closing the
  terminal's tab ends it.

Runs are per thread: two threads, in two worktrees, each run their own dev server.

Actions run on macOS and Linux machines. A thread whose workspace is on Windows gets a message instead.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin project-actions --tag-prefix project-actions/
```

Needs bb 0.49 or newer. Nothing to configure.

## Privacy and safety

The plugin runs exactly the commands in the project's actions file, and only when you pick one. It
reads and writes no other file (it writes that one only when you save in the editor) and sends nothing
anywhere. The commands run with your permissions on the machine
that holds the workspace, as they would in a terminal you opened yourself, so treat a repository's
actions file like any script in it: read it before you run it.
