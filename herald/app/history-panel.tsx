/**
 * The Herald tab in a thread's side panel: what Herald said about each of the
 * thread's turns, newest first, so a turn can be found by its sentence. A
 * plugin cannot write into the transcript, so this is the closest thing to a
 * sentence beside each turn. Re-read on every entries nudge — a sentence
 * landing is also a change to the entries.
 *
 * bb keeps a closed panel's tab mounted, so while the tab is not showing its
 * clock stops and a nudge is only noted; the tab reads again when it shows.
 */
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { RpcContract } from "../shared/contract";
import { ENTRIES_CHANNEL, type HistoryItem } from "../shared/herald";
import { useTabVisible } from "./bb-features";
import { HERALD_ICONS } from "./icons";
import { lookOf, readAgain, relativeTime, useNow } from "./panel";
import { canPlaySpeech } from "./speech";
import { TipButton } from "./tip-button";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HeraldHistoryPanel({ threadId }: { threadId: string; params: unknown }) {
  const rpc = useRpc<RpcContract>();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useTabVisible();
  const now = useNow(visible);

  const refresh = useCallback(() => {
    rpc.call("history.list", { threadId }).then(
      ({ items: next }) => {
        setItems(next);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc, threadId]);

  // Read for each thread when it shows, and again after a nudge it missed
  // while hidden. The thread changes the read, so a new one starts stale.
  const stale = useRef(true);
  useEffect(() => {
    stale.current = true;
  }, [refresh]);
  useEffect(() => {
    if (!visible || !stale.current) return;
    stale.current = false;
    refresh();
  }, [visible, refresh]);
  const shown = useRef(visible);
  shown.current = visible;
  const onNudge = useCallback(() => {
    if (shown.current) refresh();
    else stale.current = true;
  }, [refresh]);
  useRealtime(ENTRIES_CHANNEL, onNudge);

  if (items === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing yet: Herald's sentences for this thread's turns will be listed here.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item) => {
        const look = lookOf(item.reason);
        return (
          <li key={item.eventId} className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2">
            <Icon name={look.icon} className={cn("mt-0.5 size-4 shrink-0", look.className)} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                {look.label} · {relativeTime(Date.parse(item.createdAt), now)}
              </p>
              <p className="text-sm italic text-foreground">{item.text}</p>
            </div>
            {canPlaySpeech() ? (
              <TipButton variant="ghost" size="icon" className="size-7 shrink-0" label="Read again" onClick={() => void readAgain(item.text)}>
                <Icon name={HERALD_ICONS.volume} />
              </TipButton>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
