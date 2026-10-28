/**
 * A comment's suggested change: the thread's lines as they read now against the suggestion, and
 * "Apply suggestion", which writes it into the working copy and resolves the thread. It can apply only
 * in a view whose new side is the working copy, on new lines the diff still shows as commented.
 * Adapted from diffity's `suggestion-block.tsx` (https://github.com/nilbuild/diffity, MIT).
 */
import { createContext, useContext, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { suggestionLines, suggestionState } from "../shared/suggestion";
import type { ReviewThread } from "../shared/types";
import { useActions } from "./actions";

/** The thread a suggestion is in, and where its lines are in the diff now (absent when not shown). */
export interface SuggestionThread {
  thread: ReviewThread;
  current?: { startLine: number; endLine: number; text: string };
}

export const SuggestionThreadContext = createContext<SuggestionThread | null>(null);

const STATE_LABELS = {
  applied: "Applied",
  outdated: "The lines changed since this was suggested",
  unknown: "The lines are not in this view",
} as const;

export function SuggestionBlock({ code, commentId }: { code: string; commentId: string }) {
  const actions = useActions();
  const context = useContext(SuggestionThreadContext);
  const [busy, setBusy] = useState(false);
  const thread = context?.thread;
  const current = context?.current;
  const original = thread?.anchorContent ?? current?.text ?? "";
  const state = suggestionState(code, current?.text, thread?.anchorContent ?? null);
  const canApply = actions.canEditWorkingCopy && thread?.side === "new" && state === "ready" && current !== undefined;
  const apply = async () => {
    if (thread === undefined || current === undefined) return;
    setBusy(true);
    try {
      await actions.applySuggestion({ reviewThreadId: thread.id, commentId, startLine: current.startLine, endLine: current.endLine, expected: current.text, code });
    } catch {
      // The toast said why.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-border text-xs" data-suggestion="">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-2 py-1">
        <span className="font-medium">Suggested change</span>
        {state === "ready" ? null : <span className="text-muted-foreground">{STATE_LABELS[state]}</span>}
        {canApply ? (
          <Button type="button" size="sm" className="ml-auto h-6 px-2 text-xs" disabled={busy} onClick={() => void apply()}>
            Apply suggestion
          </Button>
        ) : null}
      </div>
      <pre className="overflow-x-auto font-mono">
        {suggestionLines(original, code).map((line, index) => (
          <div
            key={index}
            className={cn("whitespace-pre px-2", line.kind === "del" && "bg-destructive/10 text-destructive", line.kind === "add" && "bg-success/10 text-success")}
          >
            {line.kind === "del" ? "-" : line.kind === "add" ? "+" : " "} {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
