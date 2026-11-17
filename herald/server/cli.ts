/**
 * `bb herald`: the global mute and each thread's choice, for scripts — a voice
 * hook that mutes Herald while the owner talks to another voice, say.
 *
 * - `mute`, `unmute` and `status` read and write Herald's master switch
 *   (`server/mute.ts`). A repeat changes nothing and writes nothing, so a hook
 *   may run them as often as it likes; each is one settings read and at most
 *   one write.
 * - `thread <id> [choice]` shows or sets a thread's choice through the same
 *   code path as bb's thread menu (`choices.set`), so every open menu, and the
 *   thread's bb notification level when Herald sends push notifications,
 *   follow it.
 *
 * Built with `defineCli`, so argv parsing, `--help` and usage errors are the
 * SDK's, and every failure gets the `--json` error envelope.
 */
import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import type { ChoiceOption, ChoiceSource, ThreadChoice } from "../shared/thread-choice";
import type { MuteResult } from "./mute";

/** The choices as the command line spells them; `questions` is the menu's *Questions only*. */
export const CLI_CHOICES = ["default", "announce", "questions-only", "silent"] as const;
export type CliChoice = (typeof CLI_CHOICES)[number];

const TO_OPTION: Record<CliChoice, ChoiceOption> = {
  default: "default",
  announce: "announce",
  "questions-only": "questions",
  silent: "silent",
};

export function cliChoiceOf(option: ChoiceOption): CliChoice {
  return option === "questions" ? "questions-only" : option;
}

/** A thread's choice as the command reports it. */
export interface ThreadChoiceReport {
  threadId: string;
  /** The thread's own choice; `default` when it has none and follows the rule below. */
  own: ChoiceOption;
  /** What applies: `effectiveChoice` in `shared/thread-choice.ts`. */
  effective: ThreadChoice;
  source: ChoiceSource;
  /** The thread whose choice it follows, for `parent` and `ancestor`. */
  fromThreadId: string | null;
}

/** Raised by the service for a thread bb does not know. */
export class UnknownThreadError extends Error {
  constructor(readonly threadId: string) {
    super(`bb has no thread ${threadId}.`);
  }
}

export interface HeraldCliDeps {
  mute: {
    muted(): Promise<boolean>;
    set(muted: boolean): Promise<MuteResult>;
  };
  threads: {
    /** Rejects with `UnknownThreadError` for a thread bb does not know. */
    show(threadId: string): Promise<ThreadChoiceReport>;
    /** Sets the thread's own choice, `default` clearing it, and reports it; rejects as `show` does. */
    set(threadId: string, option: ChoiceOption): Promise<ThreadChoiceReport>;
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reports any failure the way a usage error is reported: text on stderr, non-zero exit, `--json` envelope. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof UnknownThreadError) {
      throw new PluginCliError(error.message, { code: "thread_not_found", hint: "Pass a thread id such as thr_abc123; `bb thread list` lists them." });
    }
    throw new PluginCliError(reason(error), { code: "failed" });
  }
}

function output(json: boolean, data: unknown, text: string): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: `${json ? JSON.stringify(data) : text}\n` };
}

const MUTED_TEXT = "Herald is muted: nothing is spoken on any device until `bb herald unmute`. Herald still lists what waits on you.";
const UNMUTED_TEXT = "Herald is not muted.";

function muteText(result: MuteResult): string {
  if (result.muted) return result.changed ? MUTED_TEXT : `Already muted. ${MUTED_TEXT}`;
  return result.changed ? "Herald is unmuted: it speaks again, as its settings say." : `Already unmuted. ${UNMUTED_TEXT}`;
}

function sourceText(report: ThreadChoiceReport): string {
  switch (report.source) {
    case "self":
      return "its own choice";
    case "parent":
      return `following the thread that started it, ${report.fromThreadId ?? "its parent"}`;
    case "ancestor":
      return `following ${report.fromThreadId ?? "a thread above it"}, further up`;
    case "subagent":
      return "another thread started it, and Announce threads started by another thread is off";
    case "default":
      return "Herald's default";
  }
}

function reportJson(report: ThreadChoiceReport) {
  return {
    threadId: report.threadId,
    choice: cliChoiceOf(report.own),
    effective: { choice: cliChoiceOf(report.effective), source: report.source, fromThreadId: report.fromThreadId },
  };
}

function reportText(report: ThreadChoiceReport): string {
  return `${report.threadId}: ${cliChoiceOf(report.own)}\nEffective: ${cliChoiceOf(report.effective)} (${sourceText(report)})`;
}

function parseChoice(value: string): CliChoice {
  const choice = CLI_CHOICES.find((known) => known === value);
  if (choice === undefined) {
    throw new PluginCliError(`"${value}" is not a Herald choice. Use one of: ${CLI_CHOICES.join(", ")}.`, { code: "invalid_value" });
  }
  return choice;
}

const JSON_OPTION = { json: { type: "boolean", description: "Print the result as JSON" } } as const;

export function heraldCli(deps: HeraldCliDeps): PluginCliRegistration {
  return defineCli({
    name: "herald",
    summary: "Mute Herald everywhere, or show and set what it announces for one thread",
    description:
      "mute and unmute change Herald's master switch, Speak announcements: while it is off nothing is spoken on any device, and an announcement that comes up meanwhile is never spoken later. Both are safe to repeat.",
    commands: {
      mute: cliCommand({
        summary: "Stop Herald speaking on every device until unmute",
        options: JSON_OPTION,
        run: (input) =>
          guarded(async () => {
            const result = await deps.mute.set(true);
            return output(input.options.json, result, muteText(result));
          }),
      }),
      unmute: cliCommand({
        summary: "Let Herald speak again, as its settings say",
        options: JSON_OPTION,
        run: (input) =>
          guarded(async () => {
            const result = await deps.mute.set(false);
            return output(input.options.json, result, muteText(result));
          }),
      }),
      status: cliCommand({
        summary: "Say whether Herald is muted",
        options: JSON_OPTION,
        run: (input) =>
          guarded(async () => {
            const muted = await deps.mute.muted();
            return output(input.options.json, { muted }, muted ? MUTED_TEXT : UNMUTED_TEXT);
          }),
      }),
      thread: cliCommand({
        summary: "Show a thread's Herald choice, or set it: default, announce, questions-only or silent",
        description:
          "The same choice as Herald in bb's thread menu. default clears the thread's own choice, so it follows the thread that started it, or Herald's settings. With no choice, prints the thread's own choice and the one that applies.",
        options: JSON_OPTION,
        positionals: [
          { name: "thread-id", description: "The thread, such as thr_abc123", required: true },
          { name: "choice", description: `One of ${CLI_CHOICES.join(", ")}; leave it out to show the current one` },
        ],
        run: (input) =>
          guarded(async () => {
            const threadId = input.positionals["thread-id"].trim();
            const value = input.positionals.choice;
            const report = value === undefined ? await deps.threads.show(threadId) : await deps.threads.set(threadId, TO_OPTION[parseChoice(value)]);
            return output(input.options.json, reportJson(report), reportText(report));
          }),
      }),
    },
  });
}
