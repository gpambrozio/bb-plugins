// Code Mode's switches on its settings page: the machines where Code Mode may run (all off until
// turned on; Claude Code refuses Code Mode for some accounts, such as an organization under HIPAA),
// and the projects whose new threads start in Code Mode. Turning a machine on writes the wrapper
// there and says whether that worked; Select all turns on only the machines where it did
// (app/select-all.ts). Projects are listed once per name: same-named bb projects share a switch
// (app/rows.ts).
import { experimental_useRpcQuery, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import { hostAllowed, projectDefault, type Config } from "../shared/config";
import { rpcContract, type HostCheck, type RpcContract } from "../shared/contract";
import { hostRows, projectRows, type HostLike, type ProjectLike, type Row } from "./rows";
import { selectAllMachines } from "./select-all";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useLoaded<T>(load: () => Promise<T>): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((loaded) => live && setValue(loaded))
      .catch((cause: unknown) => live && setError(errorText(cause)));
    return () => {
      live = false;
    };
  }, [load]);
  return { value, error };
}

function SwitchRow(props: { row: Row; index: number; prefix: string; checked: boolean; disabled: boolean; onChange(on: boolean): void; children?: ReactNode }) {
  // A project name can hold any character, so the element id is the row's position.
  const inputId = `code-mode-${props.prefix}-${props.index}`;
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <Checkbox id={inputId} checked={props.checked} disabled={props.disabled} onCheckedChange={(value) => props.onChange(value === true)} />
        <label htmlFor={inputId} className="text-sm">
          {props.row.label}
        </label>
      </div>
      {props.children}
    </div>
  );
}

function ListHeader(props: { title: string; label: string; disabled: boolean; onAll(): void; onNone(): void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-medium">{props.title}</h3>
      <div className="flex gap-1">
        <Button type="button" variant="ghost" size="sm" disabled={props.disabled} aria-label={`Select all ${props.label}`} onClick={props.onAll}>
          Select all
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={props.disabled} aria-label={`Select no ${props.label}`} onClick={props.onNone}>
          Select none
        </Button>
      </div>
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

  const hosts = useLoaded(useCallback(async (): Promise<HostLike[]> => (await sdk.hosts.list()).map((host) => ({ id: host.id, name: host.name })), [sdk]));
  const projects = useLoaded(useCallback(async (): Promise<ProjectLike[]> => (await sdk.projects.list({ includePersonal: true })).map((project) => ({ name: project.name })), [sdk]));
  const machineRows = hosts.value ? hostRows(hosts.value) : null;
  const projectList = projects.value ? projectRows(projects.value) : null;

  const report = useCallback((hostId: string, result: HostCheck | "checking") => {
    setChecks((current) => ({ ...current, [hostId]: result }));
  }, []);

  const check = useCallback(
    async (hostId: string) => {
      report(hostId, "checking");
      try {
        report(hostId, await rpc.call("hosts.check", { hostId }));
      } catch (cause) {
        report(hostId, { ok: false, message: errorText(cause) });
      }
    },
    [rpc, report],
  );

  const save = useCallback(
    async (write: () => Promise<unknown>) => {
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
  const config: Config | undefined = read.data;
  useEffect(() => {
    if (!config || checked.current) return;
    checked.current = true;
    for (const [hostId, on] of Object.entries(config.hosts)) if (on) void check(hostId);
  }, [config, check]);

  if (!config) {
    return <p className="text-sm text-muted-foreground">{read.error ? `Could not load Code Mode's switches: ${read.error.message}` : "Loading…"}</p>;
  }

  const selectAllHosts = () =>
    void save(async () => {
      const off = (machineRows ?? []).map((row) => row.key).filter((hostId) => !hostAllowed(config, hostId));
      for (const hostId of off) report(hostId, "checking");
      await selectAllMachines(off, {
        check: (hostId) => rpc.call("hosts.check", { hostId }),
        turnOn: (hostIds) => rpc.call("config.setHosts", { hostIds: [...hostIds], on: true }),
        report,
      });
    });

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1">
        <ListHeader
          title="Machines"
          label="machines"
          disabled={saving || !machineRows}
          onAll={selectAllHosts}
          onNone={() => void save(() => rpc.call("config.setHosts", { hostIds: (machineRows ?? []).map((row) => row.key), on: false }))}
        />
        <p className="text-xs text-muted-foreground">
          Code Mode runs only on the machines turned on here. Select all turns on only the machines where the wrapper is ready. Leave off a machine whose Claude Code account can&apos;t use Code Mode. Turning one off later leaves its Code Mode threads in Code Mode.
        </p>
        {hosts.error && <p className="text-xs text-destructive">Could not list the machines: {hosts.error}</p>}
        {machineRows?.map((row, index) => {
          const on = hostAllowed(config, row.key);
          const state = checks[row.key];
          return (
            <SwitchRow
              key={row.key}
              row={row}
              index={index}
              prefix="host"
              checked={on}
              disabled={saving}
              onChange={(next) =>
                void save(async () => {
                  await rpc.call("config.setHost", { hostId: row.key, on: next });
                  if (next) void check(row.key);
                })
              }
            >
              {(on || state) && (
                <div className="flex items-center gap-2 pl-6 text-xs">
                  {state === "checking" && <span className="text-muted-foreground">Writing the wrapper…</span>}
                  {state && state !== "checking" && <span className={state.ok ? "text-success" : "text-destructive"}>{state.ok ? "Wrapper ready" : state.message}</span>}
                  <Button type="button" variant="ghost" size="sm" disabled={state === "checking"} onClick={() => void check(row.key)}>
                    Check
                  </Button>
                </div>
              )}
            </SwitchRow>
          );
        })}
      </section>
      <section className="flex flex-col gap-1">
        <ListHeader
          title="Projects that start in Code Mode"
          label="projects"
          disabled={saving || !projectList}
          onAll={() => void save(() => rpc.call("config.setProjectNames", { names: (projectList ?? []).map((row) => row.key), on: true }))}
          onNone={() => void save(() => rpc.call("config.setProjectNames", { names: (projectList ?? []).map((row) => row.key), on: false }))}
        />
        <p className="text-xs text-muted-foreground">
          A new Claude Code thread starts in Code Mode when its project is on here and its machine is on above, with a model that supports it. Projects with the same name share a switch, and a project added later with that name follows it. In any project, Send in Code Mode in the Send menu starts one thread that way.
        </p>
        {projects.error && <p className="text-xs text-destructive">Could not list the projects: {projects.error}</p>}
        {projectList?.map((row, index) => (
          <SwitchRow
            key={row.key}
            row={row}
            index={index}
            prefix="project"
            checked={projectDefault(config, row.key)}
            disabled={saving}
            onChange={(next) => void save(() => rpc.call("config.setProjectName", { name: row.key, on: next }))}
          />
        ))}
      </section>
      {problem && <p className="text-xs text-destructive">Could not save: {problem}</p>}
    </div>
  );
}
