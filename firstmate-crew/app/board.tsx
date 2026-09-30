/**
 * The crew board, shown on the first mate's thread: a notice when the plugin's charter has moved on, the
 * Bearings and Ahoy buttons beside the first mate's own controls (Compact, Restart, settings), the first
 * mate's suggestions, the seven columns in their fixed order — each a
 * collapsible section with its count, empty ones left out — and the home's watches.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Icon } from "../components/ui/icon";
import type { rpcContract } from "../server";
import { COLUMN_IDS, type ColumnId, type Fleet } from "../shared/types";
import { Card } from "./card";
import { COLUMN_TITLES } from "./format";
import { readFolds, toggleFold } from "./folds";
import { MateActions } from "./mate-actions";
import { reportError } from "./notify";
import { Suggestions } from "./suggestions";
import { useMateSender } from "./use-mate-sender";
import { useOpenHomeFile } from "./use-open-home-file";
import { Watches } from "./watches";

export function Board({ fleet, mateThreadId, onChanged }: { fleet: Fleet; mateThreadId: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const mate = useMateSender();
  const openHomeFile = useOpenHomeFile(mateThreadId);
  const [folds, setFolds] = useState<Set<ColumnId>>(() => readFolds(window.localStorage));
  const [busy, setBusy] = useState(false);

  function run(action: () => Promise<unknown>, success?: string): void {
    setBusy(true);
    action()
      .then(() => {
        if (success !== undefined) toast.success(success);
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  function compare(): void {
    setBusy(true);
    rpc
      .call("charter.compare", {})
      .then(({ path }) => openHomeFile(path))
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-4">
      {fleet.charter.outdated ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3 text-sm">
          <div>
            FirstMate's own charter has changed since you edited yours in data/charter.md. Compare them, bring over what
            you want, then press Done.
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={compare}>
              Compare
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => run(() => rpc.call("charter.acknowledge", {}), "Your charter is now taken as up to date.")}
            >
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={mate.sending} onClick={() => mate.command("bearings")}>
          Bearings
        </Button>
        <Button size="sm" variant="outline" disabled={mate.sending} onClick={() => mate.command("ahoy")}>
          Ahoy
        </Button>
        {fleet.mate !== null ? <MateActions status={fleet.mate.status} sending={mate.sending} onChanged={onChanged} /> : null}
      </div>

      <Suggestions suggestions={fleet.suggestions} mateThreadId={mateThreadId} onChanged={onChanged} />

      {COLUMN_IDS.map((id) => {
        const cards = fleet.cards.filter((card) => card.column === id);
        if (cards.length === 0) return null;
        const open = !folds.has(id);
        return (
          <Collapsible key={id} open={open} onOpenChange={() => setFolds(toggleFold(window.localStorage, id))} className="flex flex-col gap-2">
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4" />
              {COLUMN_TITLES[id]} ({cards.length})
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2">
              {cards.map((card) => (
                <Card key={card.key} card={card} onChanged={onChanged} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        );
      })}

      <Watches watches={fleet.watches} onChanged={onChanged} onOpenFile={openHomeFile} />
    </div>
  );
}
