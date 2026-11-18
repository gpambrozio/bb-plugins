/**
 * What the host-rendered settings form cannot offer: which machine dreams run on (bb's machines,
 * read live) and which model they use, with bb's own model picker. Dreams always run in Claude Code,
 * whose transcripts, memory and hooks they depend on, so the picker cannot switch provider.
 *
 * The model is saved only by its Save button. bb's picker changes its own selection, and calls
 * onChange, when the saved model or reasoning level is not one the machine's Claude Code lists (on
 * mount, on a rerender, when the machine changes), so what it shows is not always what is saved. The
 * section therefore always says what is saved, exactly, and a picker selection that differs from it
 * waits as a draft until the user saves it.
 */
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_PROVIDER, type Choices, type Overview } from "../shared/contract-types";
import { Button } from "../components/ui/button";
import { errorText } from "./use-dream";

const SELECT_CLASS =
  "h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type ModelChoice = Pick<Choices, "model" | "reasoningLevel">;

function sameModel(a: ModelChoice, b: ModelChoice): boolean {
  return a.model === b.model && a.reasoningLevel === b.reasoningLevel;
}

export function DreamSettingsSection() {
  const rpc = useRpc<RpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The picker's selection when it differs from the saved model; saved only by the Save button. */
  const [draft, setDraft] = useState<ModelChoice | null>(null);

  useEffect(() => {
    let live = true;
    rpc
      .call("overview", {})
      .then((next) => live && setOverview(next))
      .catch((caught: unknown) => live && setError(errorText(caught)));
    return () => {
      live = false;
    };
  }, [rpc]);

  async function save(changes: Partial<Choices>): Promise<void> {
    try {
      const choices = await rpc.call("setChoices", changes);
      setOverview((current) => (current ? { ...current, choices } : current));
      const next = await rpc.call("overview", {});
      setOverview(next);
      setDraft(null);
      toast.success("Saved.");
    } catch (caught) {
      toast.error(errorText(caught));
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (overview === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const hostId = overview.host?.id ?? "";
  const saved: ModelChoice = { model: overview.choices.model, reasoningLevel: overview.choices.reasoningLevel };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="dream-machine">
          Dream machine
        </label>
        <p className="text-xs text-muted-foreground">
          Dreams run on this machine only, for the projects with a checkout there, reading its Claude Code sessions and memory. Until you choose one, it is the machine running the bb server.
        </p>
        <select
          id="dream-machine"
          className={SELECT_CLASS}
          value={overview.choices.hostId ?? ""}
          onChange={(event) => void save({ hostId: event.target.value === "" ? null : event.target.value })}
        >
          <option value="">The bb server's machine{overview.choices.hostId === null && overview.host ? ` (${overview.host.name})` : ""}</option>
          {overview.hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
              {host.connected ? "" : " (offline)"}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Model</span>
        <p className="text-xs text-muted-foreground">The Claude Code model and reasoning level each dream thread uses.</p>
        <p className="text-sm" data-testid="dream-saved-model">
          Saved: <code className="font-mono">{saved.model}</code>, {saved.reasoningLevel} reasoning
        </p>
        <ProviderModelPicker
          key={hostId}
          value={{ providerId: DEFAULT_PROVIDER, ...(draft ?? saved) }}
          onChange={(value) => setDraft(sameModel(value, saved) ? null : { model: value.model, reasoningLevel: value.reasoningLevel })}
          allowProviderChange={false}
          {...(hostId ? { routing: { kind: "host" as const, hostId } } : {})}
        />
        {draft !== null && (
          <div className="space-y-2 rounded-md border border-warning p-3">
            <p className="text-xs text-warning-text">
              Not saved. The picker shows <code className="font-mono">{draft.model}</code>, {draft.reasoningLevel} reasoning; dreams keep using the saved model until you save
              this one. When you did not pick it, this machine's Claude Code does not list the saved model or reasoning level, and the picker chose the nearest it has.
            </p>
            <Button type="button" size="sm" onClick={() => void save(draft)}>
              Save {draft.model}, {draft.reasoningLevel} reasoning
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
