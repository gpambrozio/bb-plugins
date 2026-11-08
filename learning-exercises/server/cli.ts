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
 * The question and the feedback travel base64-encoded through `--question-base64-stdin` and
 * `--feedback-base64-stdin` (bb's CLI reads one line from stdin on the caller's machine), so quotes,
 * backticks and newlines in them are never a shell's business.
 */
import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import { EXERCISE_TYPES, VERDICTS, type ExerciseType, type Verdict } from "../shared/types";
import { PRINCIPLES } from "./content";
import { OrientationError, type OrientationService } from "./orientation";
import { SessionError, type SessionService } from "./sessions";

/** The longest question, in UTF-8 bytes; its base64 still fits bb's one 16 KiB stdin line. */
export const QUESTION_MAX_BYTES = 8_000;

/** The longest feedback, in UTF-8 bytes; like the question's, its base64 fits bb's one stdin line. */
export const FEEDBACK_MAX_BYTES = 8_000;

/** The longest answer form, as UTF-8 JSON bytes (`FORM_LIMITS.json` characters, most of them ASCII). */
export const FORM_MAX_BYTES = 32_000;

/** Strict base64 of UTF-8 text, at most `maxBytes` decoded; one trailing newline (a heredoc's) is dropped. */
function decodeBase64Text(encoded: string, what: { name: string; option: string; maxBytes: number; tooLong: string; hint: string }): string {
  const compact = encoded.trim();
  const tooLong = () => new PluginCliError(`The ${what.name} is longer than ${what.maxBytes} bytes.`, { code: what.tooLong });
  if (compact.length > Math.ceil((what.maxBytes + 1) / 3) * 4) throw tooLong();
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new PluginCliError(`${what.option} is not valid base64.`, { code: "invalid_value", hint: what.hint });
  }
  const decoded = Buffer.from(compact, "base64");
  const bytes = decoded.at(-1) === 0x0a ? decoded.subarray(0, -1) : decoded;
  if (bytes.byteLength > what.maxBytes) throw tooLong();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PluginCliError(`${what.option} does not decode to UTF-8 text.`, { code: "invalid_value" });
  }
}

export function decodeQuestion(encoded: string): string {
  return decodeBase64Text(encoded, {
    name: "question",
    option: "--question-base64",
    maxBytes: QUESTION_MAX_BYTES,
    tooLong: "question_too_long",
    hint: "Pipe the question through `base64 | tr -d '\\n'` into --question-base64-stdin.",
  });
}

export function decodeFeedback(encoded: string): string {
  return decodeBase64Text(encoded, {
    name: "feedback",
    option: "--feedback-base64",
    maxBytes: FEEDBACK_MAX_BYTES,
    tooLong: "feedback_too_long",
    hint: "Pipe the feedback through `base64 | tr -d '\\n'` into --feedback-base64-stdin.",
  });
}

/** The answer form's JSON, from base64; its content is checked by the session (`parseAnswerForm`). */
export function decodeForm(encoded: string): unknown {
  const text = decodeBase64Text(encoded, {
    name: "answer form",
    option: "--form-base64",
    maxBytes: FORM_MAX_BYTES,
    tooLong: "form_too_long",
    hint: "Pass the form's JSON as --form-base64 \"$(base64 < form.json | tr -d '\\n')\".",
  });
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PluginCliError(`--form-base64 is not JSON: ${error instanceof Error ? error.message : String(error)}`, { code: "invalid_value" });
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
    if (error instanceof OrientationError) throw new PluginCliError(error.message, { code: "orientation_refused" });
    throw error;
  }
}

/** The orient commands' byte caps: title, markdown, caption and summary JSON, before base64. */
export const ORIENT_TITLE_MAX_BYTES = 1_000;
export const ORIENT_MARKDOWN_MAX_BYTES = 8_000;
export const ORIENT_CAPTION_MAX_BYTES = 1_000;
export const ORIENT_SUMMARY_MAX_BYTES = 32_000;

function decodeOrientText(encoded: string, name: string, maxBytes: number, hint = `Pipe the ${name} through \`base64 | tr -d '\\n'\` into --${name}-base64-stdin.`): string {
  return decodeBase64Text(encoded, {
    name,
    option: `--${name}-base64`,
    maxBytes,
    tooLong: `${name}_too_long`,
    hint,
  });
}

/** The summary's JSON, from base64; its content is checked by the service. */
export function decodeOrientSummary(encoded: string): unknown {
  const text = decodeOrientText(encoded, "summary", ORIENT_SUMMARY_MAX_BYTES, "Pass the summary's JSON as --summary-base64 \"$(base64 < summary.json | tr -d '\\n')\".");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PluginCliError(`--summary-base64 is not JSON: ${error instanceof Error ? error.message : String(error)}`, { code: "invalid_value" });
  }
}

export function learningCli(sessions: SessionService, orientations: OrientationService): PluginCliRegistration {
  return defineCli({
    name: "learning",
    summary: "Learning Exercises session commands (only inside a learning session)",
    commands: {
      ask: cliCommand({
        summary: "Show the learner one exercise question in a card; end your turn right after",
        description:
          "Opens the question card in this thread and returns at once. End your turn without adding anything: the learner's answer arrives as your next message. The question must stand on its own: put any code it relies on inside it as a fenced code block, and never refer to \"above\" or an earlier message.",
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
          file: { type: "string", repeatable: true, description: "A workspace path the learner should open, with an optional line or range (src/a.ts:42, src/a.ts:40-60); repeatable, at most 10", placeholder: "path" },
          // Not stdin: the question has the one stdin line. Base64 keeps the JSON out of the shell's hands.
          "form-base64": {
            type: "string",
            description: `Optional answer form as base64 of its JSON, at most ${FORM_MAX_BYTES} bytes decoded (see the brief's "Answer forms"); leave it out for a plain text answer`,
            placeholder: "base64",
          },
        },
        run: (input, ctx) =>
          guarded(() => {
            const threadId = callerThread(ctx.threadId);
            const question = decodeQuestion(input.options["question-base64"]);
            const encodedForm = input.options["form-base64"];
            const form = encodedForm === undefined ? undefined : decodeForm(encodedForm);
            return sessions.ask(threadId, { type: input.options.type as ExerciseType, question, files: input.options.file ?? [], form }, "cli");
          }),
      }),
      feedback: cliCommand({
        summary: "Give your feedback on the learner's last answer and record your verdict",
        description:
          "Put the feedback in --feedback-base64-stdin, not in a message: the plugin shows it in the chat as a card with the verdict, above the next question, and in the session's history.",
        options: {
          verdict: { type: "enum", values: VERDICTS, required: true, description: "correct, partly, incorrect or skipped" },
          // bb's CLI turns `--feedback-base64-stdin` into `--feedback-base64 <line from stdin>`.
          "feedback-base64": {
            type: "string",
            stdin: true,
            description: `Your feedback to the learner as base64 of UTF-8 Markdown, at most ${FEEDBACK_MAX_BYTES} bytes decoded; pass it with --feedback-base64-stdin. Required for an answered question; leave it out for a skipped one`,
            placeholder: "base64",
          },
          gap: { type: "string", description: "What was missing or wrong, one sentence (at most 500 characters)", placeholder: "text" },
          concept: { type: "string", repeatable: true, description: "A concept the question exercised (repeatable, at most 20)", placeholder: "name" },
        },
        run: (input, ctx) =>
          guarded(() =>
            sessions.feedback(callerThread(ctx.threadId), {
              verdict: input.options.verdict as Verdict,
              feedback: input.options["feedback-base64"] === undefined ? null : decodeFeedback(input.options["feedback-base64"]),
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
      "orient chapter": cliCommand({
        summary: "Start a new chapter of the orientation walkthrough (builder only)",
        options: {
          "title-base64": { type: "string", required: true, stdin: true, description: `The title as base64 of UTF-8 text, at most ${ORIENT_TITLE_MAX_BYTES} bytes decoded; pass it with --title-base64-stdin`, placeholder: "base64" },
        },
        run: (input, ctx) => guarded(() => orientations.chapter(callerThread(ctx.threadId), decodeOrientText(input.options["title-base64"], "title", ORIENT_TITLE_MAX_BYTES))),
      }),
      "orient note": cliCommand({
        summary: "Add a Markdown note, without fenced code or an image-only line (builder only)",
        options: {
          "markdown-base64": { type: "string", required: true, stdin: true, description: `The note as base64 of UTF-8 Markdown, at most ${ORIENT_MARKDOWN_MAX_BYTES} bytes decoded; pass it with --markdown-base64-stdin`, placeholder: "base64" },
        },
        run: (input, ctx) => guarded(() => orientations.note(callerThread(ctx.threadId), decodeOrientText(input.options["markdown-base64"], "markdown", ORIENT_MARKDOWN_MAX_BYTES))),
      }),
      "orient listing": cliCommand({
        summary: "Add a listing; the plugin captures the code from the file, never paste it (builder only)",
        options: {
          path: { type: "string", required: true, description: "Workspace-relative path of the file", placeholder: "path" },
          lines: { type: "string", required: true, description: 'The lines to show, "40-72" or "40"', placeholder: "A-B" },
          "caption-base64": { type: "string", required: true, stdin: true, description: `The caption as base64 of UTF-8 text, at most ${ORIENT_CAPTION_MAX_BYTES} bytes decoded; pass it with --caption-base64-stdin`, placeholder: "base64" },
        },
        run: (input, ctx) =>
          guarded(() =>
            orientations.listing(callerThread(ctx.threadId), {
              path: input.options.path,
              lines: input.options.lines,
              caption: decodeOrientText(input.options["caption-base64"], "caption", ORIENT_CAPTION_MAX_BYTES),
            }),
          ),
      }),
      "orient pop": cliCommand({
        summary: "Remove the last block added to the walkthrough (builder only)",
        run: (_input, ctx) => guarded(() => orientations.pop(callerThread(ctx.threadId))),
      }),
      "orient summary": cliCommand({
        summary: "Record the orientation's summary (builder only)",
        options: {
          "summary-base64": { type: "string", required: true, description: `The summary as base64 of its JSON, at most ${ORIENT_SUMMARY_MAX_BYTES} bytes decoded`, placeholder: "base64" },
        },
        run: (input, ctx) => guarded(() => orientations.summary(callerThread(ctx.threadId), decodeOrientSummary(input.options["summary-base64"]))),
      }),
      "orient finish": cliCommand({
        summary: "Finish the orientation; call this last (builder only)",
        run: (_input, ctx) => guarded(() => orientations.finish(callerThread(ctx.threadId))),
      }),
      principles: cliCommand({
        summary: "Print the learning science behind the exercises (PRINCIPLES.md, CC BY 4.0)",
        run: async () => ({ exitCode: 0, stdout: PRINCIPLES }),
      }),
    },
  });
}
