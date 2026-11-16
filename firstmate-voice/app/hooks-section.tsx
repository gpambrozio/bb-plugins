/**
 * The voice hooks in the plugin's settings: every machine bb knows, each with its one command, and which
 * machine this window runs on. The host-rendered form holds one value per setting for every device, which
 * cannot say "per machine"; so the commands live in the plugin's storage, by host id (as Herald's speech
 * hooks do).
 */
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { rpcContract } from "../server";
import { HOOK_EVENT_ENV, HOOK_REASON_ENV, HOOK_TIMEOUT_MS, type VoiceHooks } from "../shared/hooks";
import { createLocalHostLookup } from "./machine";
import { voicePlatform } from "./platform";

const FIELD_CLASS =
  "flex min-h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Machine {
  id: string;
  name: string;
  /** False for a machine that has a command saved but is no longer one of bb's. */
  known: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every machine bb lists, then any with a saved command that bb no longer lists. */
export function hookMachines(hosts: ReadonlyArray<{ id: string; name: string }>, hooks: VoiceHooks): Machine[] {
  const listed = hosts.map((host) => ({ ...host, known: true }));
  const gone = Object.keys(hooks)
    .filter((id) => !listed.some((host) => host.id === id))
    .map((id) => ({ id, name: id, known: false }));
  return [...listed, ...gone];
}

function MachineHookForm({ machine, stored, here, onSave }: { machine: Machine; stored: string; here: boolean; onSave: (command: string) => void }) {
  const [draft, setDraft] = useState(stored);
  // Only a change to this machine's own command replaces the draft, so saving another keeps what is typed here.
  useEffect(() => setDraft(stored), [stored]);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">
        {machine.name}
        {here ? <span className="ml-2 text-xs font-normal text-muted-foreground">this machine</span> : null}
        {machine.known ? null : <span className="ml-2 text-xs font-normal text-muted-foreground">no longer one of bb&apos;s machines</span>}
      </p>
      <textarea
        aria-label={`Voice hook on ${machine.name}`}
        className={FIELD_CLASS}
        rows={2}
        value={draft}
        spellCheck={false}
        placeholder="Nothing runs"
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button size="sm" variant="outline" disabled={draft === stored} onClick={() => onSave(draft)}>
        Save the hook for {machine.name}
      </Button>
    </div>
  );
}

/** Where this window stands: whether it runs hooks, and on which machine. */
function useThisMachine(): { hostId: string | null; note: string } {
  const sdk = useSdk();
  const platform = voicePlatform();
  const [hostId, setHostId] = useState<string | null | undefined>(platform === "desktop" ? undefined : null);
  useEffect(() => {
    if (platform !== "desktop") return;
    let live = true;
    void createLocalHostLookup(async () => (await sdk.system.config()).localHelperPorts ?? [])().then((id) => live && setHostId(id));
    return () => {
      live = false;
    };
  }, [sdk, platform]);
  if (platform === "mobile") return { hostId: null, note: "This is bb's mobile app, which runs no hooks." };
  if (platform === "browser") return { hostId: null, note: "This is a browser tab, which runs no hooks; bb's desktop app does." };
  if (hostId === undefined) return { hostId: null, note: "Looking for this machine…" };
  if (hostId === null) return { hostId: null, note: "This machine is not one of bb's machines for this server, so a call from this window runs no hook." };
  return { hostId, note: "A call from this window runs the hook of the machine marked “this machine”." };
}

export function VoiceHooksSection() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [hooks, setHooks] = useState<VoiceHooks | null>(null);
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
      .catch(() => setHosts([]));
  }, [rpc, sdk]);

  const machines = useMemo(() => hookMachines(hosts ?? [], hooks ?? {}), [hosts, hooks]);

  function save(hostId: string, command: string): void {
    rpc.call("hooks.set", { hostId, command }).then(
      (result) => setHooks(result.hooks),
      (cause: unknown) => toast.error(`Could not save the hook: ${errorText(cause)}`),
    );
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          One command per machine, run on the machine whose bb desktop app is in the call: through its shell, from the home folder,
          with {HOOK_EVENT_ENV} set to <code>listening-started</code>, <code>listening-stopped</code>, <code>speaking-started</code>,{" "}
          <code>speaking-stopped</code>, <code>talking-started</code> or <code>talking-stopped</code>, and {HOOK_REASON_ENV} set to why
          listening stopped. Speaking is the voice; talking is you. Output is ignored. A command gets {HOOK_TIMEOUT_MS / 1000} seconds
          and is then stopped; the call goes on either way, and each run is in the debug log. bb&apos;s mobile app and a browser tab run no
          hooks. Empty runs nothing.
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
          <MachineHookForm
            key={machine.id}
            machine={machine}
            stored={hooks[machine.id] ?? ""}
            here={machine.id === here.hostId}
            onSave={(command) => save(machine.id, command)}
          />
        ))
      )}
    </section>
  );
}
