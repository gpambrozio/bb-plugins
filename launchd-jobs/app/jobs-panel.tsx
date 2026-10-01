/**
 * The Scheduled jobs page: the jobs of one Mac in a list on the left, and on
 * the right whichever of three things is open — a job's detail, the form
 * editing it, or the form for a new one. A compact viewport shows one pane at
 * a time. With more than one Mac connected, a picker chooses whose jobs these
 * are; it opens on the Mac running the bb server.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { HostChoice } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import type { Job } from "../shared/jobs";
import { Button } from "@/components/ui/button";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { duration, errorText, relativeTime } from "./format";
import { useReconnects } from "./health";
import { JobDetail, StatusPill } from "./job-detail";
import { JobForm } from "./job-form";

export const PANEL_PATH = "jobs";

/** How often the list re-asks launchd while the page is on screen. */
const REFRESH_MS = 15_000;
const HOST_KEY = "launchd-jobs:host";

type Pane = { kind: "empty" } | { kind: "view"; id: string } | { kind: "edit"; id: string } | { kind: "new" };

/**
 * The page unmounts whenever the user opens a thread, so what it showed is
 * kept here: the list paints before the first load answers, and the open pane
 * comes back.
 */
const cachedJobs = new Map<string, Job[]>();
let cachedPane: Pane = { kind: "empty" };
let cachedHosts: { primaryHostId: string | null; hosts: HostChoice[] } | null = null;

function storedHost(): string | null {
  try {
    return window.localStorage.getItem(HOST_KEY);
  } catch {
    return null;
  }
}

function storeHost(hostId: string): void {
  try {
    window.localStorage.setItem(HOST_KEY, hostId);
  } catch {
    // A private window: the picker simply starts on the server's Mac next time.
  }
}

function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect(): void }) {
  const last = job.recentRuns[0];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left hover:bg-state-hover",
        selected && "bg-state-active",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{job.name}</span>
        <StatusPill job={job} />
      </span>
      <span className="truncate text-xs text-muted-foreground">{job.schedule.description}</span>
      {last !== undefined ? (
        <span className="truncate text-xs text-muted-foreground">
          Last run {relativeTime(last.finishedAt)} · {duration(last.durationMs)}
        </span>
      ) : null}
    </button>
  );
}

function Centered({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      {title !== undefined ? <h2 className="text-base font-semibold">{title}</h2> : null}
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function useHosts() {
  const rpc = useRpc<RpcContract>();
  const reconnects = useReconnects();
  const [hosts, setHosts] = useState(cachedHosts);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc
      .call("hosts", {})
      .then((value) => {
        cachedHosts = value;
        if (live) {
          setHosts(value);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (live) setError(errorText(caught));
      });
    return () => {
      live = false;
    };
  }, [rpc, reconnects]);
  return { hosts, error };
}

export function JobsPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<RpcContract>();
  const compact = useIsCompactViewport();
  const reconnects = useReconnects();
  const { hosts, error: hostsError } = useHosts();

  const [chosenHost, setChosenHost] = useState<string | null>(storedHost);
  const hostIds = hosts?.hosts.map((host) => host.id) ?? [];
  const hostId =
    chosenHost !== null && hostIds.includes(chosenHost)
      ? chosenHost
      : hosts?.primaryHostId !== null && hosts?.primaryHostId !== undefined && hostIds.includes(hosts.primaryHostId)
        ? hosts.primaryHostId
        : (hostIds[0] ?? null);

  const [jobs, setJobs] = useState<Job[] | null>(hostId === null ? null : (cachedJobs.get(hostId) ?? null));
  const [supported, setSupported] = useState(true);
  const [launchAgentsDir, setLaunchAgentsDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pane, setPaneState] = useState<Pane>(cachedPane);
  const setPane = useCallback((next: Pane) => {
    cachedPane = next;
    setPaneState(next);
  }, []);

  const setHostJobs = useCallback(
    (update: (current: Job[]) => Job[]) => {
      if (hostId === null) return;
      setJobs((current) => {
        const next = update(current ?? []);
        cachedJobs.set(hostId, next);
        return next;
      });
    },
    [hostId],
  );

  /** Bumped per host switch, so a list that answers for the previous Mac is dropped. */
  const listGeneration = useRef(0);
  const refresh = useCallback(
    async (quiet: boolean) => {
      if (hostId === null) return;
      const mine = listGeneration.current;
      if (!quiet) setBusy(true);
      try {
        const next = await rpc.call("list", { hostId });
        if (mine !== listGeneration.current) return;
        cachedJobs.set(hostId, next.jobs);
        setJobs(next.jobs);
        setSupported(next.supported);
        setLaunchAgentsDir(next.launchAgentsDir);
        setError(null);
      } catch (caught) {
        if (mine === listGeneration.current) setError(errorText(caught));
      } finally {
        if (!quiet && mine === listGeneration.current) setBusy(false);
      }
    },
    [rpc, hostId],
  );

  useEffect(() => {
    listGeneration.current += 1;
    setJobs(hostId === null ? null : (cachedJobs.get(hostId) ?? null));
    setSupported(true);
    setError(null);
    setBusy(false);
  }, [hostId]);

  useEffect(() => {
    void refresh(false);
    // While a form is open the list still refreshes underneath, which is
    // harmless: the form owns its own draft.
    const timer = setInterval(() => void refresh(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, reconnects]);

  const replaceJob = useCallback(
    (job: Job) => setHostJobs((current) => [...current.filter((entry) => entry.id !== job.id), job].sort((a, b) => a.id.localeCompare(b.id))),
    [setHostJobs],
  );

  const selectedId = pane.kind === "view" || pane.kind === "edit" ? pane.id : null;
  const selected = selectedId === null ? null : ((jobs ?? []).find((job) => job.id === selectedId) ?? null);

  // A job deleted elsewhere, or a switch to another Mac, must not strand the pane.
  useEffect(() => {
    if (selectedId !== null && jobs !== null && selected === null) setPane({ kind: "empty" });
  }, [selectedId, selected, jobs, setPane]);

  /**
   * Opening a failing job is what acknowledges its failure: the sidebar stops
   * counting it until the job fails again, because what is remembered is the
   * run, not the job. Keyed on the run rather than on the job, so a failure
   * that lands while the detail is already open is acknowledged too — the
   * user is looking straight at it.
   */
  const lastRunStartedAt = selected?.recentRuns[0]?.startedAt ?? null;
  const lastRunExitCode = selected?.recentRuns[0]?.exitCode ?? null;
  useEffect(() => {
    if (pane.kind !== "view" || selectedId === null || hostId === null) return;
    if (lastRunStartedAt === null || lastRunExitCode === null || lastRunExitCode === 0) return;
    rpc.call("acknowledge", { hostId, id: selectedId }).catch((caught: unknown) => {
      // Nothing the user asked for failed; the count stands until the next look.
      console.warn(`[launchd-jobs] could not acknowledge ${selectedId}: ${errorText(caught)}`);
    });
  }, [rpc, hostId, pane.kind, selectedId, lastRunStartedAt, lastRunExitCode]);

  const hostPicker =
    hosts !== null && hosts.hosts.length > 1 && hostId !== null ? (
      <label className="flex min-w-0 items-center gap-1.5 text-sm">
        <Icon name="Laptop" className="shrink-0 text-muted-foreground" />
        <span className="sr-only">Mac</span>
        <select
          className="min-w-0 max-w-48 truncate rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={hostId}
          onChange={(event) => {
            const next = event.target.value;
            storeHost(next);
            setChosenHost(next);
            setPane({ kind: "empty" });
          }}
        >
          {hosts.hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
              {host.id === hosts.primaryHostId ? " (bb server)" : ""}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  const toolbar = (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      {hostPicker}
      <div className="flex-1" />
      <Button variant="ghost" size="icon" aria-label={busy ? "Loading" : "Refresh"} disabled={busy || hostId === null} onClick={() => void refresh(false)}>
        <Icon name={busy ? "Spinner" : "ArrowReloadHorizontal"} />
      </Button>
      <Button size="sm" disabled={hostId === null || !supported} onClick={() => setPane({ kind: "new" })}>
        <Icon name="Plus" />
        New job
      </Button>
    </div>
  );

  if (hostId === null) {
    return (
      <div className="flex h-full flex-col">
        <Centered title="No Mac to show">
          {hostsError ?? (hosts === null ? "Looking for your Macs…" : "None of your Macs is connected to bb right now.")}
        </Centered>
      </div>
    );
  }

  if (!supported) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <Centered title="macOS only">
          This plugin manages launchd agents, and the machine you picked is not running macOS.
        </Centered>
      </div>
    );
  }

  let paneView: React.ReactNode = null;
  if (pane.kind === "new") {
    paneView = (
      <JobForm
        key={`${hostId}/new`}
        hostId={hostId}
        job={null}
        compact={compact}
        onCancel={() => setPane({ kind: "empty" })}
        onSaved={(job) => {
          replaceJob(job);
          setPane({ kind: "view", id: job.id });
          toast.success(`Created "${job.name}" and loaded it into launchd.`);
        }}
      />
    );
  } else if (pane.kind === "edit" && selected !== null) {
    paneView = (
      <JobForm
        key={`${hostId}/edit-${selected.id}`}
        hostId={hostId}
        job={selected}
        compact={compact}
        onCancel={() => setPane({ kind: "view", id: selected.id })}
        onSaved={(job) => {
          replaceJob(job);
          setPane({ kind: "view", id: job.id });
          toast.success(`Saved "${job.name}" and reloaded it in launchd.`);
        }}
      />
    );
  } else if (pane.kind === "view" && selected !== null) {
    paneView = (
      <JobDetail
        key={`${hostId}/${selected.id}`}
        hostId={hostId}
        job={selected}
        compact={compact}
        onBack={() => setPane({ kind: "empty" })}
        onEdit={() => setPane({ kind: "edit", id: selected.id })}
        onChanged={replaceJob}
        onDeleted={() => {
          setHostJobs((current) => current.filter((entry) => entry.id !== selected.id));
          setPane({ kind: "empty" });
          toast.success(`Deleted "${selected.name}".`);
        }}
      />
    );
  } else if (!compact) {
    paneView = <Centered>Select a job, or create one.</Centered>;
  }

  const showList = !compact || pane.kind === "empty";
  const showPane = !compact || pane.kind !== "empty";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {error !== null ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {showList ? (
          <div className={cn("min-h-0 overflow-y-auto", compact ? "flex-1" : "w-80 shrink-0 border-r border-border")}>
            {jobs === null ? (
              busy ? <Centered>Loading…</Centered> : null
            ) : jobs.length === 0 ? (
              <Centered>
                No jobs yet. Anything created here becomes a LaunchAgent
                {launchAgentsDir === null ? "" : ` in ${launchAgentsDir}`}, and runs whether or not bb is open.
              </Centered>
            ) : (
              jobs.map((job) => (
                <JobRow key={job.id} job={job} selected={job.id === selectedId} onSelect={() => setPane({ kind: "view", id: job.id })} />
              ))
            )}
          </div>
        ) : null}
        {showPane ? <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{paneView}</div> : null}
      </div>
    </div>
  );
}
