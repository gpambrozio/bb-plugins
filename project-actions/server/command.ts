// What a terminal runs for an action, and how its output says the action has finished.
//
// bb's own `start: { mode: "command" }` runs `$SHELL -lc <command>` and ends the terminal with it,
// so a script that finishes at once is gone before the app can show it (bb refuses to show an
// exited terminal) and its output is never seen. Instead the terminal runs a small POSIX `sh`
// wrapper (argv mode, nothing for the user's shell to re-quote): it enters the action's folder,
// checks that it is still inside the workspace once symlinks are resolved, runs the command in an
// interactive login shell of the user's `$SHELL` (so `~/.zshrc`, `~/.bashrc` and the rest load as in
// a terminal the user opens), then prints a line saying how it ended and waits for Enter before the
// terminal closes. That line
// carries an invisible marker, an OSC sequence terminals ignore, so the server can tell from the
// terminal's last output that the action is no longer running although its terminal is.
import type { Action } from "../shared/views";

/** Printed once, after the action's command ends; terminals do not draw unknown OSC sequences. */
export const FINISHED_MARKER = "\u001b]5253;bb-project-actions;finished\u0007";

/** How much of a terminal's latest output is searched for the marker. */
export const TAIL_BYTES = 4096;

/**
 * How each startup file below begins: Ctrl+C from here on ends the shell, and the folder the wrapper
 * wrote the file into is removed. The shell has the file open already, and bb can end the wrapper
 * (when the terminal is closed) without letting it clean up.
 */
const STARTUP_BEGINS = ["trap 'exit 130' INT", 'command rm -rf -- "$BB_PROJECT_ACTIONS_STARTUP"', "unset BB_PROJECT_ACTIONS_STARTUP"];

/**
 * Run by zsh as its first startup file (`ZDOTDIR` points at it), then the user's own `ZDOTDIR` is put
 * back and their `.zshenv` read. zsh looks `ZDOTDIR` up again for each later file, so `.zprofile`,
 * `.zshrc` and `.zlogin` are the user's own.
 */
export const ZSH_STARTUP = [
  ...STARTUP_BEGINS,
  "if [ -n \"${BB_PROJECT_ACTIONS_ZDOTDIR+x}\" ]; then ZDOTDIR=$BB_PROJECT_ACTIONS_ZDOTDIR; else unset ZDOTDIR; fi",
  "unset BB_PROJECT_ACTIONS_ZDOTDIR",
  'if [ -r "${ZDOTDIR:-$HOME}/.zshenv" ]; then . "${ZDOTDIR:-$HOME}/.zshenv"; fi',
].join("\n");

/**
 * bash's `--rcfile`: what a login shell reads, in its order
 * (`/etc/profile`, then the first of `.bash_profile`, `.bash_login` and `.profile`). A login shell has
 * no file of ours to read first, so bash starts as an interactive shell that is not a login one and reads
 * this in place of `.bashrc`, which a login shell does not read either.
 */
export const BASH_STARTUP = [
  ...STARTUP_BEGINS,
  "if [ -r /etc/profile ]; then . /etc/profile; fi",
  'if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"',
  'elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"',
  'elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
].join("\n");

/**
 * The `sh` family's `ENV`: what a login shell reads (`/etc/profile`, `.profile`) and the interactive
 * file, the user's own `ENV` (as `.profile` may have set it) or the shell's default (`.kshrc` for ksh,
 * `.mkshrc` for mksh). The shell expands `ENV` before reading the file it names (`ENV='$HOME/.shrc'`).
 * Each shell expands it its own way (escapes, backticks, command substitutions differ), and the shell
 * reads `ENV` only once, as this file, so the file expands only what all of them agree on: a path and
 * parameters (`$HOME`, `${RC_FOLDER}`), inside double quotes with its `"` escaped. An `ENV` with `$(`,
 * a backtick or a backslash in it could run a program, so it is not read, and the terminal says so.
 */
export const SH_STARTUP = [
  ...STARTUP_BEGINS,
  'if [ -n "${BB_PROJECT_ACTIONS_ENV+x}" ]; then ENV=$BB_PROJECT_ACTIONS_ENV; else unset ENV; fi',
  "BB_PROJECT_ACTIONS_ENV=${BB_PROJECT_ACTIONS_ENV_DEFAULT-}",
  "unset BB_PROJECT_ACTIONS_ENV_DEFAULT",
  "if [ -r /etc/profile ]; then . /etc/profile; fi",
  'if [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
  'case ${ENV-} in',
  "  '') ;;",
  "  *'$('* | *'`'* | *'\\'*) BB_PROJECT_ACTIONS_ENV=; printf '%s\\n' \"[Your ENV, $ENV, was not read for this action: only a path with \\$variables in it is, not \\$(...), backticks or backslashes.]\" >&2 ;;",
  '  *) eval "BB_PROJECT_ACTIONS_ENV=\\"$(printf \'%s\' "$ENV" | sed \'s/"/\\\\"/g\')\\"" ;;',
  "esac",
  'if [ -n "$BB_PROJECT_ACTIONS_ENV" ] && [ -r "$BB_PROJECT_ACTIONS_ENV" ]; then . "$BB_PROJECT_ACTIONS_ENV"; fi',
  "unset BB_PROJECT_ACTIONS_ENV",
].join("\n");

/** Said when the shell's startup files leave the action's folder unreachable; the action then ends with 1. */
const LOST_FOLDER = "[The action was not run: its folder could not be entered again after the shell started.]";

/**
 * Put before the command, for the `sh` family and bash, once the startup files have run: job control
 * off (the startup files may have turned it on), Ctrl+C ends the whole command, and the shell goes back
 * to the folder the wrapper checked, which a startup file that `cd`s has left. `command cd` skips a `cd`
 * function (rvm and others define one), and the backslashes skip aliases (`alias cd=jump`); the folder
 * is a physical path, so `pwd -P` must give it back.
 * Joined with `;` on one line, so the command's line numbers stay its own.
 */
export const SH_BEFORE_COMMAND =
  "set +m; trap 'exit 130' INT; " +
  `\\command \\cd -- "$BB_PROJECT_ACTION_DIR" && [ "$(pwd -P)" = "$BB_PROJECT_ACTION_DIR" ] || { printf '%s\\n' "${LOST_FOLDER}"; exit 1; }; ` +
  "unset BB_PROJECT_ACTION_DIR; ";

/** The same for zsh, whose `cd` is `builtin cd -q`: `command` means an external program there, and `-q` skips `chpwd` hooks. */
export const ZSH_BEFORE_COMMAND = SH_BEFORE_COMMAND.replace("\\command \\cd --", "\\builtin cd -q --");

/** The same for fish, in its own syntax (fish does job control and Ctrl+C by itself). */
export const FISH_BEFORE_COMMAND =
  "builtin cd -- $BB_PROJECT_ACTION_DIR; and test (builtin pwd -P) = $BB_PROJECT_ACTION_DIR; " +
  `or begin; printf '%s\\n' "${LOST_FOLDER}"; exit 1; end; ` +
  "set -e BB_PROJECT_ACTION_DIR; ";

/**
 * `$1` the workspace, `$2` the action's folder relative to it (`.` or `./web`), `$3` the command,
 * `$4` the action's name; `$5`…`$7` the startup files above for zsh, bash and the `sh` family, and
 * `$8`…`${10}` what goes before the command in each (zsh, bash and the `sh` family, fish).
 *
 * The folder is checked where and when it is used: after `cd`, `pwd -P` gives the physical
 * directory the command will run in, and it must be the workspace's own physical directory or
 * beneath it. The parser refuses `..` and absolute paths, but only by spelling; a symlink in the
 * repository (`linked -> ../outside`) is caught here, on the workspace's machine, just before the
 * command runs. `CDPATH` is cleared and the folder starts with `./`, so `cd` goes nowhere else.
 *
 * `trap : INT` keeps the wrapper alive through a Ctrl+C that reaches it (a trap, unlike an ignored
 * signal, is reset for the commands it starts).
 *
 * The command runs in an interactive login shell of the user's `$SHELL`, as in a terminal the user
 * opens: a login shell alone reads `.zprofile` or `.bash_profile`, but `.zshrc`, and the `.bashrc` most
 * `.bash_profile`s source behind an "interactive only" check, load only in an interactive one. The
 * shell's startup files are the user's code, run before the command, so the wrapper guards three things
 * around them:
 *
 * - **The terminal.** An interactive shell (or a startup file's `setopt monitor`) turns job control on:
 *   it moves into a process group of its own and takes the terminal, and gives it back on exit only if
 *   it ends normally (zsh `exec`s the command's last program, and nothing gives it back). So the wrapper
 *   itself does job control (`set -m`) while the shell runs: the shell is its foreground job, and when
 *   the job ends the wrapper takes the terminal back, whatever the shell did, so `read` waits for Enter.
 * - **Ctrl+C.** During the startup files, it must stop the shell before the command runs: bash, sh and
 *   dash otherwise abandon the startup files and run the command anyway. A file of the wrapper's, read
 *   before the user's (`ZDOTDIR`, `--rcfile`, `ENV`), sets `trap 'exit 130' INT`. After them, the prefix
 *   turns job control off (so the shell gets the Ctrl+C too) and sets the trap again (so the rest of a
 *   script does not run, as a terminal abandons a line).
 * - **The folder.** A startup file that `cd`s would move the command out of the folder the wrapper
 *   checked, so the prefix goes back to it (`BB_PROJECT_ACTION_DIR`, the physical path) and checks it.
 *
 * fish has no file of ours to read first, and its interactive mode runs the command after a Ctrl+C in
 * `config.fish`, so it runs as a login shell, as before: it reads `config.fish` all the same (its
 * `status is-interactive` blocks aside), and stops at a Ctrl+C there. Any other shell runs as it did in
 * 0.1.0 (`-l -c`), since the wrapper cannot write its syntax.
 */
export const WRAPPER_SCRIPT = [
  "trap : INT",
  "unset CDPATH",
  "status=1",
  'if root=$(cd -- "$1" && pwd -P) && cd -- "$1" && cd -- "$2"; then',
  "  here=$(pwd -P)",
  '  case "$root" in',
  "    /) inside=yes ;;",
  '    *) case "$here" in "$root" | "$root"/*) inside=yes ;; *) inside=no ;; esac ;;',
  "  esac",
  '  if [ "$inside" = yes ]; then',
  "    shell=${SHELL:-/bin/sh}",
  "    BB_PROJECT_ACTION_DIR=$here",
  "    export BB_PROJECT_ACTION_DIR",
  '    if startup=$(mktemp -d "${TMPDIR:-/tmp}/bb-project-actions.XXXXXX"); then',
  "      BB_PROJECT_ACTIONS_STARTUP=$startup",
  "      export BB_PROJECT_ACTIONS_STARTUP",
  "      set -m",
  '      case "${shell##*/}" in',
  "        zsh)",
  '          printf \'%s\\n\' "$5" > "$startup/.zshenv"',
  '          if [ -n "${ZDOTDIR+x}" ]; then BB_PROJECT_ACTIONS_ZDOTDIR=$ZDOTDIR; export BB_PROJECT_ACTIONS_ZDOTDIR; fi',
  '          ZDOTDIR=$startup "$shell" -i -l -c "$8$3" ;;',
  "        bash)",
  '          printf \'%s\\n\' "$6" > "$startup/bashrc"',
  '          "$shell" --rcfile "$startup/bashrc" -i -c "$9$3" ;;',
  "        sh | dash | ash | ksh | ksh93 | mksh)",
  '          printf \'%s\\n\' "$7" > "$startup/env"',
  '          if [ -n "${ENV+x}" ]; then BB_PROJECT_ACTIONS_ENV=$ENV; export BB_PROJECT_ACTIONS_ENV; fi',
  '          case "${shell##*/}" in ksh | ksh93) BB_PROJECT_ACTIONS_ENV_DEFAULT=$HOME/.kshrc ;; mksh) BB_PROJECT_ACTIONS_ENV_DEFAULT=$HOME/.mkshrc ;; *) BB_PROJECT_ACTIONS_ENV_DEFAULT= ;; esac',
  "          export BB_PROJECT_ACTIONS_ENV_DEFAULT",
  '          ENV=$startup/env "$shell" -i -c "$9$3" ;;',
  '        fish) rm -rf "$startup"; "$shell" -l -c "${10}$3" ;;',
  '        *) rm -rf "$startup"; "$shell" -l -c "$3" ;;',
  "      esac",
  "      status=$?",
  "      set +m",
  '      rm -rf "$startup"',
  "      unset BB_PROJECT_ACTIONS_STARTUP",
  "    else",
  "      printf '[%s was not run: no temporary folder for its shell'\\''s startup.]\\n' \"$4\"",
  "    fi",
  "  else",
  "    printf '[%s was not run: its folder %s is %s, outside the workspace %s.]\\n' \"$4\" \"$2\" \"$here\" \"$root\"",
  "  fi",
  "fi",
  "printf '\\n\\033[2m[%s ended with exit code %s. Press Enter to close this terminal.]\\033[0m\\033]5253;bb-project-actions;finished\\007' \"$4\" \"$status\"",
  "read -r _",
  'exit "$status"',
].join("\n");

/** Whether a workspace path is a Windows one, where there is no `/bin/sh` to run the wrapper. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The action's folder, relative to the workspace, as the wrapper's `cd` takes it. */
export function relativeFolder(action: Pick<Action, "cwd">): string {
  return action.cwd === null ? "." : `./${action.cwd}`;
}

/** The argv bb's terminal starts for an action in a workspace. */
export function actionArgv(workspacePath: string, action: Action): string[] {
  return [
    "/bin/sh",
    "-c",
    WRAPPER_SCRIPT,
    "bb-project-actions",
    workspacePath,
    relativeFolder(action),
    action.command,
    action.name,
    ZSH_STARTUP,
    BASH_STARTUP,
    SH_STARTUP,
    ZSH_BEFORE_COMMAND,
    SH_BEFORE_COMMAND,
    FISH_BEFORE_COMMAND,
  ];
}

/** Whether a terminal's latest output shows its action has finished. */
export function hasFinished(tail: string): boolean {
  return tail.includes(FINISHED_MARKER);
}
