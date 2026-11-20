# AGENTS.md

A bb plugin that adds a **Project actions** menu to every thread's header: the named commands in the
project's `.bb/actions.json`, each run in a bb terminal of that thread, in its workspace. It is not a
Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `project-actions`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the service to bb: thread → environment → machine and folder, `bb.sdk.files.read` on that machine, `bb.sdk.terminals` for the runs, `bb.storage.kv` for which terminal each action's last run went to. Forgets a thread's runs when it is archived or deleted. |
| `server/service.ts` | Over injected ports: `list` (read and parse the file, each action's run status) and `run` (start, show again, or replace a finished run), one run at a time per thread. |
| `server/command.ts` | The `/bin/sh` wrapper a terminal runs for an action, the marker it prints when the action ends, and the action's folder. |
| `shared/actions-file.ts` | Parsing and checking the file, with each problem's line, column and path. Server only (jsonc-parser stays out of the app). |
| `shared/views.ts` | What the server answers (zod schemas, used by the contract), the file's path, the README link, how a problem's location reads. No SDK import and no parser, so the app imports it at run time. |
| `shared/contract.ts` | The app ⇄ server RPC contract. The app imports it as a type only (`app/imports.test.ts`). |
| `app.tsx` | Registers the header button, or the fallback (below). |
| `app/actions-menu.tsx` | The header button and its menu. |
| `app/actions-panel.tsx` | The fallback tab for a bb without the old header slot. |
| `app/model.ts` | The words for each state of the file, shared by the menu and the panel. |
| `app/use-actions.ts` | Loading the list, running an action and opening its terminal. |
| `shots/shots.mjs` | README screenshots and the demo GIF (`npm run shots -- project-actions` in `tools/shots`). |

`npm test` runs everything. The wrapper is run for real under `/bin/sh` (`server/command.test.ts`);
the server runs against the SDK's fake host; the menu renders in jsdom against fake RPCs.

## Decisions

**The file is read on the workspace's machine, every time.** `bb.sdk.files.read` with the environment's
`hostId` and `rootPath`: a worktree reads its own branch's file, a thread on another bb machine reads that
machine's copy, and there is no cache to go stale; the menu reads on open and a run reads again before it
starts, so it never runs a command the file no longer has. No `bb.host` entry is needed: bb's file API
and host daemons already reach the machine. A failed read whose error says "not found" is the empty state;
any other failure is shown as it is.

**The header button needs the old header slot.** A menu needs a component of the plugin's own in the
header, which only `experimental_threadHeaderAction` draws. It is untyped since SDK 0.6.92 and `bb plugin
build` warns that it is retired, but bb 0.49 and 0.50 draw it and say existing plugins remain supported. A
`placement: "header"` thread action is a plain button that bb merges with every other plugin's into one
split button, and it shows no `choices`, so it is only the fallback: when `app.slots` has no old slot,
the plugin registers one that opens a thread tab listing the same actions (`app/actions-panel.tsx`).

**The terminal runs a wrapper, not bb's command mode.** `start: { mode: "command" }` runs `$SHELL -lc
<command>` and ends the terminal with the command. A script that finishes quickly is then gone before the
app opens it (`experimental_openTerminal` refuses an exited terminal), and its output is never seen. So
the terminal starts in argv mode: `/bin/sh -c <wrapper> bb-project-actions <dir> <command> <name>`. The
wrapper `cd`s, runs the command as bb would (`"$SHELL" -lc`, so the user's PATH and shell syntax hold),
prints `[<name> ended with exit code N. Press Enter to close this terminal.]` and waits for Enter. The
command, folder and name are arguments, never spliced into the script, so nothing in the file is
re-quoted. `trap : INT` keeps the wrapper alive through a Ctrl+C that stops the command (an ignored
signal would be inherited by the command; a trapped one is reset for it).

**Running or finished is read from the terminal.** bb says a terminal is running until the wrapper exits,
which is after Enter. To tell a finished action from a running one, the wrapper's last line carries an
invisible OSC sequence (`ESC ] 5253;bb-project-actions;finished BEL`, ignored by terminals), and the server
looks for it in the terminal's last 4 KB (`terminals.output` with `tailBytes`). Picking a running action
shows its terminal; picking a finished one closes its terminal and starts again; picking one whose terminal
is gone starts again.

**Which terminal is an action's** is the plugin's own record, `runs:<threadId>` in `bb.storage.kv` (action
name → terminal id), not the terminal's title: the user can rename a tab, or open one with the same name.
Runs whose terminals have ended are dropped from the record on the next run. Runs are serialized per
thread, so a double click starts one terminal.

**Windows is refused.** The wrapper needs `/bin/sh`. A workspace path that looks like Windows (`C:\…`,
`\\server\…`) gets "runs actions on macOS and Linux machines only" instead of a guess at PowerShell.

**Strict JSON.** The file is plain JSON so other tools read it; jsonc-parser is used for its error offsets
and node positions, with comments and trailing commas refused. Import its ESM build
(`jsonc-parser/lib/esm/main.js`): its `main` is a UMD build with a lazy `require("./impl/format")` that
bb's server bundle cannot resolve, so the plugin fails to load — at run time, not at build time
(`shared/actions-file.test.ts` guards the import). Unknown fields are refused so a misspelt `comand` is an
error, not a silently missing command.

## Live checks

Use the shots harness with `--keep` (`tools/shots/README.md`): it seeds three projects (an actions file,
none, and one with a mistake) with a thread each. bb draws terminals on a WebGL canvas, so a page has no
terminal text to wait on (read it with `bb terminal output <id> --plain`), and headless Chromium captures
the canvas blank at 2×: shots that show a terminal are taken at 1×.
