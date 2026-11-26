/**
 * The agent a tab can ask for help: what the page tells it, and what the
 * server tells the page when the agent types into the tab. No SDK import, so
 * the app may use it.
 */
import { z } from "zod";

import type { FinishedCommand, ShellPhase } from "./shell-marks";

/** Published when the agent typed a command into a tab, so every window showing it can say so. */
export const AGENT_TYPED = "agent-typed";

export const AgentTypedSchema = z.object({
  terminalId: z.string().min(1),
  command: z.string(),
  /** The prompt the agent typed at (the cursor's line before the command), to tell the user's own prompt from a command's question. */
  prompt: z.string().nullable().optional(),
});

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

/** The placeholders an instructions text may use; each is filled with the tab's own value, quoted. */
export const INSTRUCTION_PLACEHOLDERS = { tab: "{{tab}}", machine: "{{machine}}" } as const;

/** The longest instructions text the settings take. */
export const MAX_INSTRUCTIONS_LENGTH = 20_000;

/**
 * The line the plugin always puts first, whatever the instructions text says:
 * which tab and machine the chat's tools act on. Not editable, so the agent
 * always knows its terminal.
 */
export const FIXED_INSTRUCTIONS = `This chat is attached to the user's terminal tab ${INSTRUCTION_PLACEHOLDERS.tab} on the machine ${INSTRUCTION_PLACEHOLDERS.machine}: \`${READ_TOOL}\` and \`${RUN_TOOL}\` act on that tab.`;

/**
 * The built-in instructions text, which the owner can edit in the plugin's
 * settings. It may use the placeholders; the fixed line names the tab anyway.
 */
export const DEFAULT_INSTRUCTIONS = [
  `The user is working in a terminal and wants your help with it. They are talking to you from their Terminals page, beside that tab.`,
  `That tab is the user's own interactive shell, which they see and type into beside this chat. You can read it and run commands in it with your tools: \`${READ_TOOL}\` reads what it shows now (its recent output, the shell's directory, whether a command is running, and how the last command ended); \`${RUN_TOOL}\` types one command into it, runs it and returns its output and exit code.`,
  `When the user asks you to run something, run it in that terminal with \`${RUN_TOOL}\`, not in your own shell or with any other tool, and do not ask them to confirm first: their asking is the confirmation.`,
  `The user's message does not quote the terminal: read it with \`${READ_TOOL}\` first, and when they say a command failed, start from what it shows. Commands you run there are the user's: they change the shell's directory, environment and history, and the user sees each one with a note that you typed it. When you decide to run something yourself, prefer read-only commands to look around, and ask before anything destructive, slow, or that needs a password or other input.`,
  `Your own workspace may be another directory or machine than that terminal; to act where the user is, use \`${RUN_TOOL}\`.`,
].join("\n\n");

/** What to store for an instructions text: null (the built-in one) for none, a blank one, or the built-in text itself. */
export function normalizeInstructions(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" || trimmed === DEFAULT_INSTRUCTIONS ? null : trimmed;
}

/** Fills the placeholders with the tab's label and machine name, quoted: they are the user's own text. */
function fill(text: string, source: PromptSource): string {
  return text
    .replaceAll(INSTRUCTION_PLACEHOLDERS.tab, JSON.stringify(source.tabLabel))
    .replaceAll(INSTRUCTION_PLACEHOLDERS.machine, JSON.stringify(source.hostName));
}

/**
 * The standing instructions the tab's helper thread gets with its tools, from
 * its first turn: the fixed line naming the tab, then the owner's text (the
 * built-in one when they have none, or left it blank).
 */
export function agentInstructions(source: PromptSource, custom: string | null = null): string {
  const text = custom === null || custom.trim() === "" ? DEFAULT_INSTRUCTIONS : custom.trim();
  return `${fill(FIXED_INSTRUCTIONS, source)}\n\n${fill(text, source)}`;
}

/**
 * Whether a keystroke the user just sent goes to their own shell prompt, which
 * means they have moved on from what the agent ran (the "agent ran" list
 * clears), rather than to a command the agent started: a password for
 * `sudo`, a y/n answer. With shell-integration marks the shell says so: a
 * running command takes the keystroke. Without them, the keystroke is at the
 * prompt when the cursor's line starts with the prompt the agent typed at
 * ("Password:" or "[y/N]" does not). With no prompt known, any keystroke counts.
 */
export function typingAtOwnPrompt(options: { phase: ShellPhase; line: string; prompt: string | null }): boolean {
  if (options.phase === "running") return false;
  if (options.phase === "prompt" || options.phase === "finished") return true;
  const prompt = options.prompt?.trim() ?? "";
  if (prompt === "") return true;
  return options.line.trimStart().startsWith(prompt);
}

/** Exit codes that are the user stopping a command (Ctrl-C), not a failure to ask about. */
const INTERRUPTED = new Set([130]);

/** Whether a finished command is one to offer help with: it failed, and the user did not stop it themselves. */
export function isAskableFailure(command: FinishedCommand | null): command is FinishedCommand {
  return command !== null && command.exitCode !== null && command.exitCode !== 0 && !INTERRUPTED.has(command.exitCode);
}
