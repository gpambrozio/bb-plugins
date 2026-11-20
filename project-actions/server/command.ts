// What a terminal runs for an action, and how its output says the action has finished.
//
// bb's own `start: { mode: "command" }` runs `$SHELL -lc <command>` and ends the terminal with it,
// so a script that finishes at once is gone before the app can show it (bb refuses to show an
// exited terminal) and its output is never seen. Instead the terminal runs a small POSIX `sh`
// wrapper (argv mode, nothing for the user's shell to re-quote): it enters the action's folder,
// runs the command the way bb would (`$SHELL -lc`, so the user's PATH and shell syntax hold), then
// prints a line saying how it ended and waits for Enter before the terminal closes. That line
// carries an invisible marker, an OSC sequence terminals ignore, so the server can tell from the
// terminal's last output that the action is no longer running although its terminal is.
import type { Action } from "../shared/views";

/** Printed once, after the action's command ends; terminals do not draw unknown OSC sequences. */
export const FINISHED_MARKER = "\u001b]5253;bb-project-actions;finished\u0007";

/** How much of a terminal's latest output is searched for the marker. */
export const TAIL_BYTES = 4096;

/**
 * `$1` the folder, `$2` the command, `$3` the action's name. `trap : INT` keeps the wrapper alive
 * through a Ctrl+C that ends the command (a trap, unlike an ignored signal, is reset for the
 * command, which still gets the Ctrl+C), so a stopped dev server also says how it ended.
 */
export const WRAPPER_SCRIPT = [
  "trap : INT",
  'if cd -- "$1"; then',
  '  "${SHELL:-/bin/sh}" -lc "$2"',
  "  status=$?",
  "else",
  "  status=1",
  "fi",
  "printf '\\n\\033[2m[%s ended with exit code %s. Press Enter to close this terminal.]\\033[0m\\033]5253;bb-project-actions;finished\\007' \"$3\" \"$status\"",
  "read -r _",
  'exit "$status"',
].join("\n");

/** Whether a workspace path is a Windows one, where there is no `/bin/sh` to run the wrapper. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The action's folder on the workspace's machine. */
export function actionDirectory(workspacePath: string, action: Pick<Action, "cwd">): string {
  const root = workspacePath.length > 1 ? workspacePath.replace(/\/+$/, "") : workspacePath;
  if (action.cwd === null) return root;
  return root === "/" ? `/${action.cwd}` : `${root}/${action.cwd}`;
}

/** The argv bb's terminal starts for an action in a workspace. */
export function actionArgv(workspacePath: string, action: Action): string[] {
  return ["/bin/sh", "-c", WRAPPER_SCRIPT, "bb-project-actions", actionDirectory(workspacePath, action), action.command, action.name];
}

/** Whether a terminal's latest output shows its action has finished. */
export function hasFinished(tail: string): boolean {
  return tail.includes(FINISHED_MARKER);
}
