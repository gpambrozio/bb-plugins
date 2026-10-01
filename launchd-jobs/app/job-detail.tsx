/**
 * One job: what launchd says about it, its recent runs, its log with Follow,
 * and the actions — Run now, Enable/Disable, Edit, Delete.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import type { Job, RunRecord } from "../shared/jobs";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { absoluteTime, duration, errorText, statusOf, type Tone } from "./format";
import { useJobLog } from "./log";

const TONE_CLASSES: Record<Tone, string> = {
  muted: "border-border text-muted-foreground",
  running: "border-success/50 text-success",
  danger: "border-destructive/50 text-destructive",
};

export function StatusPill({ job }: { job: Job }) {
  const status = statusOf(job);
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONE_CLASSES[status.tone])}>
      {status.label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm">{value}</span>
    </div>
  );
}

function RunLine({ run }: { run: RunRecord }) {
  return (
    <div className="flex items-baseline gap-3 text-sm tabular-nums">
      <span className="min-w-0 flex-1 truncate">{absoluteTime(run.startedAt)}</span>
      <span className="text-muted-foreground">{duration(run.durationMs)}</span>
      <span className={cn("w-16 text-right", run.exitCode === 0 ? "text-muted-foreground" : "text-destructive")}>exit {run.exitCode}</span>
    </div>
  );
}

function LogBox({ text, following }: { text: string; following: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  // While following, keep the newest line in view unless the user scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const element = box.current;
    if (element !== null && following && pinned.current) element.scrollTop = element.scrollHeight;
  }, [text, following]);
  return (
    <pre
      ref={box}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="max-h-96 min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed"
    >
      {text}
    </pre>
  );
}

export function JobDetail({
  hostId,
  job,
  compact,
  onBack,
  onEdit,
  onChanged,
  onDeleted,
}: {
  hostId: string;
  job: Job;
  compact: boolean;
  onBack(): void;
  onEdit(): void;
  onChanged(job: Job): void;
  onDeleted(): void;
}) {
  const rpc = useRpc<RpcContract>();
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showError = useCallback((message: string) => toast.error(message), []);
  const log = useJobLog(hostId, job, showError);

  useEffect(() => setConfirmDelete(false), [job.id]);

  const act = useCallback(async (work: () => Promise<void>, failure: string) => {
    setWorking(true);
    try {
      await work();
    } catch (error) {
      toast.error(`${failure}: ${errorText(error)}`);
    } finally {
      setWorking(false);
    }
  }, []);

  const enable = job.disabled || !job.loaded;
  const logText = log.log === null ? "" : log.log.text + log.log.pending;

  return (
    <div className="flex min-w-0 flex-col gap-5 p-4">
      <div className="flex items-center gap-2">
        {compact ? (
          <Button variant="ghost" size="icon" aria-label="Back to the list" onClick={onBack}>
            <Icon name="ArrowLeft" />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{job.name}</h2>
        <StatusPill job={job} />
      </div>

      {job.problem !== null ? <p className="text-sm text-destructive">{job.problem}</p> : null}
      {!job.managed && job.problem === null ? (
        <p className="text-sm text-muted-foreground">
          This plist was not written by the plugin. It is shown as launchd runs it; saving an edit rewrites it in the plugin's
          shape.
        </p>
      ) : null}
      {!job.loaded && !job.disabled && job.problem === null ? (
        <p className="text-sm text-destructive">
          launchd does not have this job loaded, so it will not run on its schedule — as happens when bb quits in the middle
          of changing a job. Enable loads it again, as does saving it.
        </p>
      ) : null}
      {job.readOnlyData ? (
        <p className="text-sm text-muted-foreground">
          Its log and history are in <span className="break-all font-mono text-xs">{job.dataDir}</span>, a folder this plugin
          only reads. Deleting the job leaves them there; saving an edit moves the job to the plugin's own folder.
        </p>
      ) : null}
      {job.adopted ? (
        <p className="text-sm text-muted-foreground">
          Made by the Paseo plugin. Its runner, log and history stay in <span className="break-all font-mono text-xs">{job.dataDir}</span>,
          and saving an edit keeps them there.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={working || !job.loaded}
          onClick={() =>
            void act(async () => {
              await rpc.call("run", { hostId, id: job.id });
              toast.success(`Asked launchd to start "${job.name}".`);
            }, "Could not start the job")
          }
        >
          <Icon name="Play" />
          Run now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={working}
          onClick={() =>
            void act(async () => {
              onChanged(await rpc.call("setEnabled", { hostId, id: job.id, enabled: enable }));
            }, "Could not change the job")
          }
        >
          {enable ? "Enable" : "Disable"}
        </Button>
        <Button size="sm" variant="outline" disabled={working} onClick={onEdit}>
          Edit
        </Button>
        {confirmDelete ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={working}
              onClick={() =>
                void act(async () => {
                  await rpc.call("delete", { hostId, id: job.id });
                  onDeleted();
                }, "Could not delete the job")
              }
            >
              Confirm delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="text-destructive" disabled={working} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
        {working ? <Icon name="Spinner" className="text-muted-foreground" /> : null}
      </div>

      <Section title="Schedule">
        <p className="text-sm">{job.schedule.description}</p>
        {job.schedule.type === "cron" ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{job.schedule.expression}</span> · {job.schedule.entries.length} launchd{" "}
            {job.schedule.entries.length === 1 ? "entry" : "entries"}
          </p>
        ) : null}
      </Section>

      <Section title="Command">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 font-mono text-xs">
          {job.command === "" ? "(none)" : job.command}
        </pre>
      </Section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
        <Fact label="Working directory" value={job.cwd ?? "Home directory"} />
        <Fact label="Runs since load" value={job.runs ?? "—"} />
        {job.pid !== null ? <Fact label="PID" value={job.pid} /> : null}
      </div>

      <Section title="Recent runs">
        {job.recentRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {job.recentRuns.map((run) => (
              <RunLine key={run.startedAt + run.finishedAt} run={run} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Log">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" aria-pressed={log.following} onClick={log.following ? log.stopFollowing : log.startFollowing}>
            <Icon name={log.following ? "Square" : "Eye"} />
            {log.following ? "Stop following" : "Follow"}
          </Button>
          {/* Hidden while following: the box is showing the live tail, so a
              button that repaints it from the file would only look broken. */}
          {log.following ? null : (
            <Button size="sm" variant="ghost" disabled={log.loading} onClick={log.refresh}>
              <Icon name={log.loading ? "Spinner" : "ArrowReloadHorizontal"} />
              Refresh log
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {log.following ? "Following live." : log.log?.truncated ? "Showing the last 64 KB." : null}
          </span>
        </div>
        <LogBox text={log.log === null ? "" : logText === "" ? "No output yet." : logText} following={log.following} />
        <p className="break-all font-mono text-xs text-muted-foreground">{job.logPath}</p>
        <p className="break-all font-mono text-xs text-muted-foreground">{job.plistPath}</p>
      </Section>
    </div>
  );
}
