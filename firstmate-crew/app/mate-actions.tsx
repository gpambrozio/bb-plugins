/**
 * The first mate's own controls at the top of the board: Compact, Restart (with its confirmation) and a
 * gear that opens FirstMate's settings page. Compact and Restart go only while the first mate is idle or
 * errored — the server refuses mid-turn too — and not while a message to it is on its way.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import type { rpcContract } from "../server";
import type { ThreadStatus } from "../shared/types";
import { ConfirmDialog } from "./confirm-dialog";
import { reportError } from "./notify";
import { openPluginSettings } from "./open-plugin-settings";

/** The confirmation a restart asks for, here and in the settings section. */
export const RESTART_CONFIRMATION = {
  title: "Restart the first mate?",
  description:
    "A new first mate starts from scratch, with the same model and settings. This conversation ends but stays readable. Its records carry over and workers already running keep running.",
  confirmLabel: "Restart",
  success: "The first mate is starting afresh.",
} as const;

export function isBetweenTurns(status: ThreadStatus): boolean {
  return status === "idle" || status === "error";
}

export function MateActions({ status, sending, onChanged }: { status: ThreadStatus; sending: boolean; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const blocked = busy || sending || !isBetweenTurns(status);

  function run(action: () => Promise<unknown>, success: string): void {
    setBusy(true);
    action()
      .then(() => {
        toast.success(success);
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  function openPreferences(): void {
    if (!openPluginSettings(window)) toast.info("FirstMate's settings are in Settings → Plugins → FirstMate.");
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={blocked}
        onClick={() => run(() => rpc.call("mate.compact", {}), "The first mate is compacting its conversation.")}
      >
        Compact
      </Button>
      <Button size="sm" variant="outline" disabled={blocked} onClick={() => setAsking(true)}>
        Restart
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" aria-label="FirstMate settings" onClick={openPreferences}>
        <Icon name="Settings" className="size-4" />
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={RESTART_CONFIRMATION.title}
        description={RESTART_CONFIRMATION.description}
        confirmLabel={RESTART_CONFIRMATION.confirmLabel}
        onConfirm={() => run(() => rpc.call("mate.restart", {}), RESTART_CONFIRMATION.success)}
      />
    </>
  );
}
