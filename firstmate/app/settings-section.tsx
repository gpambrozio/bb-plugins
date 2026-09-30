/**
 * FirstMate's section in the plugin's settings page, under the host-rendered settings form: where the
 * first mate stands, and launching, restarting or releasing it.
 *
 * Restart ends the first mate's conversation and starts a fresh one from the records; release lets go of
 * the thread without touching it, and the crew keeps running.
 */
import { experimental_ProviderModelPicker as ProviderModelPicker, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import type { rpcContract } from "../server";
import { ConfirmDialog } from "./confirm-dialog";
import { STATUS_WORDS } from "./format";
import { reportError } from "./notify";
import { useDefaultPick } from "./use-default-pick";
import { useFleet } from "./use-fleet";

type Asking = "restart" | "release" | null;

export function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { fleet, error, reload } = useFleet();
  const initial = useDefaultPick();
  const [chosen, setChosen] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);

  const pick = chosen ?? initial.pick;
  const mate = fleet?.mate ?? null;

  function run(action: () => Promise<unknown>, success: string): void {
    setBusy(true);
    action()
      .then(() => {
        toast.success(success);
        reload();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  if (fleet === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {mate === null ? (
        <p className="text-sm">
          {fleet.mateMissing
            ? "The first mate's thread is gone (archived or deleted). Launch a new one."
            : "No first mate aboard."}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Aboard: <span className="font-semibold">{mate.title ?? mate.threadId}</span> · {STATUS_WORDS[mate.status]}
          </span>
          <Button size="sm" variant="outline" onClick={() => navigate.toThread(mate.threadId)}>
            Open thread
          </Button>
        </div>
      )}

      {mate === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {pick === null ? (
            <span className="text-sm text-muted-foreground">{initial.error ?? "Loading models…"}</span>
          ) : (
            <ProviderModelPicker value={pick} onChange={setChosen} />
          )}
          <Button
            disabled={busy || pick === null}
            onClick={() => {
              if (pick === null) return;
              run(
                () => rpc.call("mate.launch", { providerId: pick.providerId, model: pick.model, reasoningLevel: pick.reasoningLevel }),
                "The first mate is aboard.",
              );
            }}
          >
            Launch
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || (mate.status !== "idle" && mate.status !== "error")} onClick={() => setAsking("restart")}>
            Restart
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setAsking("release")}>
            Release
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={asking === "restart"}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Restart the first mate?"
        description="A new first mate starts from scratch, with the same model and settings. This conversation ends but stays readable. Its records carry over and workers already running keep running."
        confirmLabel="Restart"
        onConfirm={() => run(() => rpc.call("mate.restart", {}), "The first mate is starting afresh.")}
      />
      <ConfirmDialog
        open={asking === "release"}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Release the first mate?"
        description="FirstMate lets go of this thread. The thread and its crew are left as they are; you can launch or adopt a first mate again afterwards."
        confirmLabel="Release"
        onConfirm={() => run(() => rpc.call("mate.release", {}), "The first mate was released.")}
      />
    </div>
  );
}
