/**
 * Runs the sentence-writing tool: one process per announcement, the prompt on
 * stdin, the sentence on stdout. There is no bb thread behind it — the tool
 * is a plain child of the bb server, started with every tool of its own
 * switched off that the preset command can switch off — so a reload has
 * nothing to find and put away: `dispose` kills whatever is still running.
 *
 * Fail closed, never queue: a tool that is slow or missing costs the plain
 * sentence, and nothing more. A tool that runs and answers nothing — an empty
 * reply, or an empty summary where it answers in JSON (`ReplyFormat`) — has
 * chosen silence, which is not a failure (`WrittenSentence`); JSON that is
 * missing or not the schema's is. In JSON a tool can also write a sentence
 * and ask that it not be spoken (`speak: false`). At most `MAX_IN_FLIGHT` processes run at
 * once; a request beyond that is refused at once.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import { z } from "zod";

import type { ReplyFormat } from "../shared/herald";
import type { Log } from "./ports";
import { plainText } from "./timeline";

/**
 * A CLI start plus one short model turn is about 10 s on a quiet Mac; 20 s
 * was the first limit, and a plugin build running on the same machine pushed
 * two runs past it. The sentence stays above the composer once it lands, so a
 * late one is still worth having; only one that never comes is not.
 */
export const WRITE_TIMEOUT_MS = 45_000;

/** Two turns can end together; a third waits on nothing and gets the plain sentence. */
export const MAX_IN_FLIGHT = 2;

/** Longer than this is not one spoken sentence. */
export const MAX_SENTENCE_CHARS = 400;

/** A tool that streams a file instead of answering is stopped here, not at the timeout. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

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

/**
 * `command[0]` with `command.slice(1)` as its arguments, no shell, `input` on
 * stdin. bb's host toolchain finds the tool and sets the child's PATH — the
 * login shell's, `~/.local/bin`, mise and asdf shims, Volta and Homebrew — so
 * a tool the bb server's own PATH lacks is still found, and one installed
 * after a miss is found on the next run. The tool leads its own process
 * group, and the group is killed on every way out — the timeout, an abort,
 * too much output, and the tool's own exit — so a helper it started never
 * outlives the run.
 */
export function runCommand(command: readonly string[], input: string, options: RunOptions): Promise<RunResult> {
  const [file, ...args] = command;
  if (file === undefined) return Promise.reject(new Error("The command is empty."));
  if (options.signal?.aborted) return Promise.reject(new Error("The run was aborted before it started."));
  return new Promise((resolve, reject) => {
    const child = experimental_spawnHostProcess(file, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const fail = (message: string) => {
      killGroup(child.pid, () => child.kill("SIGKILL"));
      finish(() => reject(new Error(message)));
    };
    const onAbort = () => fail("The run was aborted.");
    const timer = setTimeout(() => fail(`${file} did not finish within ${options.timeoutMs / 1000} seconds`), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (chunk: string, append: (text: string) => void) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) fail(`${file} produced too much output (over ${MAX_OUTPUT_BYTES / 1024} KB)`);
      else append(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, (text) => (stdout += text)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, (text) => (stderr += text)));
    child.on("error", (error) => finish(() => reject(new Error(`${file}: ${error.message}`))));
    child.on("close", (code) => {
      // The tool is done; anything it started and left behind is not.
      killGroup(child.pid, () => {});
      finish(() => resolve({ code, stdout, stderr }));
    });
    // A tool that never reads stdin closes it; that is not an error here.
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

/** SIGKILL to the whole group when the child has one, else to the child alone. */
function killGroup(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    fallback();
  }
}

/**
 * What a tool that ran to the end gave: one line to speak, one line to keep
 * without speaking it, or nothing at all. A prompt may ask the model to say
 * nothing to keep an event quiet ("Captain, shipshape."): an empty reply, or
 * a null or empty summary in JSON. A JSON answer can also carry a summary
 * with `speak: false` ("a worker is on it"): `unspoken`, which the hooks
 * remember but do not speak for a finished turn. Each is an answer, not a
 * failure, and a failure is a rejection, never `silent`.
 */
export type WrittenSentence = { kind: "sentence"; text: string } | { kind: "unspoken"; text: string } | { kind: "silent" };

/**
 * The reply as one spoken line: the last paragraph (a tool may print
 * progress before its answer), cleaned by `cleanLine`. A reply that is empty
 * once cleaned — blank, or only quotes or markdown — is `silent`.
 */
export function cleanSentence(raw: string): WrittenSentence {
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  return cleanLine(paragraphs[paragraphs.length - 1] ?? "");
}

/** Markdown and wrapping quotes gone, cut to `MAX_SENTENCE_CHARS`; `silent` when nothing is left. */
function cleanLine(text: string): { kind: "sentence"; text: string } | { kind: "silent" } {
  let line = plainText(text);
  line = line.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  if (line === "") return { kind: "silent" };
  if (line.length > MAX_SENTENCE_CHARS) line = `${line.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…`;
  return { kind: "sentence", text: line };
}

/**
 * What Claude Code and Codex are held to. Every field required and no others,
 * as strict-mode schemas need; the descriptions reach the model with it, so
 * a prompt that asks for "nothing", or for a summary that is only written
 * down, has a way to say so.
 */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: ["string", "null"],
      description: "The one spoken sentence, or null (or an empty string) to say nothing about this event.",
    },
    speak: {
      type: "boolean",
      description:
        "true to speak the summary aloud, as usual. false only when the instructions ask for this event to be written down without being spoken: the summary is then kept in the thread's history, unspoken.",
    },
  },
  required: ["summary", "speak"],
  additionalProperties: false,
} as const;

/** `speak` may be missing (an answer to the schema before it had one): the summary is then spoken. */
const SummarySchema = z.strictObject({ summary: z.string().nullable(), speak: z.boolean().optional() });

/** Claude Code's `--output-format json` result; the schema's object is in `structured_output`. */
const ClaudeResultSchema = z.object({ is_error: z.boolean().optional(), structured_output: z.unknown().optional() });

/** The file Codex reads `SUMMARY_SCHEMA` from, in the run's own folder. */
const SCHEMA_FILE = "summary-schema.json";

/**
 * `command` with the switches that make the tool answer in `reply`'s format.
 * Codex reads the schema from `schemaPath`, given before the trailing `-` that
 * tells it to read the prompt from stdin.
 */
export function commandFor(command: readonly string[], reply: ReplyFormat, schemaPath: string): string[] {
  switch (reply) {
    case "text":
      return [...command];
    case "claude-json":
      return [...command, "--output-format", "json", "--json-schema", JSON.stringify(SUMMARY_SCHEMA)];
    case "codex-json":
      return command[command.length - 1] === "-"
        ? [...command.slice(0, -1), "--output-schema", schemaPath, "-"]
        : [...command, "--output-schema", schemaPath];
  }
}

/**
 * The sentence in what a tool that exited 0 printed. In JSON, a null, empty
 * or blank summary is `silent`, like an empty plain reply; JSON that is
 * missing, unreadable or not the schema's throws, so the plain sentence is
 * spoken rather than nothing.
 */
export function readReply(stdout: string, reply: ReplyFormat): WrittenSentence {
  if (reply === "text") return cleanSentence(stdout);
  const tool = reply === "claude-json" ? "Claude Code" : "Codex";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${tool} did not answer in JSON: ${stdout.trim().slice(0, 200) || "no output"}`);
  }
  let structured = parsed;
  if (reply === "claude-json") {
    const result = ClaudeResultSchema.safeParse(parsed);
    if (!result.success) throw new Error(`${tool}'s answer is not a JSON result: ${stdout.trim().slice(0, 200)}`);
    if (result.data.is_error === true) throw new Error(`${tool} answered with an error: ${stdout.trim().slice(0, 200)}`);
    structured = result.data.structured_output;
  }
  const answer = SummarySchema.safeParse(structured);
  if (!answer.success) throw new Error(`${tool}'s answer is not { summary, speak }: ${JSON.stringify(structured ?? null).slice(0, 200)}`);
  if (answer.data.summary === null) return { kind: "silent" };
  const line = cleanLine(answer.data.summary);
  return line.kind === "sentence" && answer.data.speak === false ? { kind: "unspoken", text: line.text } : line;
}

export class SentenceWriter {
  private readonly controller = new AbortController();
  private inFlight = 0;
  private disposed = false;

  constructor(private readonly log: Log) {}

  /**
   * Runs `command` with `prompt` on stdin and returns the cleaned sentence —
   * `unspoken` when a JSON answer says `speak: false` — or `silent` when the
   * tool exits 0 with nothing to say. `reply` says how
   * its answer is read (`readReply`). Rejects when the writer is busy or
   * disposed, the tool is missing, fails, outlives `WRITE_TIMEOUT_MS`, or
   * answers JSON that is not the schema's — and when `signal` aborts, which
   * kills the tool; the run's slot is free again by the time it rejects.
   *
   * Each run gets an empty folder of its own under the temp directory, made
   * for it and removed after it, so a tool that reads its working directory
   * — project instructions, hooks, a repository — finds nothing but Codex's
   * schema file, when Codex is asked for JSON. (One folder
   * for the life of the plugin was tried first; macOS purges unused temp
   * entries after a few days, and a bb server runs for weeks.)
   */
  async write(command: readonly string[], prompt: string, reply: ReplyFormat, signal?: AbortSignal): Promise<WrittenSentence> {
    if (this.disposed) throw new Error("The sentence writer is closed.");
    if (this.inFlight >= MAX_IN_FLIGHT) throw new Error(`The sentence writer is busy (${MAX_IN_FLIGHT} already running).`);
    this.inFlight += 1;
    let cwd: string | null = null;
    try {
      cwd = await mkdtemp(join(tmpdir(), "herald-writer-"));
      const schemaPath = join(cwd, SCHEMA_FILE);
      if (reply === "codex-json") await writeFile(schemaPath, JSON.stringify(SUMMARY_SCHEMA), "utf8");
      const result = await runCommand(commandFor(command, reply, schemaPath), prompt, {
        cwd,
        env: process.env,
        timeoutMs: WRITE_TIMEOUT_MS,
        signal: signal === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, signal]),
      });
      if (result.code !== 0) {
        throw new Error(`${command[0]} exited with ${result.code ?? "a signal"}: ${result.stderr.trim().slice(-300) || "no error output"}`);
      }
      return readReply(result.stdout, reply);
    } finally {
      this.inFlight -= 1;
      if (cwd !== null) {
        await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => {
          this.log.warn(`Could not remove the sentence writer's folder: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  /** Kills every running tool; nothing is accepted from here on. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.controller.abort();
    return Promise.resolve();
  }
}
