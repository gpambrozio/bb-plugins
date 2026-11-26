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

/** Where the terminal is, as the agent's instructions name it. */
export interface PromptSource {
  /** The tab's title as the strip shows it. */
  tabLabel: string;
  hostName: string;
}

/**
 * What the agent's message box starts with when the tab's last command
 * failed. Only that: the agent reads the command and its output from the
 * terminal itself. With no failure the box starts empty.
 */
export const FAILURE_PROMPT = "The last command I ran returned an error. Help me debug.";

/**
 * The standing instructions the tab's helper thread gets with its tools, from
 * its first turn: where the user is, which tab, and what the tools do. The
 * tab's label and machine name are the user's own text, so they are quoted.
 */
export function agentInstructions(source: PromptSource): string {
  return [
    `The user is working in a terminal and wants your help with it. They are talking to you from their Terminals page, beside the terminal tab ${JSON.stringify(source.tabLabel)} on the machine ${JSON.stringify(source.hostName)}.`,
    `That tab is the user's own interactive shell, which they see and type into beside this chat. You can read it and run commands in it with your tools: \`${READ_TOOL}\` reads what it shows now (its recent output, the shell's directory, whether a command is running, and how the last command ended); \`${RUN_TOOL}\` types one command into it, runs it and returns its output and exit code.`,
    `The user's message does not quote the terminal: read it with \`${READ_TOOL}\` first, and when they say a command failed, start from what it shows. Commands you run there are the user's: they change the shell's directory, environment and history, and the user sees each one with a note that you typed it. Prefer read-only commands to look around; ask before anything destructive, slow, or that needs a password or other input.`,
    `Your own workspace may be another directory or machine than that terminal; to act where the user is, use \`${RUN_TOOL}\`.`,
  ].join("\n\n");
}

/** Exit codes that are the user stopping a command (Ctrl-C), not a failure to ask about. */
const INTERRUPTED = new Set([130]);

/** Whether a finished command is one to offer help with: it failed, and the user did not stop it themselves. */
export function isAskableFailure(command: FinishedCommand | null): command is FinishedCommand {
  return command !== null && command.exitCode !== null && command.exitCode !== 0 && !INTERRUPTED.has(command.exitCode);
}
