---
name: project-actions
description: Add or change a project's actions for the Project Actions plugin — named commands (dev server, tests, scripts) in `.bb/actions.json` that bb shows in a menu in each thread's header and runs in a terminal of the thread. Use when the user asks to add a command to that menu, or to fix an actions file the menu reports a problem in.
---
# Project actions

The Project Actions plugin reads `.bb/actions.json` at the root of the thread's workspace and lists its
actions in a menu in the thread's header (the play button). Picking one runs it in a bb terminal of the
thread, in the workspace. Which actions to run is the user's call: do not start them through the
plugin's RPCs (`bb plugin rpc call project-actions run …` would work, since bb trusts agents' calls like
the app's; this is a convention, not a lock). To run a command yourself, use your own shell, or
`bb terminal create --thread "$BB_THREAD_ID" --title <name> --command <command>` for a terminal the user
can see. Edit the file directly (below) rather than through the plugin's `save` RPC.

## The file

```json
{
  "actions": [
    { "name": "Dev server", "command": "npm run dev", "description": "Vite on http://localhost:5173" },
    { "name": "Run tests", "command": "npm test" },
    { "name": "Storybook", "command": "npm run storybook", "cwd": "packages/ui" }
  ]
}
```

- `name` (required): unique in the file ignoring case, at most 80 characters.
- `command` (required): run with the user's login shell (`$SHELL -lc`), so shell syntax works.
- `cwd` (optional): a folder relative to the repository root; no absolute paths, no `..`.
- `description` (optional): shown under the name instead of the command.
- At most 100 actions. An optional `$schema` key is allowed; any other key is an error.

Rules: strict JSON (no comments, no trailing commas). Commit the file like any other: each worktree reads
its own branch's copy, and the menu re-reads it every time it opens, so no reload is needed.

Write it as the plugin's editor does, so the user's edits there and yours produce the same bytes: 2-space
indentation, a trailing newline, each action's keys in the order name, command, cwd, description, empty
optional keys left out, and `$schema` (if any) first. The user can also edit the file in a form: **Edit
actions…** at the bottom of the menu opens it beside the thread. It saves into the worktree without
committing.

## After editing

Check the file parses (`node -e 'JSON.parse(require("fs").readFileSync(".bb/actions.json","utf8"))'` or
`jq . .bb/actions.json`) and tell the user to open the play button's menu in the thread header. If the
menu reports a problem, it names the line, the column and the action (`actions[1].command`).

Actions run on macOS and Linux machines only. A finished action's terminal stays open until Enter is
pressed or the action is picked again, which starts a fresh run.
