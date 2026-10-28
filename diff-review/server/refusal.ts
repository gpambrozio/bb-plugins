/**
 * The caller's mistakes as bb's expected refusals. A `ReviewError` (a thread that is not open, a
 * comment that is not yours, lines not in the diff) is the caller's to fix, not a plugin crash, so the
 * RPC answers it as an `experimental_PluginRpcRefusal`: the tab still shows its message, and bb does
 * not record a failed handler for it.
 */
import { experimental_PluginRpcRefusal, type PluginRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";

import { ReviewError } from "./review";

type RefusalCode = experimental_PluginRpcRefusal["code"];

const NOT_FOUND = new Set(["unknown_thread", "unknown_session", "unknown_run", "unknown_comment"]);
const FORBIDDEN = new Set(["not_yours", "not_sent_here", "not_a_review_run", "not_in_thread", "wrong_workspace"]);
const CONFLICT = new Set(["not_open", "cleared", "nothing_to_send", "diff_unavailable"]);

export function refusalCode(code: string): RefusalCode {
  if (NOT_FOUND.has(code)) return "not_found";
  if (FORBIDDEN.has(code)) return "forbidden";
  if (CONFLICT.has(code)) return "conflict";
  return "invalid";
}

/** `handlers`, each answering a `ReviewError` as a refusal and letting anything else through. */
export function refusing<Contract extends PluginRpcContract>(handlers: PluginRpcHandlers<Contract>): PluginRpcHandlers<Contract> {
  const wrapped: Record<string, (input: never) => unknown> = {};
  for (const [method, handler] of Object.entries(handlers as Record<string, (input: never) => unknown>)) {
    wrapped[method] = async (input: never) => {
      try {
        return await handler(input);
      } catch (error) {
        if (error instanceof ReviewError) throw new experimental_PluginRpcRefusal({ code: refusalCode(error.code), message: error.message });
        throw error;
      }
    };
  }
  return wrapped as PluginRpcHandlers<Contract>;
}
