/**
 * What the host-rendered settings form cannot offer: which machine dreams run on (bb's machines,
 * read live) and which model they use, with bb's own model picker. Dreams always run in Claude Code,
 * whose transcripts, memory and hooks they depend on, so the picker cannot switch provider.
 */
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_PROVIDER, type Choices, type Overview } from "../shared/contract-types";
import { errorText } from "./use-dream";

const SELECT_CLASS =
  "h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function DreamSettingsSection() {
  const rpc = useRpc<RpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set once the user presses or types in the model picker; until then its onChange is bb's own. */
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };

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

  async function save(changes: Partial<Choices>) {
    try {
      const choices = await rpc.call("setChoices", changes);
      setOverview((current) => (current ? { ...current, choices } : current));
      const next = await rpc.call("overview", {});
      setOverview(next);
      toast.success("Saved.");
    } catch (caught) {
      toast.error(errorText(caught));
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (overview === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const hostId = overview.host?.id ?? "";

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
        {/* Only a choice the user makes is saved: bb's picker also calls onChange by itself, on
            mount, when the stored model is not one this Claude Code lists, and saving that would
            overwrite the user's choice just by opening the settings. */}
        <div onPointerDownCapture={touch} onKeyDownCapture={touch}>
          <ProviderModelPicker
            value={{ providerId: DEFAULT_PROVIDER, model: overview.choices.model, reasoningLevel: overview.choices.reasoningLevel }}
            onChange={(value) => {
              if (!touched.current) return;
              if (value.model === overview.choices.model && value.reasoningLevel === overview.choices.reasoningLevel) return;
              void save({ model: value.model, reasoningLevel: value.reasoningLevel });
            }}
            allowProviderChange={false}
            {...(hostId ? { routing: { kind: "host" as const, hostId } } : {})}
          />
        </div>
      </div>
    </div>
  );
}
