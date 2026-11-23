# AGENTS.md

A bb plugin that adds a **Project actions** menu to every thread's header: the named commands in the
project's `.bb/actions.json`, each run in a bb terminal of that thread, in its workspace, and an editor
for that file in a tab beside the thread. It is not a Paseo port.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `project-actions`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wires the service to bb: thread → environment → machine, folder and branch, `bb.sdk.files.read` / `write` on that machine, `bb.sdk.terminals` for the runs, `bb.storage.kv` for which terminal each action's last run went to. Forgets a thread's runs when it is archived or deleted. |
| `server/service.ts` | Over injected ports: `list` (read and parse the file, each action's run status), `run` (start, show again, or replace a finished run), one run at a time per thread, and the editor's `read` and `save`. |
| `server/command.ts` | The `/bin/sh` wrapper a terminal runs for an action, the marker it prints when the action ends, and the action's folder. |
| `shared/actions-file.ts` | Parsing and checking the file, with each problem's line, column and path, and writing it back (`serializeActionsFile`). Used by the server and by the editor. No SDK import. |
| `shared/views.ts` | What the server answers (zod schemas, used by the contract), the file's path, the README link, how a problem's location reads. No SDK import, so the app imports it at run time. |
| `shared/contract.ts` | The app ⇄ server RPC contract. The app imports it as a type only (`app/imports.test.ts`). |
| `app.tsx` | Registers the editor's tab, and the header button or the fallback (below). |
| `app/actions-menu.tsx` | The header button and its menu. |
| `app/actions-panel.tsx` | The fallback tab for a bb without the old header slot. |
| `app/model.ts` | The words for each state of the file, shared by the menu and the panel. |
| `app/use-actions.ts` | Loading the list, running an action and opening its terminal. |
| `app/editor.tsx` | The Edit actions tab: form and JSON views, the checks, save, conflict and reload. |
| `app/editor-model.ts` | The editor's draft without React: rows ↔ file text, moving rows, which field a problem belongs to. |
| `app/tabs.ts` | The two tab ids the panel controller opens. |
| `testing/run_in_pty.py` | Runs an action's argv in a real pseudo-terminal for `server/command.test.ts`: Ctrl+C, the finished marker, whether the wrapper still waits for Enter. |
| `shots/shots.mjs` | README screenshots and the demo GIF (`npm run shots -- project-actions` in `tools/shots`). |

`npm test` runs everything (it needs `python3` for the terminal tests). The wrapper is run for real under `/bin/sh`, and in a pseudo-terminal with each shell installed (`server/command.test.ts`);
the server runs against the SDK's fake host; the menu and the editor render in jsdom against fake RPCs.

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
the terminal starts in argv mode: `/bin/sh -c <wrapper> bb-project-actions <workspace> <folder> <command>
<name>`. The wrapper `cd`s (and checks the folder, below), runs the command in the user's shell (next
decision), prints `[<name> ended with exit code N. Press Enter to close this terminal.]` and waits for Enter. The
workspace, folder, command and name are arguments, never spliced into the wrapper, so nothing in the
file is re-quoted; the command reaches the user's shell as its `-c` script, at most after a fixed prefix.
`trap : INT` keeps the wrapper alive through a Ctrl+C that reaches it (an ignored signal would be
inherited by the command; a trapped one is reset for it).

**The command runs in an interactive login shell, guarded around its startup files.** The owner's ask: an
action sees what a terminal they open sees. A login shell alone (`$SHELL -lc`, bb's command mode) reads
`.zprofile` or `.bash_profile` but not `.zshrc`, nor the `.bashrc` most profiles source behind an
interactive-only check. But the startup files are the user's code, run after the wrapper's checks and
before the command, and a review found three ways they broke the wrapper. Each guard below has a PTY test
in `server/command.test.ts`:

- *The terminal.* An interactive shell turns job control on: it moves into its own process group, takes the
  terminal, and gives it back only if it exits normally. zsh `exec`s the command's last program
  (`npm run dev` alone), and a `.zshrc` may `setopt monitor` again, so the terminal stayed with a dead
  group and the wrapper's `read` failed or hung. So the wrapper does job control itself (`set -m`) while
  the shell runs: the shell is its foreground job, and the wrapper takes the terminal back when the job
  ends, whatever the shell did.
- *Ctrl+C during startup.* bash, sh and dash abandon their startup files on a Ctrl+C and then run the
  command anyway (zsh and ksh stop). So a file of the wrapper's, read before the user's, sets `trap 'exit
  130' INT`: zsh gets it as `.zshenv` through `ZDOTDIR` (it then restores the user's `ZDOTDIR`; zsh looks
  it up again for each later file); bash, which has no hook before a login shell's `/etc/profile`, starts
  as an interactive non-login shell with `--rcfile` and that file reads what a login shell reads, in its
  order (so `shopt login_shell` is off and `.bash_logout` is not read); the `sh` family gets `ENV`, and
  its file reads `/etc/profile`, `.profile` and then the user's own `ENV` (or ksh's `.kshrc`, mksh's
  `.mkshrc`). The shells expand `ENV` each their own way and read it only once (as our file), so it
  expands only what they agree on: a path and parameters (`ENV='$HOME/.shrc'`), inside double quotes
  with its `"` escaped. An `ENV` with `$(`, a backtick or a backslash is not read, and the terminal says
  so: an earlier `eval` of the whole value ran substitutions the shell itself would not (an escaped
  `\$(…)`, backticks in dash). The files are written to a `mktemp -d` folder, which each file removes as soon as the shell has read it (bb can end the wrapper without letting it clean up; the wrapper removes it too, in case the shell never got that far).
- *The folder.* A startup file that `cd`s moved the command out of the folder the wrapper checked. The
  wrapper exports the checked physical path as `BB_PROJECT_ACTION_DIR`, and the prefix before the command
  (`set +m; trap 'exit 130' INT; \command \cd -- "$BB_PROJECT_ACTION_DIR" && [ "$(pwd -P)" = … ] || exit 1;
  unset …; `) goes back and checks it: `command` skips a `cd` function, the backslashes an alias
  (`alias cd=jump` in a `.kshrc`). zsh's prefix uses `\builtin cd -q` (`command` means an external
  program in zsh; `-q` skips `chpwd` hooks). `set +m` and the trap there also make Ctrl+C end the whole
  command (interactive bash and sh otherwise go on to the next line). The prefix is joined with `;`, so
  line numbers stay the command's. ksh's `cd` to the folder it is already in does nothing, even when a
  startup file deleted or moved that folder; it then runs in the folder it checked, never outside.

fish has no file that runs before `config.fish`, and in interactive mode it runs the command after a
Ctrl+C there, so it runs as a login shell (`fish -l -c`, as in 0.1.0): it reads `config.fish` all the same
(not its `status is-interactive` blocks) and stops at a Ctrl+C in it, with exit code 0. A Ctrl+C at a `read`
prompt in `config.fish` only cancels the prompt, as in a terminal. fish gets the folder prefix in its own
syntax. Any other shell runs as in 0.1.0 (`-l -c`), since the wrapper cannot write its syntax.
`testing/run_in_pty.py` drives a real pseudo-terminal (Node has none). CI's Ubuntu has bash, dash and
sh; zsh, ksh and fish run where they are installed. csh and tcsh were never supported.

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

**The folder is checked physically, where the action runs.** The parser refuses absolute `cwd`s and
`..`, but only by spelling; a symlink in the repository (`linked -> ../outside`) passes it. So the
wrapper takes the workspace and the relative folder (`./web`) separately, `cd`s into both, and compares
`pwd -P` of each: the command runs only in the workspace's physical directory or beneath it, else the
terminal says the folder is outside the workspace and the action ends with exit code 1. The check runs on
the workspace's machine, in the directory the command then runs in, so nothing can change between them.
`CDPATH` is cleared, and the `./` keeps `cd` from searching it anyway.

**The RPCs are the trust boundary, not the UI.** `run` and `save` are plain plugin RPCs: other plugins,
and scripts or agents with bb's access (`bb plugin rpc call`), can call them as the app does, and bb's
caller kinds do not single out the app. The README says so; the skill asks agents not to start actions
through them, as a convention. What holds for every caller: the file is re-read and re-checked, a save
never writes an invalid file or one that changed on disk, and the folder check above.

**Windows is refused.** The wrapper needs `/bin/sh`. A workspace path that looks like Windows (`C:\…`,
`\\server\…`) gets "runs actions on macOS and Linux machines only" instead of a guess at PowerShell.

**Strict JSON.** The file is plain JSON so other tools read it; jsonc-parser is used for its error offsets
and node positions, with comments and trailing commas refused. It is in the app bundle too (about 20 KB):
the editor checks each draft with the same `parseActionsFile`, so its messages are the menu's. Import its ESM build
(`jsonc-parser/lib/esm/main.js`): its `main` is a UMD build with a lazy `require("./impl/format")` that
bb's server bundle cannot resolve, so the plugin fails to load — at run time, not at build time
(`shared/actions-file.test.ts` guards the import). Unknown fields are refused so a misspelt `comand` is an
error, not a silently missing command.

**A save moves the baseline, not the draft.** Editing stays open while a save is on its way; when it
lands, only the saved text and its hash change, so anything typed meanwhile stays in the draft, unsaved,
and the next save sends it over the file the first one wrote (`app/editor.test.tsx`).

**The editor edits the workspace's copy, and saves only what checks out.** `read` gives the file's text,
its `sha256` and the environment's branch; `save` re-checks the text with the parser (an invalid file is
never written, whatever the app sent) and writes it with `bb.sdk.files.write` with `createParents` and
`expectedSha256` (null for a file that did not exist), so a file that changed on disk since the editor
read it answers `conflict` and is left alone; the editor then offers Reload. Nothing is committed: the
editor says the change is in this worktree only. Saving never touches terminals; the menu reads the new
file the next time it opens.

**The form writes one canonical file.** `serializeActionsFile`: 2-space JSON, a trailing newline,
`$schema` first when the file had one, each action's fields in the order name, command, cwd, description,
values trimmed, empty optional fields left out. Since the parser refuses unknown keys, nothing a valid file
can hold is lost. A hand-formatted file is reformatted on its first save from the form; the JSON view
saves the text exactly as typed. A file the form cannot hold (a syntax error, say) opens in the JSON view,
and the Form view stays off until it parses. Only a command may span lines: the form's Command is a text area that grows
with its lines (`[field-sizing:content]`, `rows` as a fallback), and the parser refuses a line break in a
name, folder or description, so the one-line inputs hold every valid value exactly (an `<input>` strips
line breaks: editing such a value would silently join them). The parser reports one problem at a time, so the form shows
one error; a new row shows none until it is touched, and a line says what blocks the save instead.

**The editor is a thread tab** (`edit-actions`, `availability: "action"`), opened with the panel
controller from the header menu: bb mounts the old header slot inside the thread's panel controller.

## Live checks

Use the shots harness with `--keep` (`tools/shots/README.md`): it seeds three projects (an actions file,
none, and one with a mistake) with a thread each. The demo GIF adds a Lint action to Acme Web's actions
file through the editor, so a `--keep` run leaves that project with five actions. bb draws terminals on a WebGL canvas, so a page has no
terminal text to wait on (read it with `bb terminal output <id> --plain`), and headless Chromium captures
the canvas blank at 2×: shots that show a terminal are taken at 1×.
