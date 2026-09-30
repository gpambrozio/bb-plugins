/**
 * The home's watch scripts: one row each with its schedule, how its last run went, what it last printed
 * and a switch that turns it off or on. The scripts are edited as files; a watch's name opens its script.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import type { rpcContract } from "../server";
import { WATCHES_DIR, type WatchSummary } from "../shared/types";
import { watchStatusText } from "./format";
import { reportError } from "./notify";

function Badge({ children, tone }: { children: string; tone: "warn" | "quiet" }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 text-[10px] font-medium",
        tone === "warn" ? "border-destructive text-destructive" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function Watches({
  watches,
  onChanged,
  onOpenFile,
}: {
  watches: readonly WatchSummary[];
  /** A watch was switched; the board should load again. */
  onChanged: () => void;
  /** Opens a file of the home, by path relative to it. */
  onOpenFile: (path: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  /** Switched here and not yet reloaded, so the switch moves at once. */
  const [switched, setSwitched] = useState<Record<string, boolean>>({});

  // A switch the board has caught up with is the board's again, so a change made elsewhere shows.
  useEffect(() => {
    setSwitched((current) => {
      const left = Object.entries(current).filter(([name, enabled]) =>
        watches.some((watch) => watch.name === name && watch.enabled !== enabled),
      );
      return left.length === Object.keys(current).length ? current : Object.fromEntries(left);
    });
  }, [watches]);

  if (watches.length === 0) return null;

  function setEnabled(watch: WatchSummary, enabled: boolean): void {
    setSwitched((current) => ({ ...current, [watch.name]: enabled }));
    rpc
      .call("watch.toggle", { name: watch.name, enabled })
      .then(onChanged)
      .catch((caught: unknown) => {
        reportError(caught);
        setSwitched(({ [watch.name]: _dropped, ...rest }) => rest);
      });
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Watches</h3>
      {watches.map((served) => {
        const watch = { ...served, enabled: switched[served.name] ?? served.enabled };
        const failing = watch.invalid !== null || watch.lastResult === "failed";
        const problem = watch.invalid ?? (watch.lastResult === "failed" ? watch.lastError : null);
        return (
          <div key={watch.name} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-card-foreground">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-semibold underline"
                onClick={() => onOpenFile(`${WATCHES_DIR}/${watch.name}`)}
              >
                {watch.name}
              </button>
              {failing ? <Badge tone="warn">failing</Badge> : null}
              {watch.outdated ? <Badge tone="quiet">outdated</Badge> : null}
              <Switch
                checked={watch.enabled}
                aria-label={`${watch.name} is ${watch.enabled ? "on" : "off"}`}
                onCheckedChange={(enabled) => setEnabled(watch, enabled)}
              />
            </div>
            {watch.schedule === null ? null : <div className="font-mono text-xs text-muted-foreground">{watch.schedule}</div>}
            <div className="text-xs text-muted-foreground">{watchStatusText(watch)}</div>
            {problem === null ? null : <div className="text-xs text-destructive">{problem}</div>}
            {watch.outdated ? (
              <div className="text-xs text-muted-foreground">
                Edited here; FirstMate's own version has changed since. Delete the file to take the new one.
              </div>
            ) : null}
            {watch.lastOutput === null ? null : (
              <Collapsible>
                <CollapsibleTrigger className="cursor-pointer text-xs text-muted-foreground underline">Last output</CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs text-foreground">
                    {watch.lastOutput}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        );
      })}
    </section>
  );
}
