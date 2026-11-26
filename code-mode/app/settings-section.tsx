// Code Mode's switches on its settings page: the machines where Code Mode may run (all off until
// turned on; Claude Code refuses Code Mode for some accounts, such as an organization under HIPAA),
// and the projects whose new threads start in Code Mode. Turning a machine on writes the wrapper
// there and says whether that worked.
import { experimental_useRpcQuery, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import { hostAllowed, projectDefault, type Config } from "../shared/config";
import { rpcContract, type HostCheck, type RpcContract } from "../shared/contract";

interface Named {
  id: string;
  name: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useNamed(load: () => Promise<Named[]>): { items: Named[] | null; error: string | null } {
  const [items, setItems] = useState<Named[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((loaded) => live && setItems([...loaded].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((cause: unknown) => live && setError(errorText(cause)));
    return () => {
      live = false;
    };
  }, [load]);
  return { items, error };
}

function Row(props: { id: string; label: string; checked: boolean; disabled: boolean; onChange(on: boolean): void; children?: React.ReactNode }) {
  const inputId = `code-mode-${props.id}`;
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <Checkbox id={inputId} checked={props.checked} disabled={props.disabled} onCheckedChange={(value) => props.onChange(value === true)} />
        <label htmlFor={inputId} className="text-sm">
          {props.label}
        </label>
      </div>
      {props.children}
    </div>
  );
}

export function SettingsSection() {
  const sdk = useSdk();
  const rpc = useRpc<RpcContract>();
  const read = experimental_useRpcQuery({ contract: rpcContract, method: "config.get", input: {} });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, HostCheck | "checking">>({});

  const hosts = useNamed(useCallback(async () => (await sdk.hosts.list()).map((host) => ({ id: host.id, name: host.name })), [sdk]));
  const projects = useNamed(useCallback(async () => (await sdk.projects.list({ includePersonal: true })).map((project) => ({ id: project.id, name: project.name })), [sdk]));

  const check = useCallback(
    async (hostId: string) => {
      setChecks((current) => ({ ...current, [hostId]: "checking" }));
      try {
        const result = await rpc.call("hosts.check", { hostId });
        setChecks((current) => ({ ...current, [hostId]: result }));
      } catch (cause) {
        setChecks((current) => ({ ...current, [hostId]: { ok: false, message: errorText(cause) } }));
      }
    },
    [rpc],
  );

  const save = useCallback(
    async (write: () => Promise<Config>) => {
      setSaving(true);
      setProblem(null);
      try {
        await write();
        await read.refetch();
      } catch (cause) {
        setProblem(errorText(cause));
      } finally {
        setSaving(false);
      }
    },
    [read],
  );

  // Check every machine that is turned on once, when the page opens, so each shows whether its wrapper is ready.
  const checked = useRef(false);
  const config = read.data;
  useEffect(() => {
    if (!config || checked.current) return;
    checked.current = true;
    for (const [hostId, on] of Object.entries(config.hosts)) if (on) void check(hostId);
  }, [config, check]);

  if (!config) {
    return <p className="text-sm text-muted-foreground">{read.error ? `Could not load Code Mode's switches: ${read.error.message}` : "Loading…"}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Machines</h3>
        <p className="text-xs text-muted-foreground">
          Code Mode runs only on the machines turned on here. Turn off a machine whose Claude Code account can&apos;t use Code Mode. Turning one off later leaves its Code Mode threads in Code Mode.
        </p>
        {hosts.error && <p className="text-xs text-destructive">Could not list the machines: {hosts.error}</p>}
        {hosts.items?.map((host) => {
          const on = hostAllowed(config, host.id);
          const state = checks[host.id];
          return (
            <Row
              key={host.id}
              id={`host-${host.id}`}
              label={host.name}
              checked={on}
              disabled={saving}
              onChange={(next) =>
                void save(async () => {
                  const updated = await rpc.call("config.setHost", { hostId: host.id, on: next });
                  if (next) void check(host.id);
                  return updated;
                })
              }
            >
              {on && (
                <div className="flex items-center gap-2 pl-6 text-xs">
                  {state === "checking" && <span className="text-muted-foreground">Writing the wrapper…</span>}
                  {state && state !== "checking" && <span className={state.ok ? "text-success" : "text-destructive"}>{state.ok ? "Wrapper ready" : state.message}</span>}
                  <Button type="button" variant="ghost" size="sm" disabled={state === "checking"} onClick={() => void check(host.id)}>
                    Check
                  </Button>
                </div>
              )}
            </Row>
          );
        })}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Projects that start in Code Mode</h3>
        <p className="text-xs text-muted-foreground">
          New Claude Code threads in these projects start in Code Mode, on machines turned on above, with a model that supports it. In any project, Send in Code Mode in the Send menu starts one thread that way.
        </p>
        {projects.error && <p className="text-xs text-destructive">Could not list the projects: {projects.error}</p>}
        {projects.items?.map((project) => (
          <Row
            key={project.id}
            id={`project-${project.id}`}
            label={project.name}
            checked={projectDefault(config, project.id)}
            disabled={saving}
            onChange={(next) => void save(() => rpc.call("config.setProject", { projectId: project.id, on: next }))}
          />
        ))}
      </section>
      {problem && <p className="text-xs text-destructive">Could not save: {problem}</p>}
    </div>
  );
}
