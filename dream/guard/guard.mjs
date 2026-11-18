// The dream thread's PreToolUse hook. Claude Code runs it before every tool call of a dream
// thread (the hook is declared in the dream workspace's `.claude/settings.json`) and does what it
// answers: allow or deny, never ask. It is what holds a dream to native auto-dream's limits
// (Claude Code 2.1.326) inside a bb thread, whose least privileged mode is accept-edits:
//
// - Read, Glob and Grep anywhere;
// - Bash: only `ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head` and `tail`, alone, piped or
//   chained (`|`, `&&`, `||`, `;`), with no redirection, expansion, background or writing options,
//   and `rm -f` of `.md` files inside the memory folder;
// - Write and Edit of `.md` files inside the memory folder only;
// - every other tool, MCP tools included, denied.
//
// The policy file (argv[2]) names the memory folder, the run's decision log and its canary file.
// Anything unexpected, including a crash, an unreadable policy or unparsable input, answers deny and
// exits 2, so the hook fails closed; the workspace also declares it `onFailure: "block"`, so a guard
// that cannot start or times out blocks the call too.
//
// Before a dream sees anything, its thread is asked to Write the canary file. The guard allows that
// one path and logs it, and a second hook (`--canary-fail`) fails on it on purpose. The file stays
// absent only when the guard ran *and* Claude Code honours `onFailure: "block"`; the plugin sends the
// dream prompt only then (see host/workspace.ts).
//
// Plain Node, no dependencies: the host writes this file next to the policy and runs it with the
// host daemon's own Node. `host/guard-source.ts` is generated from it (`npm run embed-guard`).

import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const READ_ONLY_COMMANDS = ["ls", "find", "grep", "cat", "stat", "wc", "head", "tail"];
const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Write", "Edit"];
/**
 * Subfolders of the memory folder a dream never writes or deletes in (as native), compared without
 * case: macOS volumes are case-insensitive, so `AGENTS/` is `agents/`.
 */
export const PROTECTED_DIRS = [".git", "agents"];

export function isProtectedName(name) {
  return PROTECTED_DIRS.includes(String(name).normalize("NFC").toLowerCase());
}
/** `find` actions that write, delete or run something. */
const FIND_WRITING = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
/** `tail` options that never end. */
const TAIL_FOLLOW = /^(-[a-zA-Z]*[fF]|--follow.*|--retry)$/;

/**
 * Splits a command line into the simple commands it runs, each a list of words, or returns why it
 * is refused. Commands may be joined by `|`, `||`, `&&` or `;`; each is checked on its own.
 * Quoting follows the shell; anything that expands, redirects or runs in the background is refused.
 */
export function tokenize(command) {
  const segments = [[]];
  let word = null;
  let i = 0;
  const push = () => {
    if (word !== null) segments[segments.length - 1].push(word);
    word = null;
  };
  const split = () => {
    push();
    if (segments[segments.length - 1].length === 0) return false;
    segments.push([]);
    return true;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return { error: "an unterminated quote" };
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= command.length) return { error: "an unterminated quote" };
        const d = command[j];
        if (d === '"') break;
        if (d === "\\" && j + 1 < command.length && '$`"\\'.includes(command[j + 1])) {
          text += command[j + 1];
          j += 2;
          continue;
        }
        if (d === "$" || d === "`") return { error: "an expansion inside double quotes" };
        if (d === "\n" || d === "\r") return { error: "a newline in a command" };
        text += d;
        j += 1;
      }
      word = (word ?? "") + text;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= command.length) return { error: "a trailing backslash" };
      const next = command[i + 1];
      if (next === "\n" || next === "\r") return { error: "a newline in a command" };
      word = (word ?? "") + next;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      i += 1;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "||" || two === "&&") {
      if (!split()) return { error: `an empty command before ${two}` };
      i += 2;
      continue;
    }
    if (c === "|" || c === ";") {
      if (command[i + 1] === "&") return { error: `the shell operator ${JSON.stringify(c + "&")}` };
      if (!split()) return { error: `an empty command before ${JSON.stringify(c)}` };
      i += 1;
      continue;
    }
    if ("&<>`$(){}\n\r#".includes(c)) {
      return { error: `the shell operator ${JSON.stringify(c)}` };
    }
    word = (word ?? "") + c;
    i += 1;
  }
  push();
  if (segments.some((segment) => segment.length === 0)) return { error: "an empty command" };
  return { segments };
}

/**
 * `target` with every symlink resolved, for the part of it that exists; the rest is appended as
 * written. Walks the path a component at a time with `lstat`, so a symlink whose destination does not
 * exist (a dangling link, which `realpath` cannot resolve) is refused rather than taken for a missing
 * file: following it would create its destination, wherever that is. Any other lookup error is
 * refused too. Throws with the reason.
 */
export function realTarget(target) {
  const parts = path.resolve(target).split(path.sep).filter((part) => part.length > 0);
  let current = path.parse(path.resolve(target)).root;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]);
    let stats;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if (error?.code === "ENOENT") return path.join(current, ...parts.slice(index));
      throw new Error(`${next} cannot be inspected (${error?.code ?? error})`);
    }
    if (stats.isSymbolicLink()) {
      try {
        current = realpathSync(next);
      } catch {
        throw new Error(`${next} is a symlink that leads nowhere`);
      }
    } else {
      current = next;
    }
  }
  return realpathSync(current);
}

/** Why `target` is not a memory file the dream may change, or null when it is one. */
export function memoryFileProblem(target, memoryDir) {
  if (typeof target !== "string" || target.length === 0) return "no path";
  if (!path.isAbsolute(target)) return "the path is not absolute";
  if (target.split(/[\\/]/).includes("..")) return "the path contains ..";
  let resolved;
  try {
    resolved = realTarget(path.normalize(target));
  } catch (error) {
    return error?.message ?? String(error);
  }
  const relative = path.relative(memoryDir, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return `${target} is outside the memory folder ${memoryDir}`;
  }
  const parts = relative.split(path.sep);
  if (parts.some(isProtectedName)) return `${target} is in a protected folder (${PROTECTED_DIRS.join(", ")})`;
  if (!resolved.endsWith(".md")) return `${target} is not a .md file`;
  return null;
}

function rmProblem(words, cwd, memoryDir) {
  const args = words.slice(1);
  if (args.some((arg) => arg.startsWith("-") && arg !== "-f" && arg !== "--")) return "rm takes no option but -f";
  if (!args.includes("-f")) return "rm needs -f";
  const files = args.filter((arg) => arg !== "-f" && arg !== "--");
  if (files.length === 0) return "rm names no file";
  for (const file of files) {
    if (/[*?[\]~]/.test(file)) return "rm takes plain paths, no patterns";
    const problem = memoryFileProblem(path.resolve(cwd, file), memoryDir);
    if (problem) return `rm: ${problem}`;
  }
  return null;
}

function bashProblem(command, cwd, memoryDir) {
  if (typeof command !== "string" || command.trim().length === 0) return "an empty command";
  const parsed = tokenize(command.trim());
  if (parsed.error) return `Shell: ${parsed.error} is not allowed in a dream`;
  for (const words of parsed.segments) {
    const name = words[0];
    if (name === "rm") {
      const problem = rmProblem(words, cwd, memoryDir);
      if (problem) return problem;
      continue;
    }
    if (!READ_ONLY_COMMANDS.includes(name)) {
      return `${name} is not one of the read-only commands a dream may run (${READ_ONLY_COMMANDS.join(", ")}, and rm -f of memory files)`;
    }
    if (name === "find") {
      const writing = words.find((word) => FIND_WRITING.has(word));
      if (writing) return `find ${writing} is not allowed in a dream`;
    }
    if (name === "tail" && words.some((word) => TAIL_FOLLOW.test(word))) {
      return "tail cannot follow a file in a dream";
    }
  }
  return null;
}

/** Whether a Write targets the run's canary file. */
export function isCanaryWrite(input, policy) {
  const canary = policy?.canary;
  const file = input?.tool_input?.file_path;
  return input?.tool_name === "Write" && typeof canary === "string" && typeof file === "string" && path.resolve(file) === canary;
}

/**
 * The decision for one PreToolUse input: `{ decision: "allow" | "deny", reason }`.
 * `policy` is `{ memoryDir, canary?, logPath? }`, absolute real paths.
 */
export function decide(input, policy) {
  const memoryDir = policy?.memoryDir;
  if (typeof memoryDir !== "string" || !path.isAbsolute(memoryDir)) {
    return { decision: "deny", reason: "The dream guard has no memory folder." };
  }
  const tool = input?.tool_name;
  const args = input?.tool_input ?? {};
  if (isCanaryWrite(input, policy)) {
    return { decision: "allow", reason: "The startup check; the companion hook blocks it.", canary: true };
  }
  if (READ_TOOLS.includes(tool)) return { decision: "allow", reason: "Reads are allowed." };
  if (WRITE_TOOLS.includes(tool)) {
    const problem = memoryFileProblem(args.file_path, memoryDir);
    return problem
      ? { decision: "deny", reason: `A dream writes only .md files in its memory folder: ${problem}.` }
      : { decision: "allow", reason: "A memory file." };
  }
  if (tool === "Bash") {
    if (args.run_in_background === true) {
      return { decision: "deny", reason: "A dream runs no background commands." };
    }
    const cwd = typeof input?.cwd === "string" && path.isAbsolute(input.cwd) ? input.cwd : "/";
    const problem = bashProblem(args.command, cwd, memoryDir);
    return problem
      ? { decision: "deny", reason: `${problem}.` }
      : { decision: "allow", reason: "A read-only command." };
  }
  return {
    decision: "deny",
    reason: `${String(tool)} is not available in a dream (only Read, Glob, Grep, read-only Bash, and Write and Edit in the memory folder).`,
  };
}

function answer(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

/** Appends one decision to the run's log, which proves to the plugin that the guard ran. */
function log(policy, input, result) {
  if (typeof policy?.logPath !== "string") return;
  try {
    const entry = { at: Date.now(), tool: String(input?.tool_name), decision: result.decision, canary: result.canary === true };
    appendFileSync(policy.logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // The canary check fails without the log, so a dream never starts on a guard that cannot log.
  }
}

/**
 * The companion hook: fails (exit 1, no answer) on the canary Write, and gives no decision on
 * anything else. Declared `onFailure: "block"`, so its failure blocks the canary Write that the guard
 * allowed; a Claude Code that ignores `onFailure` lets it through, and the canary check sees the file.
 */
function canaryFail() {
  try {
    const policy = JSON.parse(readFileSync(process.argv[3], "utf8"));
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (isCanaryWrite(input, policy)) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}

function main() {
  if (process.argv[2] === "--canary-fail") return canaryFail();
  let result;
  let policy;
  let input;
  try {
    policy = JSON.parse(readFileSync(process.argv[2], "utf8"));
    input = JSON.parse(readFileSync(0, "utf8"));
    result = decide(input, policy);
    log(policy, input, result);
  } catch (error) {
    // Exit 2 blocks the call even if Claude Code cannot read the answer.
    const reason = `The dream guard failed: ${error?.message ?? error}`;
    answer("deny", reason);
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
    return;
  }
  answer(result.decision, result.reason);
}

/**
 * Run as a script, not imported (by the tests). Compared by real path: run through a symlink, such as
 * macOS's /var for /private/var, the two spellings differ, and a guard that did not notice would
 * answer nothing and let Claude Code fall back to asking.
 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
