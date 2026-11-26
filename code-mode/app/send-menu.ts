// The new-thread composer's Send menu gets two rows:
//
// - "Send in Code Mode" starts the thread in Code Mode. It is greyed out where that can't work: another
//   agent, a model without Code Mode, or a machine where Code Mode is off or its wrapper isn't ready.
//   The project's default does not matter: the row is the thread's own choice.
// - "Send without Code Mode" starts it without, and is offered only when the thread would otherwise
//   start in Code Mode by default (its project and its machine are on).
//
// bb draws every registered row and lets a row be greyed out but not hidden, with a label and a
// description fixed at registration, so the row that doesn't apply is greyed out, and the reason is
// not shown in the menu. Either row sends the first message with this plugin's data on it; the
// server's dispatch hook records the choice and refuses a send it can't honour, saying why in a toast.
import type { ComposerSelection, ComposerSendMenuItem, PluginComposerApi, PluginComposerScope } from "@get-bb/plugin-sdk/app";

import { hostAllowed, projectDefault } from "../shared/config";
import { notReadyOnMachine, offOnMachine } from "../shared/messages";
import { codeModeSupport, SUPPORTED_MODELS_TEXT } from "../shared/model";
import { composerFacts, type ComposerFactsState } from "./composer-facts";

export const CODE_MODE_ICON = "Code";
export const CLAUDE_CODE = "claude-code";

/** The data each row puts on the send. */
export const SEND_DATA = { codeMode: true } as const;
export const SEND_WITHOUT_DATA = { codeMode: false } as const;

/** The machine the composer's environment picker names, when it names one. */
export function selectedHostId(selection: ComposerSelection | null): string | null {
  const environment = selection?.environment as { type?: string; hostId?: string; machine?: { type?: string; hostId?: string } } | undefined;
  if (environment?.type === "host") return environment.hostId ?? null;
  if (environment?.type === "provider" && environment.machine?.type === "existing") return environment.machine.hostId ?? null;
  return null;
}

/** Why "Send in Code Mode" can't be used for this thread, or null when it can. */
export function sendInBlocked(selection: ComposerSelection | null, facts: ComposerFactsState): string | null {
  if (selection?.providerId !== undefined && selection.providerId !== CLAUDE_CODE) return "Code Mode is for Claude Code threads";
  if (codeModeSupport(selection?.model) === "unsupported") return `Code Mode only works with ${SUPPORTED_MODELS_TEXT}`;
  const hostId = selectedHostId(selection);
  // A machine the picker doesn't name, or switches not loaded yet: the dispatch hook decides.
  if (hostId === null || facts.config === null) return null;
  const name = facts.hostNames[hostId];
  if (!hostAllowed(facts.config, hostId)) return offOnMachine(name);
  const status = facts.statuses[hostId];
  if (status && !status.ok) return notReadyOnMachine(name, status.message);
  return null;
}

/** Whether a plain send would start this thread in Code Mode by its project's default. */
export function startsInCodeModeByDefault(selection: ComposerSelection | null, scope: PluginComposerScope, facts: ComposerFactsState): boolean {
  if (facts.config === null || sendInBlocked(selection, facts) !== null) return false;
  const projectId = selection?.projectId ?? (scope.kind === "new-thread" ? scope.projectId : null);
  if (!projectId || !projectDefault(facts.config, facts.projectNames[projectId])) return false;
  const hostId = selectedHostId(selection);
  return hostId === null || hostAllowed(facts.config, hostId);
}

async function submit(composer: PluginComposerApi, data: typeof SEND_DATA | typeof SEND_WITHOUT_DATA): Promise<void> {
  try {
    await composer.submit({ experimental_data: data });
  } catch {
    // bb has already shown the failure as a toast and put the draft back.
  }
}

export const sendInCodeMode: ComposerSendMenuItem = {
  id: "send-in-code-mode",
  label: "Send in Code Mode",
  icon: CODE_MODE_ICON,
  description:
    "Start this Claude Code thread in Code Mode; the thread keeps that choice for good. Greyed out for other agents, for models without Code Mode, and on a machine where Code Mode is off or not ready.",
  disabled: (composer) => sendInBlocked(composer.selection, composerFacts()) !== null,
  run: ({ composer }) => submit(composer, SEND_DATA),
};

export const sendWithoutCodeMode: ComposerSendMenuItem = {
  id: "send-without-code-mode",
  label: "Send without Code Mode",
  icon: CODE_MODE_ICON,
  description:
    "Start this thread with the ordinary tools, though its project starts new threads in Code Mode; the thread keeps that choice for good. Offered only when the thread would otherwise start in Code Mode.",
  disabled: (composer) => !startsInCodeModeByDefault(composer.selection, composer.scope, composerFacts()),
  run: ({ composer }) => submit(composer, SEND_WITHOUT_DATA),
};
