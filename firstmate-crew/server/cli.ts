/**
 * `bb firstmate-crew` — how the first mate dispatches a crewmate (`crew spawn`) and how anyone reaches the
 * first mate (`tell`).
 *
 * The plugin never dispatches crew itself: the first mate does, from its own thread, through this
 * command, so a crewmate is always a child of the first mate and always carries the crew metadata the
 * board finds it by. Built with `defineCli`, so argv parsing, `--help` and usage errors are the SDK's;
 * what is left here are the refusals that need bb (who is calling, which project, what file).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import { CREW_METADATA } from "../shared/types";
import { askMate, resolveMate, type MateDeps } from "./mate";
import type { SpawnArgs } from "./ports";

/** The longest first line of a brief that goes into a default title, in characters. */
const TITLE_LINE_MAX = 80;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reports any failure the way a usage error is reported: text on stderr, non-zero exit, `--json` envelope. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(reason(error), { code: "failed" });
  }
}

/** The first non-empty line of the brief, without its Markdown heading marks, clipped to `TITLE_LINE_MAX`. */
function firstLine(brief: string): string {
  const line = brief
    .split(/\r?\n/)
    .map((text) => text.replace(/^\s*#+\s*/, "").trim())
    .find((text) => text !== "");
  if (line === undefined) return "";
  return line.length <= TITLE_LINE_MAX ? line : `${line.slice(0, TITLE_LINE_MAX - 1).trimEnd()}…`;
}

function titleOf(explicit: string | undefined, task: string, brief: string): string {
  const given = explicit?.trim() ?? "";
  if (given !== "") return given;
  const line = firstLine(brief);
  return line === "" ? task : `${task}: ${line}`;
}

/**
 * The brief, read from `promptFile` relative to the caller's working directory. With no working
 * directory from bb, a relative path would resolve against the bb server's own, so only an absolute one
 * is taken.
 */
async function readBrief(promptFile: string, cwd: string | undefined): Promise<string> {
  if (cwd === undefined && !isAbsolute(promptFile)) {
    throw new PluginCliError("--prompt-file must be an absolute path when bb gives no working directory.", { code: "prompt_file_relative" });
  }
  const path = cwd === undefined ? promptFile : resolve(cwd, promptFile);
  let brief: string;
  try {
    brief = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new PluginCliError(`Prompt file not found: ${path}`, { code: "prompt_file_not_found" });
    throw new PluginCliError(`Prompt file could not be read: ${path}: ${reason(error)}`, { code: "prompt_file_unreadable" });
  }
  if (brief.trim() === "") throw new PluginCliError(`Prompt file is empty: ${path}`, { code: "prompt_file_empty" });
  return brief;
}

/** The longest message `tell` takes, in UTF-8 bytes: what fits bb's one stdin line of 16 KiB as base64. */
export const MESSAGE_MAX_BYTES = 12 * 1024;

/**
 * The message from `--message-base64`, which the `/fm` skill fills through bb's `--message-base64-stdin`:
 * bb's CLI reads one line from stdin on the caller's machine, so the text crosses machines and no shell
 * argument or server-side file ever holds it. Strict base64, at most `MESSAGE_MAX_BYTES` once decoded,
 * and valid UTF-8; the text is returned exactly as it decodes.
 */
function decodeMessage(encoded: string): string {
  const compact = encoded.trim();
  if (compact.length > Math.ceil(MESSAGE_MAX_BYTES / 3) * 4) {
    throw new PluginCliError(`The message is longer than ${MESSAGE_MAX_BYTES} bytes.`, { code: "message_too_long" });
  }
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new PluginCliError("--message-base64 is not valid base64.", { code: "invalid_value" });
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.byteLength > MESSAGE_MAX_BYTES) {
    throw new PluginCliError(`The message is longer than ${MESSAGE_MAX_BYTES} bytes.`, { code: "message_too_long" });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PluginCliError("--message-base64 does not decode to UTF-8 text.", { code: "invalid_value" });
  }
}

/** How every relayed message begins; the charter names it. */
export const RELAY_PREFIX = "Relayed by bb firstmate-crew tell";

/**
 * The line every message `tell` delivers opens with, so a relayed message can never pass for the
 * captain's own words in the first mate's chat — not even one whose text begins with a line like this.
 * The thread is the one the caller's `bb` names (its `BB_THREAD_ID`), which the caller controls, so it is
 * labelled as claimed. Its project and branch are bb's, and what bb cannot say is left out.
 */
async function relayLine(deps: MateDeps, threadId: string | undefined): Promise<string> {
  if (threadId === undefined) return `${RELAY_PREFIX}, from no thread (a terminal or a script):`;
  const origin = await deps.threads.origin(threadId);
  // One line, whatever the names hold, so nothing after it can look like the start of the message.
  const where = [origin?.projectName, origin?.branchName]
    .map((part) => part?.replace(/\s+/g, " ").trim() ?? "")
    .filter((part) => part !== "");
  const thread = where.length === 0 ? `thread ${threadId}` : `thread ${threadId} (${where.join(", ")})`;
  return `${RELAY_PREFIX}, from ${thread} as the sender claims:`;
}

/** A project by id, else by exact name. Two projects with the same name cannot be told apart by it. */
async function resolveProject(deps: MateDeps, value: string): Promise<string> {
  const projects = await deps.projects.list();
  const byId = projects.find((project) => project.id === value);
  if (byId !== undefined) return byId.id;
  const byName = projects.filter((project) => project.name === value);
  if (byName.length === 0) throw new PluginCliError(`Unknown project: ${value}`, { code: "unknown_project" });
  if (byName.length > 1) {
    throw new PluginCliError(`Project name "${value}" is ambiguous (${byName.map((project) => project.id).join(", ")}); pass the id.`, { code: "ambiguous_project" });
  }
  return byName[0]!.id;
}

/**
 * The settings' crew provider, model and reasoning, unless the flags name their own. A crew model
 * means nothing without its provider, so the settings' model is dropped when the provider is empty;
 * "default" reasoning means none.
 */
function crewPick(
  settings: { crewProvider: string; crewModel: string; crewReasoning: string },
  flags: { provider: string | undefined; model: string | undefined; reasoning: string | undefined },
): Pick<SpawnArgs, "providerId" | "model" | "reasoningLevel"> {
  const fromSettings = settings.crewProvider.trim();
  // The flags come as a pair (the command requires both), so they replace the settings' pair whole.
  const [providerId, model] =
    flags.provider !== undefined
      ? [flags.provider, flags.model]
      : fromSettings === ""
        ? [undefined, undefined]
        : [fromSettings, settings.crewModel.trim() || undefined];
  const level = flags.reasoning ?? settings.crewReasoning;
  const reasoningLevel = level === "default" || level.trim() === "" ? undefined : level.trim();
  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
  };
}

export function firstmateCli(deps: MateDeps): PluginCliRegistration {
  return defineCli({
    name: "firstmate-crew",
    summary: "Dispatch crew and talk to the first mate",
    commands: {
      "crew spawn": cliCommand({
        summary: "Start a crewmate as a child of the first mate (first mate only)",
        description:
          "Run from the first mate's own thread. Reads the brief from --prompt-file (relative to the current directory) and prints the new thread id.",
        options: {
          task: { type: "string", required: true, description: "The task id the crewmate works on, as in the backlog", placeholder: "id" },
          project: { type: "string", required: true, description: "The bb project to work in: its id or its exact name", placeholder: "project" },
          "prompt-file": { type: "string", required: true, description: "File holding the crewmate's brief", placeholder: "path" },
          title: { type: "string", description: "Thread title; defaults to `<task>: <first line of the brief>`", placeholder: "title" },
          kind: { type: "string", description: "The kind of work, kept on the thread for the board", placeholder: "kind" },
          environment: {
            type: "string",
            description: "Work in this existing environment instead of a new worktree (to relaunch a crewmate)",
            placeholder: "env-id",
          },
          provider: { type: "string", description: "Provider for the crewmate; overrides the crew settings. Needs --model", placeholder: "id" },
          model: { type: "string", description: "Model for the crewmate; overrides the crew settings. Needs --provider", placeholder: "model" },
          reasoning: { type: "string", description: "Reasoning level; overrides the crew reasoning setting", placeholder: "level" },
          json: { type: "boolean", description: "Print {\"threadId\": \"...\"} instead of the bare id" },
        },
        constraints: [
          { kind: "requires", option: "provider", needs: ["model"] },
          { kind: "requires", option: "model", needs: ["provider"] },
        ],
        run: (input, ctx) =>
          guarded(async () => {
            if (ctx.threadId === undefined) {
              throw new PluginCliError("crew spawn must run inside the first mate's thread.", { code: "not_in_thread" });
            }
            const mate = await resolveMate(deps);
            if (mate === null) throw new PluginCliError("No first mate aboard. Launch one in FirstMate settings.", { code: "no_first_mate" });
            if (mate.id !== ctx.threadId) {
              throw new PluginCliError(`crew spawn is only for the first mate (caller ${ctx.threadId} is not it).`, { code: "not_first_mate" });
            }

            const options = input.options;
            const prompt = await readBrief(options["prompt-file"], ctx.cwd);
            const projectId = await resolveProject(deps, options.project);
            const settings = await deps.settings();
            const kind = options.kind?.trim() ?? "";
            const environmentId = options.environment?.trim() ?? "";

            const thread = await deps.threads.spawn({
              projectId,
              title: titleOf(options.title, options.task, prompt),
              prompt,
              parentThreadId: mate.id,
              environment: environmentId === "" ? { kind: "worktree" } : { kind: "reuse", environmentId },
              ...crewPick(settings, { provider: options.provider, model: options.model, reasoning: options.reasoning }),
              metadata: {
                [CREW_METADATA.role]: CREW_METADATA.crewRole,
                [CREW_METADATA.task]: options.task,
                ...(kind === "" ? {} : { [CREW_METADATA.kind]: kind }),
                [CREW_METADATA.project]: options.project,
              },
            });
            return { exitCode: 0, stdout: `${options.json ? JSON.stringify({ threadId: thread.id }) : thread.id}\n` };
          }),
      }),
      tell: cliCommand({
        summary: "Send the first mate a message, from any thread or terminal",
        description:
          "The words are joined with spaces, or --message-base64 is decoded, and sent joining the first mate's turn if it is mid-way through one. Every message opens with a line saying it was relayed, and from which thread (as the sender claims), so the first mate never takes it for the captain's own words in its chat.",
        positionals: [{ name: "message", description: "What to tell the first mate", variadic: true }],
        options: {
          "message-base64": {
            type: "string",
            stdin: true,
            description: `The message as one line of base64, at most ${MESSAGE_MAX_BYTES} bytes decoded; --message-base64-stdin reads that line from stdin`,
            placeholder: "base64",
          },
        },
        run: (input, ctx) =>
          guarded(async () => {
            const words = input.positionals.message.join(" ");
            const encoded = input.options["message-base64"];
            if (encoded !== undefined && words.trim() !== "") {
              throw new PluginCliError("Give the message as words or as --message-base64, not both.", { code: "unexpected_argument" });
            }
            const text = encoded === undefined ? words : decodeMessage(encoded);
            if (text.trim() === "") throw new PluginCliError("Nothing to tell the first mate.", { code: "missing_required" });
            await askMate(deps, `${await relayLine(deps, ctx.threadId)}\n\n${text}`);
            return { exitCode: 0, stdout: "Sent to the first mate.\n" };
          }),
      }),
    },
  });
}
