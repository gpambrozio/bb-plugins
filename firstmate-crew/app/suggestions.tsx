/**
 * The first mate's suggestions: one button per next step it wrote in `data/suggestions.md`. Pressing one
 * sends its prompt to the first mate and brings its thread into view. A trash button beside it takes that
 * one line out of the file without sending anything; it is the button's sibling, not its child, so
 * pressing it never presses the suggestion. Hidden when there is nothing to suggest.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useSyncExternalStore } from "react";

import { Icon } from "../components/ui/icon";
import type { rpcContract } from "../server";
import type { Suggestion } from "../shared/types";
import { reportError } from "./notify";
import { suggestionRemovals } from "./suggestion-removals";
import { useMateSender } from "./use-mate-sender";

export function Suggestions({
  suggestions,
  mateThreadId,
  onChanged,
}: {
  suggestions: readonly Suggestion[];
  mateThreadId: string;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const mate = useMateSender();
  // Removals outlive this list: a tab switch can unmount it while a request is out. See ./suggestion-removals.
  useSyncExternalStore(suggestionRemovals.subscribe, suggestionRemovals.version);

  if (suggestions.length === 0) return null;

  function pick(suggestion: Suggestion): void {
    // Refused while another message is on its way, so a double press sends the prompt once.
    mate.ask(suggestion.prompt, () => navigate.toThread(mateThreadId));
  }

  function remove(suggestion: Suggestion): void {
    void suggestionRemovals.run(suggestion, () =>
      rpc
        .call("suggestion.remove", suggestion)
        .then(onChanged)
        .catch(reportError),
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggestions</h3>
      {suggestions.map((suggestion, index) => {
        const busy = suggestionRemovals.pending(suggestion);
        return (
          <div
            key={`${index}:${suggestion.label}`}
            className="flex items-stretch rounded-lg border border-border bg-card text-card-foreground data-[busy=true]:opacity-50"
            data-busy={busy}
          >
            <button
              type="button"
              disabled={busy || mate.sending}
              onClick={() => pick(suggestion)}
              aria-label={`${suggestion.label}: send "${suggestion.prompt}" to the first mate`}
              className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-3 py-2 text-left hover:bg-state-hover disabled:cursor-not-allowed"
            >
              <span className="truncate text-sm font-semibold">{suggestion.label}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{suggestion.prompt}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => remove(suggestion)}
              aria-label={`Remove suggestion: ${suggestion.label}`}
              className="flex cursor-pointer items-center px-3 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
            >
              <Icon name="Trash2" className="size-4" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
