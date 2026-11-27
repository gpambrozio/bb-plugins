// Code Mode for bb: the decision half of the wrapper bb runs instead of `claude`.
//
// The Code Mode plugin's host entry writes this file, and the `bb-claude-code-mode` launcher beside
// it, into the plugin's host-data folder on each machine where a thread runs in Code Mode. The plugin
// hands bb the launcher as BB_CLAUDE_CODE_EXECUTABLE for those threads only, so everything that comes
// here belongs to a thread that chose Code Mode (or to a fork of one).
//
// Claude Code takes the Code Mode opt-in for an Agent SDK session (the way bb runs a thread) only from
// the env block of its --settings JSON; a process variable is ignored. So for an SDK session this adds
// env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE="1" to the --settings JSON bb passes (or adds a --settings).
// A resumed session gets the flag too, unless its transcript's last Code Mode marker says it is off
// (Claude Code could not run it there, and that session resumes as it started). A transcript with no
// marker gets it: a fork's copy of a Code Mode session has none (bb forks through the Agent SDK, which
// copies the conversation but not the marker), and Claude Code turns Code Mode on for such a session
// when the flag is set. Only threads the plugin put in Code Mode reach this wrapper, so an ordinary
// session never comes here. Anything else (--version, doctor, update, auth) passes through unchanged.
//
// It cannot exec, so it prints a plan, and the launcher execs the real claude:
//   line 1  the real claude's path, or nothing when none was found
//   line 2  "pass", "append", or "replace <index>" (the index into the arguments)
//   line 3  the new --settings argument for "append" and "replace", else nothing
//   line 4  "." (so the launcher can tell a whole plan from a cut-off one)
// Anything this script cannot parse is passed to the real claude unchanged and logged. It never logs
// arguments or environment values (prompts and tokens live there), only its decision, the bb thread
// id, the session id and the reason, one JSON line per launch in wrapper.log beside this file.
//
// Plain Node with no dependencies: the plugin's tests import it, and the launcher runs it with the
// host daemon's own Node, so it must not need anything that machine might lack.
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FLAG = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";
export const GUARD = "BB_CODE_MODE_WRAPPED";
const LOG_LIMIT = 1024 * 1024;
/** Claude Code session ids are UUIDs; anything else is not looked up on disk. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `{ index, value, inline }` of the last `--name value` / `--name=value`, or null. */
export function optionValue(args, name) {
  let found = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name && i + 1 < args.length) found = { index: i, value: args[i + 1], inline: false };
    else if (arg.startsWith(`${name}=`)) found = { index: i, value: arg.slice(name.length + 1), inline: true };
  }
  return found;
}

export function isSdkSession(args) {
  return optionValue(args, "--input-format")?.value === "stream-json";
}

/** The session's last Code Mode marker (true or false), or null when it has none or no transcript. */
export function codeModeMarker(sessionId, env, home) {
  if (!SESSION_ID.test(sessionId)) return null;
  const projects = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
  let folders;
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const path = join(projects, folder, `${sessionId}.jsonl`);
    if (!existsSync(path)) continue;
    let state = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"repl-mode"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "repl-mode") state = entry.replMode === true;
      } catch {
        // A torn line: the transcript's other entries still count.
      }
    }
    return state;
  }
  return null;
}

/** How to turn the flag on: replace the --settings argument at `index`, or append one. */
export function withFlag(args) {
  const found = optionValue(args, "--settings");
  if (found === null) return { action: "append", value: JSON.stringify({ env: { [FLAG]: "1" } }) };
  // A settings *file path* is not JSON and throws here, so the launch passes through unchanged.
  const settings = JSON.parse(found.value);
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) throw new TypeError("--settings is not a JSON object");
  const env = settings.env ?? {};
  if (env === null || typeof env !== "object" || Array.isArray(env)) throw new TypeError("--settings env is not an object");
  settings.env = { ...env, [FLAG]: "1" };
  const merged = JSON.stringify(settings);
  return found.inline ? { action: "replace", index: found.index, value: `--settings=${merged}` } : { action: "replace", index: found.index + 1, value: merged };
}

/** `{ plan, decision, reason, session }` for one launch. */
export function decide(args, env, home) {
  if (env[GUARD]) return { plan: { action: "pass" }, decision: "pass", reason: "already wrapped", session: null };
  if (!isSdkSession(args)) return { plan: { action: "pass" }, decision: "pass", reason: "not an SDK session", session: null };
  const session = optionValue(args, "--resume")?.value ?? null;
  if (session !== null) {
    const marker = codeModeMarker(session, env, home);
    if (marker === false) return { plan: { action: "pass" }, decision: "pass", reason: "resumed session marked without Code Mode", session };
    return { plan: withFlag(args), decision: "on", reason: marker ? "resumed Code Mode session" : "resumed session with no Code Mode marker", session };
  }
  return { plan: withFlag(args), decision: "on", reason: "new session", session: null };
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The native installer's symlink, which `claude update` repoints; then PATH. Never this wrapper. */
export function realClaude(env, home, selves) {
  const own = new Set(selves.filter(Boolean).map(realpathOr));
  const candidates = [env.BB_CODE_MODE_REAL_CLAUDE, join(home, ".local", "bin", "claude")];
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, "claude"));
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate) && !own.has(realpathOr(candidate))) return candidate;
  }
  return null;
}

export function planText(claude, plan) {
  const action = plan.action === "replace" ? `replace ${plan.index}` : plan.action;
  return `${claude ?? ""}\n${action}\n${plan.action === "pass" ? "" : plan.value}\n.\n`;
}

function log(dir, entry) {
  try {
    const path = join(dir, "wrapper.log");
    if (existsSync(path) && statSync(path).size > LOG_LIMIT) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never stop a thread from starting.
  }
}

export function main(args, env, home, selfPath) {
  const claude = realClaude(env, home, [selfPath, env.BB_CODE_MODE_LAUNCHER]);
  let result;
  try {
    result = decide(args, env, home);
  } catch (error) {
    result = { plan: { action: "pass" }, decision: "pass", reason: `error: ${error?.name ?? "Error"}`, session: null };
  }
  if (claude === null) result = { ...result, plan: { action: "pass" }, decision: "fail", reason: "no real claude" };
  log(dirname(selfPath), {
    at: new Date().toISOString(),
    pid: process.pid,
    thread: env.BB_THREAD_ID ?? null,
    session: result.session,
    decision: result.decision,
    reason: result.reason,
  });
  return planText(claude, result.plan);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathOr(process.argv[1]) === realpathOr(selfPath)) {
  process.stdout.write(main(process.argv.slice(2), process.env, homedir(), selfPath));
}
