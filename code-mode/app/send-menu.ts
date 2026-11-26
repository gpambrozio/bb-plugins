// "Send in Code Mode" in the new-thread composer's Send menu. It sends the first message with this
// plugin's data on it; the server's dispatch hook reads it and records the thread as a Code Mode
// thread, or refuses the send with the reason (this machine is not turned on, or the model can't run
// Code Mode), which bb shows as a toast.
import type { ComposerSelection, ComposerSendMenuItem } from "@get-bb/plugin-sdk/app";

import { codeModeSupport } from "../shared/model";

export const CODE_MODE_ICON = "Code";
export const CLAUDE_CODE = "claude-code";

/** The data "Send in Code Mode" puts on the send. */
export const SEND_DATA = { codeMode: true } as const;

/** The row is greyed out where it could not work: another agent, or a model without Code Mode. */
export function sendDisabled(selection: ComposerSelection | null): boolean {
  if (selection?.providerId !== undefined && selection.providerId !== CLAUDE_CODE) return true;
  return codeModeSupport(selection?.model) === "unsupported";
}

export const sendInCodeMode: ComposerSendMenuItem = {
  id: "send-in-code-mode",
  label: "Send in Code Mode",
  icon: CODE_MODE_ICON,
  description: "Start this Claude Code thread in Code Mode. The thread keeps that choice for good.",
  disabled: (composer) => sendDisabled(composer.selection),
  run: async ({ composer }) => {
    try {
      await composer.submit({ experimental_data: SEND_DATA });
    } catch {
      // bb has already shown the failure as a toast and put the draft back.
    }
  },
};
