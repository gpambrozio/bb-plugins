/**
 * `bb diff-review` — how the agent a review was sent to answers it: `list` the threads sent to it,
 * then `reply`, `resolve` or `dismiss` each one. Built with `defineCli`, so argv parsing, `--help` and
 * usage errors are the SDK's; the refusals that need the store (whose thread, which id) are
 * `ReviewService`'s.
 *
 * Text arrives as words or as `--text-base64`, which an agent fills through bb's
 * `--text-base64-stdin`: one line read from stdin on the caller's machine, so quotes, backticks and
 * new lines survive no matter the shell (AGENTS.md, "A plugin CLI command knows its caller").
 */
import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import { describeLocation, GENERAL_PATH, type ReviewThread } from "../shared/types";
import { ReviewError, type AgentAction, type ReviewService } from "./review";
import type { RunService } from "./runs";

/** The longest text a command takes, in UTF-8 bytes; its base64 still fits bb's 16 KiB stdin line. */
export const TEXT_MAX_BYTES = 12_000;

/** Output stays well under bb's 1 MiB cap for a plugin command. */
const LIST_MAX_CHARS = 500_000;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof ReviewError) throw new PluginCliError(error.message, { code: error.code });
    throw new PluginCliError(reason(error), { code: "failed" });
  }
}

/**
 * Strict base64 of valid UTF-8. A heredoc always ends its text with a new line, so exactly one
 * trailing "\n" is dropped before the size check.
 */
export function decodeText(encoded: string): string {
  const compact = encoded.trim();
  if (compact.length > Math.ceil((TEXT_MAX_BYTES + 1) / 3) * 4) {
    throw new PluginCliError(`The text is longer than ${TEXT_MAX_BYTES} bytes.`, { code: "text_too_long" });
  }
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new PluginCliError("--text-base64 is not valid base64.", { code: "invalid_value" });
  }
  const decoded = Buffer.from(compact, "base64");
  const bytes = decoded.at(-1) === 0x0a ? decoded.subarray(0, -1) : decoded;
  if (bytes.byteLength > TEXT_MAX_BYTES) {
    throw new PluginCliError(`The text is longer than ${TEXT_MAX_BYTES} bytes.`, { code: "text_too_long" });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PluginCliError("--text-base64 does not decode to UTF-8 text.", { code: "invalid_value" });
  }
}

function textOf(words: readonly string[], encoded: string | undefined): string {
  const joined = words.join(" ");
  if (encoded !== undefined && joined.trim() !== "") {
    throw new PluginCliError("Give the text as words or as --text-base64, not both.", { code: "unexpected_argument" });
  }
  const text = encoded === undefined ? joined : decodeText(encoded);
  if (Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES) {
    throw new PluginCliError(`The text is longer than ${TEXT_MAX_BYTES} bytes.`, { code: "text_too_long" });
  }
  return text;
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");
}

/** One thread as `list` prints it. */
export function formatThread(thread: ReviewThread): string {
  const facts = [thread.status, describeLocation(thread)];
  if (thread.severity !== null) facts.push(thread.severity);
  const lines = [`${thread.id}  ${facts.join(" · ")}`];
  for (const comment of thread.comments) {
    const who = comment.authorType === "user" ? "User" : `Agent (${comment.authorName})`;
    lines.push(`  ${who}:`, indent(comment.body, "    "));
  }
  return lines.join("\n");
}

const TEXT_OPTION = {
  type: "string",
  stdin: true,
  description: `The text as one line of base64, at most ${TEXT_MAX_BYTES} bytes decoded; --text-base64-stdin reads that line from stdin`,
  placeholder: "base64",
} as const;

function answerCommand(service: ReviewService, action: AgentAction, summary: string, what: string) {
  return cliCommand({
    summary,
    description: `Run from the bb thread the comments were sent to. The ${what} is the words after the id, or --text-base64.`,
    positionals: [
      { name: "id", description: "The comment thread's id, or a unique prefix of it", required: true },
      { name: "text", description: `The ${what}`, variadic: true },
    ],
    options: { "text-base64": TEXT_OPTION },
    run: (input, ctx) =>
      guarded(async () => {
        const text = textOf(input.positionals.text, input.options["text-base64"]);
        const thread = await service.answer(ctx.threadId, input.positionals.id, action, text);
        const done = action === "reply" ? "Replied on" : action === "resolve" ? "Resolved" : "Dismissed";
        return { exitCode: 0, stdout: `${done} ${thread.id} (${describeLocation(thread)}).\n` };
      }),
  });
}

function commentCommand(service: ReviewService, runs: RunService) {
  return cliCommand({
    summary: "Leave a review comment on the diff under review (AI review runs only)",
    description:
      "Run from an AI review run's thread. Comments on lines --line to --end-line of <file> on --side (new by default, old for removed lines), on the whole file with --line 0, or on the whole diff with --general. The comment is the words after the file, or --text-base64.",
    positionals: [
      { name: "file", description: "The file's path in the diff (leave out with --general)" },
      { name: "text", description: "The comment", variadic: true },
    ],
    options: {
      line: { type: "integer", min: 0, max: 10_000_000, description: "First line (0 for the whole file)", placeholder: "n" },
      "end-line": { type: "integer", min: 1, max: 10_000_000, description: "Last line; defaults to --line", placeholder: "n" },
      side: { type: "enum", values: ["new", "old"], description: "Which side the lines count on" },
      severity: { type: "enum", values: ["must-fix", "suggestion", "nit", "question"], description: "How much it matters" },
      general: { type: "boolean", description: "Comment on the whole diff instead of a file" },
      "text-base64": TEXT_OPTION,
    },
    run: (input, ctx) =>
      guarded(async () => {
        if (ctx.threadId === undefined) throw new PluginCliError("Run this inside an AI review run's thread.", { code: "not_in_thread" });
        const { file } = input.positionals;
        const general = input.options.general === true;
        if (!general && file === undefined) throw new PluginCliError("Give a file, or --general for the whole diff.", { code: "missing_required" });
        // With --general there is no file, so the first word of the comment lands in its place.
        const words = general && file !== undefined ? [file, ...input.positionals.text] : input.positionals.text;
        const text = textOf(words, input.options["text-base64"]);
        if (!general && input.options.line === undefined) throw new PluginCliError("Give --line (0 for the whole file).", { code: "missing_required" });
        const startLine = general ? 0 : input.options.line!;
        const thread = await runs.addComment(ctx.threadId, {
          filePath: general ? GENERAL_PATH : file!,
          side: startLine === 0 ? null : (input.options.side ?? "new"),
          startLine,
          endLine: input.options["end-line"] ?? startLine,
          severity: input.options.severity ?? null,
          body: text,
        });
        return { exitCode: 0, stdout: `Added ${thread.id} on ${describeLocation(thread)}.\n` };
      }),
  });
}

export function diffReviewCli(service: ReviewService, runs: RunService): PluginCliRegistration {
  return defineCli({
    name: "diff-review",
    summary: "Answer the review comments sent to this thread",
    commands: {
      list: cliCommand({
        summary: "List the open comment threads sent to this thread (or, in an AI review run, the review's), with every comment",
        options: {
          all: { type: "boolean", description: "Include threads already resolved or dismissed" },
          json: { type: "boolean", description: "Print the threads as JSON" },
        },
        run: (input, ctx) =>
          guarded(async () => {
            if (ctx.threadId === undefined) {
              throw new PluginCliError("Run this inside the bb thread the comments were sent to.", { code: "not_in_thread" });
            }
            const threads = service.sentTo(ctx.threadId, input.options.all === true);
            if (input.options.json === true) return { exitCode: 0, stdout: `${JSON.stringify(threads)}\n` };
            if (threads.length === 0) {
              return { exitCode: 0, stdout: input.options.all === true ? "No comment threads were sent to this thread.\n" : "No open comment threads were sent to this thread.\n" };
            }
            let text = threads.map(formatThread).join("\n\n");
            if (text.length > LIST_MAX_CHARS) text = `${text.slice(0, LIST_MAX_CHARS)}\n… (cut short: the list is too long to print whole)`;
            return { exitCode: 0, stdout: `${text}\n` };
          }),
      }),
      reply: answerCommand(service, "reply", "Answer in a comment thread; it stays open", "reply"),
      resolve: answerCommand(service, "resolve", "Resolve a comment thread with a one-line summary of what changed", "summary"),
      dismiss: answerCommand(service, "dismiss", "Close a comment thread you will not act on, with the reason", "reason"),
      comment: commentCommand(service, runs),
    },
  });
}
