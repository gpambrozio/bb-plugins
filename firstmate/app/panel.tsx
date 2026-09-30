/**
 * The FirstMate tab on any thread. What it shows depends on the thread: the board on the first mate's,
 * the worker's card on a crewmate's, and on any other an offer to adopt it or a way to the first mate.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import type { rpcContract } from "../server";
import type { Fleet } from "../shared/types";
import { Board } from "./board";
import { CrewPanel } from "./crew-panel";
import { reportError } from "./notify";
import { useFleet } from "./use-fleet";

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground">
      <div className="text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

function Elsewhere({ fleet, threadId, onChanged }: { fleet: Fleet; threadId: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);

  if (fleet.mate !== null) {
    const mateId = fleet.mate.threadId;
    return (
      <Notice title="This thread isn't in the crew">
        <div>
          <Button size="sm" variant="outline" onClick={() => navigate.toThread(mateId)}>
            Go to the first mate
          </Button>
        </div>
      </Notice>
    );
  }

  function adopt(): void {
    setBusy(true);
    rpc
      .call("mate.adopt", { threadId })
      .then(() => {
        toast.success("This thread is now the first mate.");
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  return (
    <Notice title="No first mate aboard">
      {fleet.mateMissing ? (
        <p className="text-xs text-muted-foreground">The recorded first mate's thread is gone (archived or deleted).</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Launch one from FirstMate's settings. A thread can be adopted only if it works in the first mate's home,{" "}
        <span className="font-mono break-all">{fleet.home}</span>, where its charter is.
      </p>
      <div>
        <Button size="sm" disabled={busy} onClick={adopt}>
          Adopt this thread
        </Button>
      </div>
    </Notice>
  );
}

export function Panel({ threadId }: { threadId: string }) {
  const { fleet, error, reload } = useFleet();

  if (fleet === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }
  if (fleet.mate !== null && fleet.mate.threadId === threadId) {
    return <Board fleet={fleet} mateThreadId={threadId} onChanged={reload} />;
  }
  const card = fleet.cards.find((candidate) => candidate.crew?.threadId === threadId);
  if (card !== undefined) return <CrewPanel card={card} threadId={threadId} onChanged={reload} />;
  return <Elsewhere fleet={fleet} threadId={threadId} onChanged={reload} />;
}
