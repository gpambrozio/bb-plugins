/**
 * Runs the sentence-writing tool: one process per announcement, the prompt on
 * stdin, the sentence on stdout. There is no bb thread behind it — the tool
 * is a plain child of the bb server, started with every tool of its own
 * switched off that the preset command can switch off — so a reload has
 * nothing to find and put away: `dispose` kills whatever is still running.
 *
 * Fail closed, never queue: a tool that is slow or missing costs the plain
 * sentence, and nothing more. At most `MAX_IN_FLIGHT` processes run at once;
 * a request beyond that is refused at once.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { Log } from "./ports";
import { plainText } from "./timeline";

/** A CLI start plus one short model turn; longer, and the sentence is stale news. */
export const WRITE_TIMEOUT_MS = 20_000;

/** Two turns can end together; a third waits on nothing and gets the plain sentence. */
export const MAX_IN_FLIGHT = 2;

/** Longer than this is not one spoken sentence. */
export const MAX_SENTENCE_CHARS = 400;

/** Where the tools live when the bb server's PATH has none of them (see AGENTS.md: the server may lack Homebrew). */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")];

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `command[0]` with `command.slice(1)` as its arguments, no shell, `input` on stdin. */
export function runCommand(command: readonly string[], input: string, options: RunOptions): Promise<RunResult> {
  const [file, ...args] = command;
  if (file === undefined) return Promise.reject(new Error("The command is empty."));
  if (options.signal?.aborted) return Promise.reject(new Error("The run was aborted before it started."));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const fail = (message: string) => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(message)));
    };
    const onAbort = () => fail("The run was aborted.");
    const timer = setTimeout(() => fail(`${file} did not finish within ${options.timeoutMs / 1000} seconds`), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(() => reject(new Error(`${file}: ${error.message}`))));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    // A tool that never reads stdin closes it; that is not an error here.
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

/**
 * The reply as one spoken line: the last paragraph (a tool may print
 * progress before its answer), markdown and wrapping quotes gone, cut to
 * `MAX_SENTENCE_CHARS`.
 */
export function cleanSentence(raw: string): string {
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  const last = paragraphs[paragraphs.length - 1] ?? "";
  let line = plainText(last);
  line = line.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  if (line === "") throw new Error("The tool's reply was empty.");
  if (line.length > MAX_SENTENCE_CHARS) line = `${line.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…`;
  return line;
}

export class SentenceWriter {
  private readonly controller = new AbortController();
  private inFlight = 0;
  private folder: Promise<string> | null = null;
  private disposed = false;

  constructor(private readonly log: Log) {}

  /**
   * Runs `command` with `prompt` on stdin and returns the cleaned sentence.
   * Rejects when the writer is busy or disposed, the tool is missing, fails,
   * answers nothing, or outlives `WRITE_TIMEOUT_MS`.
   */
  async write(command: readonly string[], prompt: string): Promise<string> {
    if (this.disposed) throw new Error("The sentence writer is closed.");
    if (this.inFlight >= MAX_IN_FLIGHT) throw new Error(`The sentence writer is busy (${MAX_IN_FLIGHT} already running).`);
    this.inFlight += 1;
    try {
      const cwd = await this.workingFolder();
      const result = await runCommand(command, prompt, {
        cwd,
        env: { ...process.env, PATH: withExtraPath(process.env.PATH) },
        timeoutMs: WRITE_TIMEOUT_MS,
        signal: this.controller.signal,
      });
      if (result.code !== 0) {
        throw new Error(`${command[0]} exited with ${result.code ?? "a signal"}: ${result.stderr.trim().slice(-300) || "no error output"}`);
      }
      return cleanSentence(result.stdout);
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Kills every running tool and removes the working folder. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller.abort();
    const folder = this.folder;
    this.folder = null;
    if (folder === null) return;
    try {
      await rm(await folder, { recursive: true, force: true });
    } catch (error) {
      this.log.warn(`Could not remove the sentence writer's folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * An empty folder of Herald's own, so a tool that reads its working
   * directory — project instructions, hooks, a repository — finds nothing.
   */
  private workingFolder(): Promise<string> {
    this.folder ??= mkdtemp(join(tmpdir(), "herald-writer-"));
    return this.folder;
  }
}

function withExtraPath(path: string | undefined): string {
  const present = new Set((path ?? "").split(delimiter).filter((entry) => entry !== ""));
  const extra = EXTRA_PATH.filter((entry) => !present.has(entry));
  return [...present, ...extra].join(delimiter);
}
