/** What a crewmate's own thread shows: its card, and a place to leave a note for it and the first mate. */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import type { rpcContract } from "../server";
import type { FleetCard } from "../shared/types";
import { Card } from "./card";
import { reportError } from "./notify";

export function CrewPanel({ card, threadId, onChanged }: { card: FleetCard; threadId: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function send(): void {
    setBusy(true);
    rpc
      .call("crew.note", { threadId, note: note.trim() })
      .then(() => {
        toast.success("Noted.");
        setNote("");
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-4">
      <Card card={card} onChanged={onChanged} showOpen={false} />
      <div className="flex flex-col gap-2">
        <label htmlFor="firstmate-note" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Note
        </label>
        <Textarea
          id="firstmate-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Something the first mate should know about this worker"
        />
        <div>
          <Button size="sm" disabled={busy || note.trim() === ""} onClick={send}>
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
