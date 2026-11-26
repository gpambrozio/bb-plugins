/**
 * The agent a tab can ask for help: what the page tells it, and what the
 * server tells the page when the agent types into the tab. No SDK import, so
 * the app may use it.
 */
import { z } from "zod";

import type { FinishedCommand } from "./shell-marks";

/** Published when the agent typed a command into a tab, so every window showing it can say so. */
export const AGENT_TYPED = "agent-typed";

export const AgentTypedSchema = z.object({ terminalId: z.string().min(1), command: z.string() });

export type AgentTyped = z.infer<typeof AgentTypedSchema>;

/** The tools a tab's helper thread gets. */
export const READ_TOOL = "terminal_read";
export const RUN_TOOL = "terminal_run";

/** Where the terminal is, as the prompt names it. */
export interface PromptSource {
  /** The tab's title as the strip shows it. */
  tabLabel: string;
  hostName: string;
}

/** The most output lines a prompt quotes; the tools can read more. */
export const PROMPT_OUTPUT_LINES = 150;

function fence(text: string): string {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}text\n${text}\n${marks}`;
}

function terminalName(source: PromptSource): string {
  return source.tabLabel.startsWith(source.hostName) ? `"${source.tabLabel}"` : `"${source.tabLabel}" on ${source.hostName}`;
}

function lastLinesOf(text: string, count: number): { text: string; dropped: boolean } {
  const lines = text.split("\n");
  return lines.length <= count ? { text, dropped: false } : { text: lines.slice(-count).join("\n"), dropped: true };
}

/**
 * What "Ask an agent" says about a command that failed: the command, what it
 * printed (its last `PROMPT_OUTPUT_LINES` lines), its exit code and where it
 * ran, and the ask. The user sees and can edit it before it is sent.
 */
export function failurePrompt(command: FinishedCommand, source: PromptSource): string {
  const output = lastLinesOf(command.output, PROMPT_OUTPUT_LINES);
  const shown = command.command === "" ? output.text : `$ ${command.command}${output.text === "" ? "" : `\n${output.text}`}`;
  const where = command.cwd === null ? "" : ` in ${command.cwd}`;
  const exit = command.exitCode === null ? "It failed." : `It exited with code ${command.exitCode}.`;
  const cut = output.dropped || command.truncated ? " (only the last lines of its output are above)" : "";
  return [
    `A command failed in my terminal ${terminalName(source)}${where}:`,
    "",
    fence(shown === "" ? "(no output)" : shown),
    "",
    `${exit}${cut} Help me find out why and fix it.`,
  ].join("\n");
}

/** What "Ask an agent" says with no failed command: what the terminal shows, for the user to ask about. */
export function screenPrompt(screen: string, cwd: string | null, source: PromptSource): string {
  const shown = lastLinesOf(screen, PROMPT_OUTPUT_LINES).text;
  const where = cwd === null ? "" : ` (in ${cwd})`;
  if (shown.trim() === "") return `I'm working in my terminal ${terminalName(source)}${where}. `;
  return [`This is my terminal ${terminalName(source)}${where}:`, "", fence(shown), "", ""].join("\n");
}

/**
 * The standing instructions the helper thread gets with its tools. The tab's
 * label and machine name are the user's own text, so they are quoted.
 */
export function agentInstructions(source: PromptSource): string {
  return [
    `The user asked you for help from their Terminals page, about the terminal tab ${JSON.stringify(source.tabLabel)} on ${JSON.stringify(source.hostName)}.`,
    `That is the user's own interactive shell, which they see and type into beside this chat. \`${READ_TOOL}\` reads what it shows now; \`${RUN_TOOL}\` types one command into it, runs it and returns its output and exit code.`,
    `Read the terminal before you run anything in it. Commands you run there are the user's: they change the shell's directory, environment and history, and the user sees each one with a note that you typed it. Prefer read-only commands to look around; ask before anything destructive, slow, or that needs a password or other input.`,
    `Your own workspace may be another directory or machine than that terminal; to act where the user is, use \`${RUN_TOOL}\`.`,
  ].join("\n\n");
}

/** Exit codes that are the user stopping a command (Ctrl-C), not a failure to ask about. */
const INTERRUPTED = new Set([130]);

/** Whether a finished command is one to offer help with: it failed, and the user did not stop it themselves. */
export function isAskableFailure(command: FinishedCommand | null): command is FinishedCommand {
  return command !== null && command.exitCode !== null && command.exitCode !== 0 && !INTERRUPTED.has(command.exitCode);
}
