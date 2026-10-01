/**
 * The prompt templates a card opens the send dialog with: one per column, and
 * per-project overrides. Rendered on the plugin's settings page and from the
 * board's own gear, so both doors edit the same stored templates.
 *
 * It edits a draft and saves on Save — a save per keystroke would store
 * half-typed templates. Blank means inherit, at both levels; the server
 * normalises on save, so clearing a field is how an override is dropped.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { COLUMN_IDS, type ColumnId, type PromptSet, type PromptSettings } from "../shared/board";
import { PLACEHOLDERS } from "../shared/settings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { errorText, usePrompts } from "./state";

const COLUMN_LABELS: Record<ColumnId, string> = {
  issues: "Issues",
  "draft-prs": "Draft PRs",
  "open-prs": "Open PRs",
  discussions: "Discussions",
};

function useProjects(): { id: string; name: string }[] {
  const sdk = useSdk();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    sdk.projects.list().then(
      (list) => {
        if (live) {
          setProjects(
            list
              .filter((project) => project.kind !== "personal")
              .map((project) => ({ id: project.id, name: project.name }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
      },
      () => {
        // Overrides already saved still show, by id.
      },
    );
    return () => {
      live = false;
    };
  }, [sdk]);
  return projects;
}

function TemplateField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange(value: string): void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Textarea
        value={value}
        placeholder={placeholder}
        rows={2}
        className="text-sm"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function PromptSettingsEditor() {
  const { prompts, error, save } = usePrompts();
  const projects = useProjects();
  const [draft, setDraft] = useState<PromptSettings | null>(null);
  const [saving, setSaving] = useState(false);
  // A pushed value is adopted only when it actually changed, and never over
  // an edit in progress.
  const adopted = useRef<string | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== adopted.current;
  // The draft as of the latest render, for a save to see edits made while it
  // was in flight; every edit replaces the object, so identity tells them apart.
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  useEffect(() => {
    if (prompts === null) return;
    const serialized = JSON.stringify(prompts);
    if (serialized === adopted.current) return;
    if (draft !== null && dirty) return;
    adopted.current = serialized;
    setDraft(prompts);
  }, [prompts, draft, dirty]);

  const projectName = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  if (error !== null) return <p className="text-sm text-destructive">{error}</p>;
  if (draft === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const setType = (column: ColumnId, value: string) =>
    setDraft({ ...draft, byType: { ...draft.byType, [column]: value } });
  const setOverride = (projectId: string, column: ColumnId, value: string) =>
    setDraft({
      ...draft,
      byProject: { ...draft.byProject, [projectId]: { ...draft.byProject[projectId], [column]: value } },
    });
  const removeOverride = (projectId: string) => {
    const { [projectId]: _removed, ...rest } = draft.byProject;
    setDraft({ ...draft, byProject: rest });
  };
  const available = projects.filter((project) => draft.byProject[project.id] === undefined);

  async function onSave() {
    if (draft === null) return;
    const sent = draft;
    setSaving(true);
    try {
      // The templates as they stand once the save landed: what was stored, or
      // a newer change another window pushed meanwhile, which must win.
      const current = await save(sent);
      adopted.current = JSON.stringify(current);
      // Edits typed while the save was in flight are kept, still unsaved
      // against the new baseline; only an untouched draft takes the result.
      if (latestDraft.current === sent) setDraft(current);
      toast.success("Prompt templates saved");
    } catch (cause) {
      toast.error(`Could not save: ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        What Send to chat opens with. Placeholders: {PLACEHOLDERS.join(", ")}. Clear a field to go back to the
        default.
      </p>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">By column</h3>
        {COLUMN_IDS.map((column) => (
          <TemplateField
            key={column}
            label={COLUMN_LABELS[column]}
            value={draft.byType[column]}
            onChange={(value) => setType(column, value)}
          />
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Per project</h3>
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={available.length === 0}>
                <Icon name="Plus" />
                Add project
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {available.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => setDraft({ ...draft, byProject: { ...draft.byProject, [project.id]: {} } })}
                >
                  {project.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {Object.keys(draft.byProject).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No overrides. A project's override replaces a column's template for cards sent to it.
          </p>
        ) : null}
        {Object.entries(draft.byProject).map(([projectId, overrides]: [string, Partial<PromptSet>]) => (
          <div key={projectId} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{projectName.get(projectId) ?? projectId}</span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => removeOverride(projectId)}>
                Remove
              </Button>
            </div>
            {COLUMN_IDS.map((column) => (
              <TemplateField
                key={column}
                label={COLUMN_LABELS[column]}
                value={overrides[column] ?? ""}
                placeholder={draft.byType[column]}
                onChange={(value) => setOverride(projectId, column, value)}
              />
            ))}
          </div>
        ))}
      </section>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            if (adopted.current !== null) setDraft(JSON.parse(adopted.current) as PromptSettings);
          }}
        >
          Revert
        </Button>
        <Button disabled={!dirty || saving} onClick={() => void onSave()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
