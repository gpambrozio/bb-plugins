/**
 * The speech hooks in Herald's settings: every machine bb knows, each with its
 * before- and after-speaking command, and which machine this window runs on.
 * The host-rendered form holds one value per setting for every device, which
 * cannot say "per machine"; so these live in Herald's storage, by host id.
 */
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { RpcContract } from "../shared/contract";
import { NO_HOOKS, SPEECH_HOOK_ENV, SPEECH_HOOK_TIMEOUT_MS, type MachineHooks, type SpeechHooks } from "../shared/speech-hooks";
import { speechPlatform } from "./speech";
import { createLocalHostLookup } from "./speech-hooks";

const FIELD_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Machine {
  id: string;
  name: string;
  /** False for a machine that has hooks saved but is no longer one of bb's. */
  known: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One machine's two commands, saved together. */
function MachineHooksForm({
  machine,
  stored,
  here,
  onSave,
}: {
  machine: Machine;
  stored: MachineHooks;
  here: boolean;
  onSave: (hooks: MachineHooks) => void;
}) {
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const changed = draft.before !== stored.before || draft.after !== stored.after;
  const field = (kind: keyof MachineHooks, label: string) => (
    <div className="space-y-1">
      <p className="text-xs font-semibold">{label}</p>
      <textarea
        aria-label={`${label} on ${machine.name}`}
        className={`${FIELD_CLASS} min-h-10`}
        rows={2}
        value={draft[kind]}
        spellCheck={false}
        placeholder="Nothing runs"
        onChange={(event) => setDraft({ ...draft, [kind]: event.target.value })}
      />
    </div>
  );
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">
        {machine.name}
        {here ? <span className="ml-2 text-xs font-normal text-muted-foreground">this machine</span> : null}
        {machine.known ? null : <span className="ml-2 text-xs font-normal text-muted-foreground">no longer one of bb&apos;s machines</span>}
      </p>
      {field("before", "Before speaking")}
      {field("after", "After speaking")}
      <Button size="sm" variant="outline" disabled={!changed} onClick={() => onSave(draft)}>
        Save hooks for {machine.name}
      </Button>
    </div>
  );
}

/** Where this window stands: whether it runs hooks, and on which machine. */
function useThisMachine(): { hostId: string | null; note: string } {
  const sdk = useSdk();
  const platform = speechPlatform();
  const [hostId, setHostId] = useState<string | null | undefined>(platform === "desktop" ? undefined : null);
  useEffect(() => {
    if (platform !== "desktop") return;
    let live = true;
    createLocalHostLookup(async () => (await sdk.system.config()).localHelperPorts ?? [])()
      .then((id) => live && setHostId(id))
      .catch(() => live && setHostId(null));
    return () => {
      live = false;
    };
  }, [sdk, platform]);
  if (platform === "mobile") return { hostId: null, note: "This is bb's mobile app, which runs no hooks." };
  if (platform === "browser") return { hostId: null, note: "This is a browser tab, which runs no hooks; bb's desktop app does." };
  if (hostId === undefined) return { hostId: null, note: "Looking for this machine…" };
  if (hostId === null) {
    return { hostId: null, note: "This machine is not one of bb's machines for this server, so no hook runs in this window." };
  }
  return { hostId, note: "This window runs the hooks of the machine marked “this machine”." };
}

export function SpeechHooksSection() {
  const rpc = useRpc<RpcContract>();
  const sdk = useSdk();
  const [hooks, setHooks] = useState<SpeechHooks | null>(null);
  const [hosts, setHosts] = useState<Array<{ id: string; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const here = useThisMachine();

  useEffect(() => {
    rpc.call("hooks.list", {}).then(
      (result) => setHooks(result.hooks),
      (cause: unknown) => setError(errorText(cause)),
    );
    // Through a promise, so a client that cannot list machines shows none rather than crashing the section.
    Promise.resolve()
      .then(() => sdk.hosts.list())
      .then((list) => setHosts(list.filter((host) => (host.lifecycle?.phase ?? "active") === "active").map(({ id, name }) => ({ id, name }))))
      .catch((cause: unknown) => {
        console.warn("[herald] could not list bb's machines", cause);
        setHosts([]);
      });
  }, [rpc, sdk]);

  const machines = useMemo<Machine[]>(() => {
    const listed = (hosts ?? []).map((host) => ({ ...host, known: true }));
    const gone = Object.keys(hooks ?? {})
      .filter((id) => !listed.some((host) => host.id === id))
      .map((id) => ({ id, name: id, known: false }));
    return [...listed, ...gone];
  }, [hosts, hooks]);

  function save(hostId: string, next: MachineHooks): void {
    rpc.call("hooks.set", { hostId, ...next }).then(
      (result) => setHooks(result.hooks),
      (cause: unknown) => toast.error(`Could not save the hooks: ${errorText(cause)}`),
    );
  }

  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Speech hooks</h3>
        <p className="text-xs text-muted-foreground">
          A command to run on a machine just before Herald speaks there, and one once it has finished — to pause music or lower the
          volume, say. Each machine has its own, and empty runs nothing. They run on the machine whose bb desktop app speaks, through
          its shell, from the home folder, with {SPEECH_HOOK_ENV} set to <code>before</code> or <code>after</code>. Sentences said back
          to back share one before and one after, and the after hook runs even when the speech failed. A hook gets{" "}
          {SPEECH_HOOK_TIMEOUT_MS / 1000} seconds; one that is slower is stopped, and one that fails is noted in the plugin&apos;s log —
          Herald speaks either way. bb&apos;s mobile app and a browser tab run no hooks.
        </p>
        <p className="text-xs text-muted-foreground">{here.note}</p>
      </div>
      {error !== null ? (
        <p className="text-xs text-destructive">Could not read the hooks: {error}</p>
      ) : hooks === null || hosts === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : machines.length === 0 ? (
        <p className="text-xs text-muted-foreground">bb has no machines to run hooks on.</p>
      ) : (
        machines.map((machine) => (
          <MachineHooksForm
            key={machine.id}
            machine={machine}
            stored={hooks[machine.id] ?? NO_HOOKS}
            here={machine.id === here.hostId}
            onSave={(next) => save(machine.id, next)}
          />
        ))
      )}
    </section>
  );
}
