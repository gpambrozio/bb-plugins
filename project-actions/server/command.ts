// What a terminal runs for an action, and how its output says the action has finished.
//
// bb's own `start: { mode: "command" }` runs `$SHELL -lc <command>` and ends the terminal with it,
// so a script that finishes at once is gone before the app can show it (bb refuses to show an
// exited terminal) and its output is never seen. Instead the terminal runs a small POSIX `sh`
// wrapper (argv mode, nothing for the user's shell to re-quote): it enters the action's folder,
// checks that it is still inside the workspace once symlinks are resolved, runs the command the way
// bb would (`$SHELL -lc`, so the user's PATH and shell syntax hold), then prints a line saying how
// it ended and waits for Enter before the terminal closes. That line
// carries an invisible marker, an OSC sequence terminals ignore, so the server can tell from the
// terminal's last output that the action is no longer running although its terminal is.
import type { Action } from "../shared/views";

/** Printed once, after the action's command ends; terminals do not draw unknown OSC sequences. */
export const FINISHED_MARKER = "\u001b]5253;bb-project-actions;finished\u0007";

/** How much of a terminal's latest output is searched for the marker. */
export const TAIL_BYTES = 4096;

/**
 * `$1` the workspace, `$2` the action's folder relative to it (`.` or `./web`), `$3` the command,
 * `$4` the action's name.
 *
 * The folder is checked where and when it is used: after `cd`, `pwd -P` gives the physical
 * directory the command will run in, and it must be the workspace's own physical directory or
 * beneath it. The parser refuses `..` and absolute paths, but only by spelling; a symlink in the
 * repository (`linked -> ../outside`) is caught here, on the workspace's machine, just before the
 * command runs. `CDPATH` is cleared and the folder starts with `./`, so `cd` goes nowhere else.
 *
 * `trap : INT` keeps the wrapper alive through a Ctrl+C that ends the command (a trap, unlike an
 * ignored signal, is reset for the command, which still gets the Ctrl+C), so a stopped dev server
 * also says how it ended.
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
  '    "${SHELL:-/bin/sh}" -lc "$3"',
  "    status=$?",
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
  return ["/bin/sh", "-c", WRAPPER_SCRIPT, "bb-project-actions", workspacePath, relativeFolder(action), action.command, action.name];
}

/** Whether a terminal's latest output shows its action has finished. */
export function hasFinished(tail: string): boolean {
  return tail.includes(FINISHED_MARKER);
}
