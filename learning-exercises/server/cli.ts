/**
 * `bb learning`: the session commands for agents that have no plugin tools (the "here" mode, and forks
 * of providers whose forks do not receive them), plus `principles`. Only bb's generic `plugin-commands`
 * skill lists these commands; no thread is told about them until it starts a session.
 *
 * Trust: the calling thread is whatever the caller's `BB_THREAD_ID` says. bb's CLI context carries no
 * verified identity (SDK 0.6.104 `PluginCliContext`), so this scopes cooperatively, it does not
 * authenticate: each command acts only on the open session in the thread it names, and a process that
 * sets another session thread's id can ask, record or finish there. That is within bb's model, where
 * agents and plugins on the machine are trusted; it is said in AGENTS.md and the README.
 *
 * The question travels base64-encoded through `--question-base64-stdin` (bb's CLI reads one line from
 * stdin on the caller's machine), so quotes, backticks and newlines in it are never a shell's business.
 */
import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import { EXERCISE_TYPES, VERDICTS, type ExerciseType, type Verdict } from "../shared/types";
import { PRINCIPLES } from "./content";
import { SessionError, type SessionService } from "./sessions";

/** The longest question, in UTF-8 bytes; its base64 still fits bb's one 16 KiB stdin line. */
export const QUESTION_MAX_BYTES = 8_000;

/** Strict base64 of UTF-8 text; one trailing newline (a heredoc's) is dropped. */
export function decodeQuestion(encoded: string): string {
  const compact = encoded.trim();
  if (compact.length > Math.ceil((QUESTION_MAX_BYTES + 1) / 3) * 4) {
    throw new PluginCliError(`The question is longer than ${QUESTION_MAX_BYTES} bytes.`, { code: "question_too_long" });
  }
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new PluginCliError("--question-base64 is not valid base64.", { code: "invalid_value", hint: "Pipe the question through `base64 | tr -d '\\n'` into --question-base64-stdin." });
  }
  const decoded = Buffer.from(compact, "base64");
  const bytes = decoded.at(-1) === 0x0a ? decoded.subarray(0, -1) : decoded;
  if (bytes.byteLength > QUESTION_MAX_BYTES) throw new PluginCliError(`The question is longer than ${QUESTION_MAX_BYTES} bytes.`, { code: "question_too_long" });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PluginCliError("--question-base64 does not decode to UTF-8 text.", { code: "invalid_value" });
  }
}

function callerThread(threadId: string | undefined): string {
  if (threadId === undefined) {
    throw new PluginCliError("Run this inside the bb thread of the learning session.", { code: "not_in_thread" });
  }
  return threadId;
}

async function guarded(work: () => Promise<string>): Promise<{ exitCode: number; stdout: string }> {
  try {
    return { exitCode: 0, stdout: `${await work()}\n` };
  } catch (error) {
    if (error instanceof SessionError) throw new PluginCliError(error.message, { code: "session_refused" });
    throw error;
  }
}

export function learningCli(sessions: SessionService): PluginCliRegistration {
  return defineCli({
    name: "learning",
    summary: "Learning Exercises session commands (only inside a learning session)",
    commands: {
      ask: cliCommand({
        summary: "Show the learner one exercise question in a card; end your turn right after",
        description:
          "Opens the question card in this thread and returns at once. End your turn without adding anything: the learner's answer arrives as your next message.",
        options: {
          type: { type: "enum", values: EXERCISE_TYPES, required: true, description: "The exercise type" },
          // bb's CLI turns `--question-base64-stdin` into `--question-base64 <line from stdin>`.
          "question-base64": {
            type: "string",
            required: true,
            stdin: true,
            description: `The question as base64 of UTF-8 Markdown, at most ${QUESTION_MAX_BYTES} bytes decoded; pass it with --question-base64-stdin`,
            placeholder: "base64",
          },
          file: { type: "string", repeatable: true, description: "A workspace path the learner should open (repeatable, at most 10)", placeholder: "path" },
        },
        run: (input, ctx) =>
          guarded(() => {
            const threadId = callerThread(ctx.threadId);
            const question = decodeQuestion(input.options["question-base64"]);
            return sessions.ask(threadId, { type: input.options.type as ExerciseType, question, files: input.options.file ?? [] }, "cli");
          }),
      }),
      feedback: cliCommand({
        summary: "Record your verdict on the learner's last answer",
        options: {
          verdict: { type: "enum", values: VERDICTS, required: true, description: "correct, partly, incorrect or skipped" },
          gap: { type: "string", description: "What was missing or wrong, one sentence (at most 500 characters)", placeholder: "text" },
          concept: { type: "string", repeatable: true, description: "A concept the question exercised (repeatable, at most 20)", placeholder: "name" },
        },
        run: (input, ctx) =>
          guarded(() =>
            sessions.feedback(callerThread(ctx.threadId), {
              verdict: input.options.verdict as Verdict,
              gap: input.options.gap?.slice(0, 500) ?? null,
              concepts: input.options.concept ?? [],
            }),
          ),
      }),
      finish: cliCommand({
        summary: "End the learning session with a short summary",
        options: {
          summary: { type: "string", description: "Two sentences: what was covered and how it went (at most 1000 characters)", placeholder: "text" },
          concept: { type: "string", repeatable: true, description: "A concept covered (repeatable, at most 20)", placeholder: "name" },
        },
        run: (input, ctx) =>
          guarded(() => sessions.finishFromAgent(callerThread(ctx.threadId), { summary: input.options.summary?.slice(0, 1000) ?? null, concepts: input.options.concept ?? [] })),
      }),
      principles: cliCommand({
        summary: "Print the learning science behind the exercises (PRINCIPLES.md, CC BY 4.0)",
        run: async () => ({ exitCode: 0, stdout: PRINCIPLES }),
      }),
    },
  });
}
