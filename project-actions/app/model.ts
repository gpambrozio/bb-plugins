// What the menu (and the fallback panel) shows for each state of a thread's actions file: one
// place for the words, so both read alike. No React, no SDK.
import { ACTIONS_FILE, describeLocation, type ActionView, type RunStatus } from "../shared/views";
import type { ActionsState } from "./use-actions";

/** What a note offers to do: read the file again, open the editor, or open the format's docs. */
export type Offer = "retry" | "edit" | "format";

export interface OfferItem {
  offer: Offer;
  label: string;
}

export type ActionsModel =
  | { kind: "loading"; text: string }
  | { kind: "actions"; actions: ActionView[] }
  | { kind: "note"; title: string; body: string; code: string | null; error: string | null; location: string | null; offers: OfferItem[] };

/** The menu's last entry under a list of actions. */
export const EDIT_LABEL = "Edit actions…";

const RETRY: OfferItem = { offer: "retry", label: "Try again" };
const FORMAT: OfferItem = { offer: "format", label: "How to write the actions file" };

export const STATUS_LABELS: Record<RunStatus, string | null> = { idle: null, running: "Running", finished: "Finished" };

function note(fields: Partial<Extract<ActionsModel, { kind: "note" }>> & { title: string; body: string; offers: OfferItem[] }): ActionsModel {
  return { kind: "note", code: null, error: null, location: null, ...fields };
}

export function actionsModel(state: ActionsState): ActionsModel {
  if (state.kind === "loading") return { kind: "loading", text: `Reading ${ACTIONS_FILE}…` };
  if (state.kind === "failed") return note({ title: "Could not read this project's actions", body: state.message, offers: [RETRY] });
  const { list } = state;
  switch (list.state) {
    case "ready":
      if (list.actions.length > 0) return { kind: "actions", actions: list.actions };
      return note({
        title: "No actions yet",
        body: "The actions file lists none. Add one with a name and a command:",
        code: ACTIONS_FILE,
        offers: [{ offer: "edit", label: "Add actions" }, FORMAT],
      });
    case "missing":
      return note({
        title: "No actions in this project",
        body: "Add an actions file at the project's root to list commands here, such as a dev server or a script. Each runs in a terminal of this thread:",
        code: ACTIONS_FILE,
        offers: [{ offer: "edit", label: "Add actions" }, FORMAT],
      });
    case "invalid":
      return note({
        title: "The actions file has a problem",
        body: "",
        error: list.problem.message,
        location: describeLocation(list.problem),
        offers: [{ offer: "edit", label: "Fix it in the editor" }, RETRY, FORMAT],
      });
    case "unavailable":
      return note({ title: "Could not read this project's actions", body: list.message, offers: [RETRY] });
  }
}
