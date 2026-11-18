/**
 * The Dream page: the dream machine and the schedule at the top, then two views — the projects, each
 * with its switch, why it is or is not due and what can be done with it, and the history of dreams
 * with their summaries. The page only reads and asks; the server decides.
 */
import { Markdown, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { RpcContract } from "../shared/contract";
import type { Overview, RunRecord } from "../shared/contract-types";
import { FILTER_LABELS, matchesFilter, PROJECT_FILTERS, type ProjectFilter } from "../shared/filters";
import { changeText, when } from "../shared/format";
import type { ProjectStatus } from "../shared/types";
import { DanglingLinks } from "./dangling-links";
import { openPluginSettings } from "./open-settings";
import { ProposalView } from "./proposal-view";
import { errorText, useDream } from "./use-dream";

export const PANEL_PATH = "dream";

const SOURCE_TEXT: Record<ProjectStatus["memory"]["source"], string> = {
  env: "from CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  policySettings: "from managed settings",
  localSettings: "from .claude/settings.local.json",
  projectSettings: "from .claude/settings.json",
  userSettings: "from ~/.claude/settings.json",
  default: "Claude Code's default",
};

function openSettings(): void {
  if (!openPluginSettings(window)) toast.info("Dream's settings are in Settings → Plugins → Dream.");
}

function Pill({ tone, children }: { tone: "due" | "muted" | "warning" | "success" | "danger" | "running"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone === "due" && "border-foreground/40 text-foreground",
        tone === "muted" && "border-border text-muted-foreground",
        tone === "warning" && "border-warning text-warning-text",
        tone === "success" && "border-success text-success",
        tone === "danger" && "border-destructive text-destructive",
        tone === "running" && "border-foreground/40 text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function gatePill(status: ProjectStatus) {
  const { code } = status.gate;
  if (code === "due") return <Pill tone="due">Due</Pill>;
  if (code === "proposal-pending") return <Pill tone="warning">Proposal waiting</Pill>;
  if (code === "off") return <Pill tone="muted">Off</Pill>;
  if (code === "locked") return <Pill tone="running">Locked</Pill>;
  if (code === "no-memory" || code === "no-checkout" || code === "auto-memory-off") return <Pill tone="muted">Skipped</Pill>;
  if (code === "memory-busy" || code === "session-busy") return <Pill tone="muted">In use</Pill>;
  return <Pill tone="muted">Not due</Pill>;
}

function outcomePill(run: RunRecord) {
  switch (run.outcome) {
    case "running":
      return <Pill tone="running">Running</Pill>;
    case "changed":
      return <Pill tone="success">Changed</Pill>;
    case "proposed":
      return <Pill tone="warning">Proposed</Pill>;
    case "unchanged":
      return <Pill tone="muted">Nothing to change</Pill>;
    case "failed":
      return <Pill tone="danger">Failed</Pill>;
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function ProjectCard({ status, alwaysDryRun, busy, onChanged, onView }: { status: ProjectStatus; alwaysDryRun: boolean; busy: boolean; onChanged(): void; onView(): void }) {
  const rpc = useRpc<RpcContract>();
  const [working, setWorking] = useState(false);
  const { memory, gate } = status;

  async function act(label: string, work: () => Promise<string>) {
    setWorking(true);
    try {
      toast.success(await work());
      onChanged();
    } catch (error) {
      toast.error(`${label}: ${errorText(error)}`);
    } finally {
      setWorking(false);
    }
  }

  const run = (dryRun: boolean) =>
    act(dryRun ? "Dry run" : "Dream", async () => {
      const started = await rpc.call("run", { projectId: status.projectId, dryRun });
      return `Started a ${started.mode === "dry-run" ? "dry run" : "dream"} of ${started.projectName}.`;
    });

  const index = memory.indexLines === null ? "no MEMORY.md" : `MEMORY.md ${memory.indexLines} lines`;
  const sessionsSince = `${gate.sessionsSince} on ${gate.daysSince} ${gate.daysSince === 1 ? "day" : "days"}`;

  return (
    <li className="flex flex-col gap-3 border-b border-border px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <Checkbox
            checked={status.enabled}
            disabled={working}
            aria-label={`Include ${status.name} in the nightly dreams`}
            onCheckedChange={(checked) =>
              void act("Switch", async () => {
                await rpc.call("setSwitch", { projectId: status.projectId, enabled: checked === true });
                return checked === true ? `${status.name} is included in the nightly dreams.` : `${status.name} is left out of the nightly dreams.`;
              })
            }
          />
          <span className="truncate text-sm font-medium">{status.name}</span>
        </label>
        {gatePill(status)}
        {!status.inPlace || alwaysDryRun ? <Pill tone="muted">Next: dry run</Pill> : null}
      </div>
      <p className="text-sm text-muted-foreground">{gate.reason}</p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Fact label={`Memory, ${SOURCE_TEXT[memory.source]}`}>
          <span className="font-mono text-xs" title={memory.dir}>
            {memory.dir}
          </span>
        </Fact>
        <Fact label="Files">
          {memory.files} · {index}
        </Fact>
        <Fact label="Last dream">{when(gate.lastDreamAt)}</Fact>
        <Fact label={gate.lastDreamAt === null ? "Sessions (never dreamed: all count)" : "Sessions since last dream"}>{sessionsSince}</Fact>
        <Fact label="Transcripts">
          {status.sessions} sessions in {status.folders} {status.folders === 1 ? "folder" : "folders"}
        </Fact>
        <Fact label="Last backup">{status.lastBackup ?? "none"}</Fact>
      </dl>
      {memory.warnings.length > 0 ? (
        <ul className="space-y-1">
          {memory.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-xs text-warning-text">
              <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {status.pendingProposal ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning px-3 py-2">
          <span className="min-w-0 flex-1 text-sm">
            Dry run from {when(status.pendingProposal.createdAt)}: would{" "}
            {status.pendingProposal.changes ? changeText(status.pendingProposal.changes, true).toLowerCase() : "change nothing"}.{" "}
            <span className="font-mono text-xs text-muted-foreground">{status.pendingProposal.dir}</span>
          </span>
          <Button size="sm" variant="outline" onClick={onView}>
            View changes
          </Button>
          <Button
            size="sm"
            disabled={working || busy}
            onClick={() =>
              void act("Apply", async () => {
                const result = await rpc.call("apply", { projectId: status.projectId });
                return `Applied to ${status.name}: ${changeText(result.changes)}.`;
              })
            }
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={working || busy}
            onClick={() =>
              void act("Discard", async () => {
                await rpc.call("discard", { projectId: status.projectId });
                return `Discarded the dry run for ${status.name}.`;
              })
            }
          >
            Discard
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={working || busy || memory.files === 0 || status.pendingProposal !== null} onClick={() => void run(false)}>
          <Icon name="Play" />
          Dream now
        </Button>
        <Button size="sm" variant="ghost" disabled={working || busy || memory.files === 0 || status.pendingProposal !== null} onClick={() => void run(true)}>
          Dry run
        </Button>
      </div>
    </li>
  );
}

function RunRow({ run }: { run: RunRecord }) {
  const [open, setOpen] = useState(false);
  const navigate = useBbNavigate();
  return (
    <li className="border-b border-border px-4 py-3">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{run.projectName}</span>
        {outcomePill(run)}
        <span className="text-xs text-muted-foreground">
          {when(run.startedAt)} · {run.mode === "dry-run" ? "dry run" : "dream"} · {run.trigger === "schedule" ? "scheduled" : "by hand"}
        </span>
        {run.changes ? <span className="text-xs text-muted-foreground">· {changeText(run.changes)}</span> : null}
      </button>
      {open ? (
        <div className="mt-3 space-y-3 pl-6">
          {run.error ? <p className="text-sm text-destructive">{run.error}</p> : null}
          <DanglingLinks links={run.danglingLinks} />
          {run.summary ? <Markdown content={run.summary} className="text-sm" /> : <p className="text-sm text-muted-foreground">No summary.</p>}
          {run.changes ? (
            <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
              {run.changes.changed.map((file) => (
                <li key={`c-${file}`}>~ {file}</li>
              ))}
              {run.changes.added.map((file) => (
                <li key={`a-${file}`}>+ {file}</li>
              ))}
              {run.changes.deleted.map((file) => (
                <li key={`d-${file}`}>− {file}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {run.backup ? `Backup ${run.backup}. ` : ""}
            {run.proposal ? `Dry run ${run.proposal}. ` : ""}
          </p>
          {run.threadId ? (
            <Button size="sm" variant="outline" onClick={() => navigate.toThread(run.threadId as string)}>
              Open the dream's thread
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The "Always dry run" setting, said where the schedule is. */
function dryRunText(alwaysDryRun: boolean): string {
  return alwaysDryRun
    ? " Always dry run is on: every dream is a dry run that waits for you to apply or discard it."
    : " A project's first dream is a dry run; once one is applied, its dreams edit memory in place.";
}

function ScheduleLine({ overview }: { overview: Overview }) {
  const { schedule } = overview;
  if (!schedule.enabled) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
        <span className="min-w-0 flex-1">
          The schedule is off: nothing dreams on its own until you turn it on in Dream's settings.
          {dryRunText(overview.alwaysDryRun)}
        </span>
        <Button size="sm" variant="outline" onClick={openSettings}>
          Settings
        </Button>
      </div>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Dreams every night from {schedule.windowStart} to {schedule.windowEnd}
      {schedule.inWindow ? ", window open now" : schedule.nextChange ? `, next window ${when(schedule.nextChange)}` : ""}.
      {schedule.lastSweepAt ? ` Last checked ${when(schedule.lastSweepAt)}.` : ""}
      {dryRunText(overview.alwaysDryRun)}
    </p>
  );
}

function ActiveBanner({ run, onChanged }: { run: RunRecord; onChanged(): void }) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-foreground/30 px-3 py-2 text-sm">
      <Icon name="Spinner" className="size-4 animate-spin" />
      <span className="min-w-0 flex-1">
        {run.mode === "dry-run" ? "Dry run" : "Dreaming"}: {run.projectName}, since {when(run.startedAt)}.
      </span>
      {run.threadId ? (
        <Button size="sm" variant="ghost" onClick={() => navigate.toThread(run.threadId as string)}>
          Open thread
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void rpc
            .call("stop", {})
            .then(() => {
              toast.success("Stopping the dream; its lock is rolled back.");
              onChanged();
            })
            .catch((error: unknown) => toast.error(`Stop: ${errorText(error)}`))
        }
      >
        Stop
      </Button>
    </div>
  );
}

export function DreamPage(_props: PluginNavPanelProps) {
  const { overview, runs, loading, error, refresh } = useDream();
  const [view, setView] = useState<"projects" | "history">("projects");
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [viewing, setViewing] = useState<{ projectId: string; name: string } | null>(null);
  const shown = overview ? overview.projects.filter((status) => matchesFilter(status, filter)) : [];
  const busy = overview?.active !== null && overview?.active !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <Icon name="Brain" className="size-5" />
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
            Dream
            {overview?.host ? <span className="font-normal text-muted-foreground"> · {overview.host.name}{overview.host.connected ? "" : " (offline)"}</span> : null}
          </h1>
          <Button size="icon" variant="ghost" aria-label="Refresh" onClick={refresh}>
            <Icon name="ArrowReloadHorizontal" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Settings" onClick={openSettings}>
            <Icon name="Settings" />
          </Button>
        </div>
        {overview ? <ScheduleLine overview={overview} /> : null}
        {overview?.active ? <ActiveBanner run={overview.active} onChanged={refresh} /> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {overview?.error ? <p className="text-sm text-destructive">{overview.error}</p> : null}
        <div className="flex gap-1" role="tablist">
          <Button size="sm" variant="ghost" role="tab" aria-selected={view === "projects"} aria-pressed={view === "projects"} onClick={() => setView("projects")}>
            Projects{overview ? ` (${overview.projects.length})` : ""}
          </Button>
          <Button size="sm" variant="ghost" role="tab" aria-selected={view === "history"} aria-pressed={view === "history"} onClick={() => setView("history")}>
            History{runs.length > 0 ? ` (${runs.length})` : ""}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && overview === null ? <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p> : null}
        {view === "projects" && overview && viewing ? (
          <ProposalView projectId={viewing.projectId} projectName={viewing.name} busy={busy} onClose={() => setViewing(null)} onChanged={refresh} />
        ) : null}
        {view === "projects" && overview && !viewing ? (
          overview.projects.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1 border-b border-border px-4 py-2" role="group" aria-label="Filter projects">
                {PROJECT_FILTERS.map((option) => (
                  <Button key={option} size="sm" variant="ghost" aria-pressed={filter === option} onClick={() => setFilter(option)}>
                    {FILTER_LABELS[option]} ({overview.projects.filter((status) => matchesFilter(status, option)).length})
                  </Button>
                ))}
              </div>
              {shown.length > 0 ? (
                <ul>
                  {shown.map((status) => (
                    <ProjectCard
                      key={status.projectId}
                      status={status}
                      alwaysDryRun={overview.alwaysDryRun}
                      busy={busy}
                      onChanged={refresh}
                      onView={() => setViewing({ projectId: status.projectId, name: status.name })}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-sm text-muted-foreground">No project matches {FILTER_LABELS[filter].toLowerCase()}.</p>
              )}
            </>
          ) : (
            <p className="px-4 py-6 text-sm text-muted-foreground">No bb project has a checkout on the dream machine.</p>
          )
        ) : null}
        {view === "history" ? (
          runs.length > 0 ? (
            <ul>
              {runs.map((run) => (
                <RunRow key={run.runId} run={run} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-muted-foreground">No dreams yet. Each dream's summary appears here.</p>
          )
        ) : null}
      </div>
    </div>
  );
}
