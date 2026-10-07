/**
 * The first mate's suggestions: one button per next step it wrote in `data/suggestions.md`. Pressing one
 * sends its prompt to the first mate; once the send has landed, the suggestion is taken out of the file as
 * the trash would, and the first mate's thread is brought into view. A send that fails leaves the card
 * where it was. A trash button beside it takes that one line out of the file without sending anything, and
 * records it as dismissed, so the board hides it should the first mate write it again; a sent suggestion
 * is not recorded. The trash is the button's sibling, not its child, so pressing it never presses the
 * suggestion. Hidden when there is nothing to suggest.
 *
 * Bringing the thread into view is `toThread`, and the board is a panel on that same thread, so on a wide
 * layout the chat is already beside it. bb 0.45 gives a plugin no way to close a thread's side panel, so
 * on a phone the board stays open over the chat; the card going away is what shows the send landed.
 *
 * A card cuts a long label to one line and its prompt to two. A chevron beside the trash, shown only when
 * something is cut, opens the whole suggestion below the card, wrapped and selectable, without sending it.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

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
    // Refused while another message is on its way, so a double press sends the prompt once. The removal is
    // by label and prompt, so a file the first mate rewrote meanwhile loses this suggestion or nothing.
    mate.ask(suggestion.prompt, () => {
      remove(suggestion, "suggestion.remove");
      navigate.toThread(mateThreadId);
    });
  }

  // Sent: taken out of the file. Trashed: also recorded as dismissed.
  function remove(suggestion: Suggestion, method: "suggestion.remove" | "suggestion.dismiss"): void {
    void suggestionRemovals.run(suggestion, () =>
      rpc
        .call(method, suggestion)
        .then(onChanged)
        .catch(reportError),
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggestions</h3>
      {suggestions.map((suggestion, index) => (
        <SuggestionCard
          key={`${index}:${suggestion.label}`}
          suggestion={suggestion}
          busy={suggestionRemovals.pending(suggestion)}
          sending={mate.sending}
          onPick={() => pick(suggestion)}
          onRemove={() => remove(suggestion, "suggestion.dismiss")}
        />
      ))}
    </section>
  );
}

function SuggestionCard({
  suggestion,
  busy,
  sending,
  onPick,
  onRemove,
}: {
  suggestion: Suggestion;
  busy: boolean;
  sending: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const clipped = useClipped(expanded, suggestion);
  const fullId = useId();

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-card text-card-foreground data-[busy=true]:opacity-50"
      data-busy={busy}
    >
      <div className="flex items-stretch">
        <button
          type="button"
          disabled={busy || sending}
          onClick={onPick}
          aria-label={`${suggestion.label}: send "${suggestion.prompt}" to the first mate`}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-3 py-2 text-left hover:bg-state-hover disabled:cursor-not-allowed"
        >
          {expanded ? (
            <span className="break-words text-sm font-semibold">{suggestion.label}</span>
          ) : (
            <>
              <span ref={clipped.label} className="truncate text-sm font-semibold">
                {suggestion.label}
              </span>
              <span ref={clipped.prompt} className="line-clamp-2 text-xs text-muted-foreground">
                {suggestion.prompt}
              </span>
            </>
          )}
        </button>
        {expanded || clipped.cut ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls={expanded ? fullId : undefined}
            aria-label={`${expanded ? "Hide" : "Show"} the whole suggestion: ${suggestion.label}`}
            className="flex cursor-pointer items-center px-2 text-muted-foreground hover:text-foreground"
          >
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove suggestion: ${suggestion.label}`}
          className="flex cursor-pointer items-center px-3 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
        >
          <Icon name="Trash2" className="size-4" />
        </button>
      </div>
      {expanded ? (
        <p
          id={fullId}
          className="cursor-text select-text whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          {suggestion.prompt}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the collapsed card cuts its label or prompt, measured again whenever either line changes size.
 * Assumed cut where the browser cannot say (no `ResizeObserver`), so the whole text is always one press
 * away. While expanded nothing is measured; the chevron stays to fold the card again.
 */
function useClipped(expanded: boolean, suggestion: Suggestion) {
  const label = useRef<HTMLSpanElement>(null);
  const prompt = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(true);

  useLayoutEffect(() => {
    if (expanded || typeof ResizeObserver === "undefined") return;
    const lines = [label.current, prompt.current].filter((line) => line !== null);
    const measure = () => setCut(lines.some((line) => line.scrollWidth > line.clientWidth || line.scrollHeight > line.clientHeight));
    const observer = new ResizeObserver(measure);
    lines.forEach((line) => observer.observe(line));
    measure();
    return () => observer.disconnect();
  }, [expanded, suggestion.label, suggestion.prompt]);

  return { label, prompt, cut };
}
