/**
 * The create and edit form. The schedule is previewed in words as it is
 * typed, with the number of launchd entries a cron expression becomes.
 */
import { useCallback, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import type { RpcContract } from "../shared/contract";
import type { Job } from "../shared/jobs";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { draftFrom, errorText, schedulePreview, specFrom, type Draft, type IntervalUnit } from "./format";

/**
 * A half-typed form survives the panel unmounting — navigating to a thread and
 * back — keyed by what it was editing, so a draft for one job is never
 * adopted by another. Leaving by either button forgets it.
 */
let cachedDraft: { key: string; draft: Draft } | null = null;

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function Choice({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Button type="button" size="sm" variant={on ? "secondary" : "ghost"} aria-pressed={on} onClick={onClick}>
      {children}
    </Button>
  );
}

export function JobForm({
  hostId,
  job,
  compact,
  onCancel,
  onSaved,
}: {
  hostId: string;
  job: Job | null;
  compact: boolean;
  onCancel(): void;
  onSaved(job: Job): void;
}) {
  const rpc = useRpc<RpcContract>();
  const draftKey = `${hostId}/${job === null ? "new" : `edit-${job.id}`}`;
  const [draft, setDraft] = useState<Draft>(() => (cachedDraft?.key === draftKey ? cachedDraft.draft : draftFrom(job)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    (change: Partial<Draft>) =>
      setDraft((current) => {
        const next = { ...current, ...change };
        cachedDraft = { key: draftKey, draft: next };
        return next;
      }),
    [draftKey],
  );

  const cancel = useCallback(() => {
    cachedDraft = null;
    onCancel();
  }, [onCancel]);

  const preview = useMemo(() => schedulePreview(draft), [draft]);

  const save = useCallback(async () => {
    const result = specFrom(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved =
        job === null
          ? await rpc.call("create", { hostId, spec: result.spec })
          : await rpc.call("update", { hostId, id: job.id, spec: result.spec });
      cachedDraft = null;
      onSaved(saved);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }, [draft, job, rpc, hostId, onSaved]);

  return (
    <form
      className="flex min-w-0 flex-col gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        {compact ? (
          <Button type="button" variant="ghost" size="icon" aria-label="Cancel" onClick={cancel}>
            <Icon name="ArrowLeft" />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{job === null ? "New job" : `Edit ${job.name}`}</h2>
      </div>

      {job?.adopted ? (
        <p className="text-sm text-muted-foreground">Saving keeps this job's log and history where the Paseo plugin put them.</p>
      ) : null}

      <Field label="Name" htmlFor="launchd-job-name">
        <Input id="launchd-job-name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="Nightly backup" />
      </Field>

      <Field label="Command — run by /bin/zsh -lc, with your login shell's PATH" htmlFor="launchd-job-command">
        <Textarea
          id="launchd-job-command"
          className="min-h-20 font-mono text-xs"
          value={draft.command}
          onChange={(event) => patch({ command: event.target.value })}
          placeholder="rsync -a ~/Documents /Volumes/Backup/"
          spellCheck={false}
        />
      </Field>

      <Field label="Working directory — optional, absolute or ~/…" htmlFor="launchd-job-cwd">
        <Input id="launchd-job-cwd" value={draft.cwd} onChange={(event) => patch({ cwd: event.target.value })} placeholder="~/projects/site" spellCheck={false} />
      </Field>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Schedule</span>
        <div className="flex flex-wrap gap-1">
          <Choice on={draft.mode === "cron"} onClick={() => patch({ mode: "cron" })}>
            Cron expression
          </Choice>
          <Choice on={draft.mode === "interval"} onClick={() => patch({ mode: "interval" })}>
            Fixed interval
          </Choice>
        </div>
        {draft.mode === "cron" ? (
          <Input
            aria-label="Cron expression"
            className="font-mono"
            value={draft.expression}
            onChange={(event) => patch({ expression: event.target.value })}
            placeholder="minute hour day month weekday"
            spellCheck={false}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Every</span>
            <Input
              aria-label="Interval"
              className="w-24"
              inputMode="decimal"
              value={draft.every}
              onChange={(event) => patch({ every: event.target.value })}
            />
            {(["seconds", "minutes", "hours"] as const satisfies readonly IntervalUnit[]).map((unit) => (
              <Choice key={unit} on={draft.unit === unit} onClick={() => patch({ unit })}>
                {unit}
              </Choice>
            ))}
          </div>
        )}
        <p className={cn("text-sm", preview.ok ? "text-muted-foreground" : "text-destructive")}>{preview.text}</p>
      </div>

      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : job === null ? "Create job" : "Save changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
