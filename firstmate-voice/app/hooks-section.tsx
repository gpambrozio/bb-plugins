/**
 * The voice hooks in the plugin's settings: every machine bb knows, whether it has a hook file, and which
 * machine this window runs on. Nothing here sets or shows a command: each machine runs its own
 * `~/.config/firstmate-voice/hook`, which the owner writes there (see the README).
 */
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import type { rpcContract } from "../server";
import { HOOK_EVENT_ENV, HOOK_FILE_SHOWN, HOOK_REASON_ENV, HOOK_TIMEOUT_MS, type HookFileStatus } from "../shared/hooks";
import { createLocalHostLookup } from "./machine";
import { voicePlatform } from "./platform";

interface MachineStatus {
  hostId: string;
  name: string;
  status: HookFileStatus | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the settings say of one machine's hook file. */
export function hookFileText(status: HookFileStatus | null): string {
  if (status === null) return "Did not answer: it may be offline.";
  if (!status.present) return `No hook file: nothing runs.`;
  if (!status.executable) return `Has ${HOOK_FILE_SHOWN}, but it is not executable (chmod +x), so it does not run.`;
  return `Has ${HOOK_FILE_SHOWN}: it runs.`;
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
  const [machines, setMachines] = useState<MachineStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const here = useThisMachine();

  useEffect(() => {
    let live = true;
    setError(null);
    rpc.call("hooks.status", {}).then(
      (result) => live && setMachines(result.machines),
      (cause: unknown) => live && setError(errorText(cause)),
    );
    return () => {
      live = false;
    };
  }, [rpc, reads]);

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Each machine runs its own hook: the executable file <code>{HOOK_FILE_SHOWN}</code> in its home folder, which you write there.
          Nothing in bb sets it or shows what is in it. It runs on the machine whose bb desktop app is in the call, from the home folder,
          with {HOOK_EVENT_ENV} set to <code>listening-started</code>, <code>listening-stopped</code>, <code>speaking-started</code>,{" "}
          <code>speaking-stopped</code>, <code>talking-started</code> or <code>talking-stopped</code>, and {HOOK_REASON_ENV} set to why
          listening stopped. Speaking is the voice; talking is you. Output is ignored. A run gets {HOOK_TIMEOUT_MS / 1000} seconds and is
          then stopped, with anything it started; the call goes on either way, and each run is in the debug log. bb&apos;s mobile app and
          a browser tab run no hooks.
        </p>
        <p className="text-xs text-muted-foreground">{here.note}</p>
      </div>
      {error !== null ? (
        <p className="text-xs text-destructive">Could not ask the machines: {error}</p>
      ) : machines === null ? (
        <p className="text-xs text-muted-foreground">Asking the machines…</p>
      ) : machines.length === 0 ? (
        <p className="text-xs text-muted-foreground">bb has no machines to run hooks on.</p>
      ) : (
        <ul className="space-y-2">
          {machines.map((machine) => (
            <li key={machine.hostId} className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">
                {machine.name}
                {machine.hostId === here.hostId ? <span className="ml-2 text-xs font-normal text-muted-foreground">this machine</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">{hookFileText(machine.status)}</p>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="outline" onClick={() => setReads((count) => count + 1)}>
        Check again
      </Button>
    </section>
  );
}
