// The launcher bb runs as BB_CLAUDE_CODE_EXECUTABLE for a Code Mode thread: a POSIX shell script, so
// that the real claude replaces it with exec (bb's signals, stdin and exit status then reach claude as
// if bb had started it). It asks code-mode-wrapper.mjs, run with the host daemon's own Node, what to
// change, and runs claude with the original arguments when that Node fails or prints no whole plan.
//
// Python is not on every machine; /bin/sh and the daemon's Node are.

/** `'…'`-quoted for sh, with every `'` closed, escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface LauncherPaths {
  /** The host daemon's Node: `process.execPath` in the host worker. bb.app's is Electron's binary. */
  node: string;
  /** code-mode-wrapper.mjs */
  script: string;
}

export function launcherScript({ node, script }: LauncherPaths): string {
  return `#!/bin/sh
# Code Mode for bb. The Code Mode plugin writes this file and rewrites it on every check, so do not
# edit it. bb runs it instead of claude for the threads that chose Code Mode; it adds Code Mode to
# claude's --settings (see code-mode-wrapper.mjs beside it) and then execs the real claude.
node=${shellQuote(node)}
script=${shellQuote(script)}
nl='
'
# ELECTRON_RUN_AS_NODE makes bb.app's Electron binary a plain Node; it is set for this one command,
# so claude does not inherit it.
plan=$(BB_CODE_MODE_LAUNCHER="$0" ELECTRON_RUN_AS_NODE=1 "$node" "$script" "$@" </dev/null 2>/dev/null) || plan=''
case $plan in
  *"$nl"*"$nl"*"$nl.")
    claude=\${plan%%"$nl"*}
    rest=\${plan#*"$nl"}
    action=\${rest%%"$nl"*}
    rest=\${rest#*"$nl"}
    value=\${rest%%"$nl"*}
    ;;
  *)
    claude=''
    action=pass
    value=''
    ;;
esac
if [ -z "$claude" ] || [ ! -x "$claude" ]; then
  # No plan: run claude exactly as bb asked.
  action=pass
  claude="$HOME/.local/bin/claude"
  [ -x "$claude" ] || claude=$(command -v claude 2>/dev/null) || claude=''
fi
if [ -z "$claude" ]; then
  echo "bb-claude-code-mode: no real claude found (~/.local/bin/claude or PATH)" >&2
  exit 127
fi
case $action in
  "replace "*)
    index=\${action#replace }
    i=0
    for arg do
      shift
      if [ "$i" -eq "$index" ]; then set -- "$@" "$value"; else set -- "$@" "$arg"; fi
      i=$((i + 1))
    done
    ;;
  append)
    set -- "$@" --settings "$value"
    ;;
esac
BB_CODE_MODE_WRAPPED=1
export BB_CODE_MODE_WRAPPED
exec "$claude" "$@"
`;
}
