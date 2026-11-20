// The Edit actions tab beside a thread: the thread's own copy of `.bb/actions.json`, as a form of
// actions or as JSON, checked as the menu checks it and saved back into the workspace, on the machine
// that holds it, only over the file it opened.
import { useBbNavigate, useRpc, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { parseActionsFile } from "../shared/actions-file";
import type { RpcContract } from "../shared/contract";
import { ACTIONS_FILE, describeLocation, FORMAT_URL, type Problem } from "../shared/views";
import { blankRow, moveRow, placeOf, rowsFromText, textFromRows, type Field, type Mode, type Row } from "./editor-model";

type Loaded =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  /** `original` is the file as read (null: none yet); `sha256` what a save must still find on disk. */
  | { kind: "ready"; original: string | null; sha256: string | null; branch: string | null };

type Notice = { kind: "saved" } | { kind: "conflict" } | { kind: "error"; message: string } | null;

const FIELD_LABELS: Record<Field, string> = { name: "Name", command: "Command", cwd: "Folder", description: "Description" };
const FIELD_HINTS: Record<Field, string> = {
  name: "Dev server",
  command: "npm run dev",
  cwd: "The project's root",
  description: "Shown under the name in the menu",
};
/** The order fields are laid out in: name and folder side by side, then the longer two. */
const FIELDS: Field[] = ["name", "cwd", "command", "description"];
const WIDE: ReadonlySet<Field> = new Set(["command", "description"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Banner({ tone, children }: { tone: "info" | "success" | "warning" | "error"; children: ReactNode }) {
  const tones = {
    info: "border-border bg-card text-muted-foreground",
    success: "border-border bg-card text-success",
    warning: "border-warning text-warning-text",
    error: "border-destructive text-destructive",
  } as const;
  return (
    <div role={tone === "error" || tone === "warning" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

function RowEditor({
  row,
  index,
  count,
  problem,
  onChange,
  onMove,
  onDelete,
  autoFocus,
}: {
  row: Row;
  index: number;
  count: number;
  problem: { field: Field | null; message: string } | null;
  onChange: (field: Field, value: string) => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
  autoFocus: boolean;
}) {
  const title = row.name.trim() === "" ? `Action ${index + 1}` : row.name.trim();
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" aria-label={title}>
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Move ${title} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <Icon name="ArrowUp" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Move ${title} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <Icon name="ArrowDown" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Delete ${title}`} onClick={onDelete}>
          <Icon name="Trash2" />
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const id = `${row.key}-${field}`;
          const error = problem !== null && problem.field === field ? problem.message : null;
          return (
            <div key={field} className={`flex flex-col gap-1${WIDE.has(field) ? " sm:col-span-2" : ""}`}>
              <label htmlFor={id} className="text-xs text-muted-foreground">
                {FIELD_LABELS[field]}
                {field === "name" || field === "command" ? "" : " (optional)"}
              </label>
              <Input
                id={id}
                value={row[field]}
                placeholder={FIELD_HINTS[field]}
                autoFocus={autoFocus && field === "name"}
                aria-invalid={error !== null}
                // Hints read as hints, not values: faint, and never in the code font.
                className={`placeholder:font-sans placeholder:text-muted-foreground/60${field === "command" || field === "cwd" ? " font-mono" : ""}`}
                onChange={(event) => onChange(field, event.target.value)}
              />
              {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
            </div>
          );
        })}
      </div>
      {problem !== null && problem.field === null ? <span className="text-xs text-destructive">{problem.message}</span> : null}
    </li>
  );
}

/** The problem a row shows: only once the row has been touched, so a new blank row starts clean. */
function rowProblem(problem: Problem | null, rows: readonly Row[], index: number): { field: Field | null; message: string } | null {
  if (problem === null || !rows[index]?.touched) return null;
  const place = placeOf(problem);
  if (place.kind === "field" && place.row === index) return { field: place.field, message: problem.message };
  if (place.kind === "row" && place.row === index) return { field: null, message: problem.message };
  return null;
}

export function ActionsEditor({ threadId }: { threadId: string }) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("form");
  const [rows, setRows] = useState<Row[]>([]);
  const [schema, setSchema] = useState<string | null>(null);
  const [json, setJson] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    setLoaded({ kind: "loading" });
    setNotice(null);
    rpc.call("read", { threadId }).then(
      (file) => {
        if (generation.current !== mine) return;
        if (file.state === "unavailable") {
          setLoaded({ kind: "unavailable", message: file.message });
          return;
        }
        setLoaded({ kind: "ready", original: file.text, sha256: file.sha256, branch: file.branch });
        if (file.text === null) {
          // No file yet: start with one action to fill in.
          const first = blankRow();
          setRows([first]);
          setSchema(null);
          setJson("");
          setMode("form");
          setFocusKey(first.key);
          return;
        }
        const parsed = rowsFromText(file.text);
        setJson(file.text);
        setFocusKey(null);
        if (parsed.ok) {
          setRows(parsed.rows);
          setSchema(parsed.schema);
          setMode("form");
        } else {
          // A file the form cannot hold opens as JSON, to be fixed there.
          setRows([]);
          setSchema(null);
          setMode("json");
        }
      },
      (error: unknown) => {
        if (generation.current === mine) setLoaded({ kind: "unavailable", message: message(error) });
      },
    );
  }, [rpc, threadId]);

  useEffect(() => load(), [load]);

  const draft = mode === "form" ? textFromRows(rows, schema) : json;
  const parsed = useMemo(() => parseActionsFile(draft), [draft]);
  const problem = parsed.ok ? null : parsed.problem;

  const original = loaded.kind === "ready" ? loaded.original : null;
  // What the draft is compared with: the file as the form would write it, or as it is on disk.
  const baseline = useMemo(() => {
    if (original === null) return null;
    if (mode === "json") return original;
    const fromOriginal = rowsFromText(original);
    return fromOriginal.ok ? textFromRows(fromOriginal.rows, fromOriginal.schema) : original;
  }, [mode, original]);
  const dirty = draft !== baseline;

  const edit = (index: number, field: Field, value: string) => {
    setNotice(null);
    setRows((current) => current.map((row, at) => (at === index ? { ...row, [field]: value, touched: true } : row)));
  };

  const add = () => {
    const row = blankRow();
    setNotice(null);
    setRows((current) => [...current, row]);
    setFocusKey(row.key);
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "json") {
      setJson(textFromRows(rows, schema));
      setMode("json");
      return;
    }
    const fromJson = rowsFromText(json);
    if (!fromJson.ok) return;
    setRows(fromJson.rows);
    setSchema(fromJson.schema);
    setMode("form");
  };

  const save = async () => {
    if (loaded.kind !== "ready" || problem !== null || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await rpc.call("save", { threadId, text: draft, expectedSha256: loaded.sha256 });
      if (result.outcome === "conflict") {
        setNotice({ kind: "conflict" });
        return;
      }
      setLoaded({ ...loaded, original: draft, sha256: result.sha256 });
      setJson(draft);
      setRows((current) => current.map((row) => ({ ...row, touched: true })));
      setNotice({ kind: "saved" });
    } catch (error) {
      setNotice({ kind: "error", message: message(error) });
    } finally {
      setSaving(false);
    }
  };

  if (loaded.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
        <Icon name="Spinner" className="animate-spin" />
        Reading {ACTIONS_FILE}…
      </div>
    );
  }
  if (loaded.kind === "unavailable") {
    return (
      <div className="flex flex-col gap-3 p-3">
        <Banner tone="error">{loaded.message}</Banner>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const where = loaded.branch === null ? "this thread's workspace" : `this thread's workspace, on ${loaded.branch}`;
  const jsonBlocksForm = mode === "json" && !rowsFromText(json).ok;
  // A problem shows on its row in the form, else below the file. One in a new row nobody has touched
  // yet is not shown there; a line says what blocks the save instead.
  const shownOnRow = mode === "form" && rows.some((_, index) => rowProblem(problem, rows, index) !== null);
  const fileProblem = problem !== null && !shownOnRow && (mode === "json" || placeOf(problem).kind === "file") ? problem : null;
  const hiddenProblem = problem !== null && !shownOnRow && fileProblem === null;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Edit actions</h2>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{ACTIONS_FILE}</span> in {where}. Saving changes the file here only: commit it to share it with
          other branches. Actions already running keep running; the menu shows the new list the next time it opens.
        </p>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="View">
        {(["form", "json"] as const).map((view) => (
          <Button
            key={view}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={mode === view}
            disabled={view === "form" && jsonBlocksForm}
            onClick={() => switchMode(view)}
          >
            {view === "form" ? "Form" : "JSON"}
          </Button>
        ))}
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={() => navigate.openUrl(FORMAT_URL)}>
          <Icon name="ExternalLink" />
          Format
        </Button>
      </div>

      {original === null && notice === null ? <Banner tone="info">This workspace has no actions file yet. Saving creates it.</Banner> : null}
      {jsonBlocksForm ? <Banner tone="info">Fix the JSON to edit it as a form.</Banner> : null}

      {mode === "form" ? (
        <>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">No actions. Add one with a name and a command.</p> : null}
          <ul className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <RowEditor
                key={row.key}
                row={row}
                index={index}
                count={rows.length}
                problem={rowProblem(problem, rows, index)}
                autoFocus={row.key === focusKey}
                onChange={(field, value) => edit(index, field, value)}
                onMove={(by) => {
                  setNotice(null);
                  setRows((current) => moveRow(current, index, by));
                }}
                onDelete={() => {
                  setNotice(null);
                  setRows((current) => current.filter((candidate) => candidate.key !== row.key));
                }}
              />
            ))}
          </ul>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={add}>
              <Icon name="Plus" />
              Add action
            </Button>
          </div>
        </>
      ) : (
        <Textarea
          aria-label={ACTIONS_FILE}
          value={json}
          spellCheck={false}
          rows={18}
          aria-invalid={problem !== null}
          className="font-mono text-xs"
          onChange={(event) => {
            setNotice(null);
            setJson(event.target.value);
          }}
        />
      )}

      {fileProblem !== null ? (
        <Banner tone="error">
          <p>{fileProblem.message}</p>
          <p className="mt-1 font-mono text-xs">{describeLocation(fileProblem)}</p>
        </Banner>
      ) : null}
      {hiddenProblem ? <Banner tone="info">Fill in each new action's name and command to save.</Banner> : null}

      {notice?.kind === "saved" ? <Banner tone="success">Saved in this worktree. Commit {ACTIONS_FILE} to share it with other branches.</Banner> : null}
      {notice?.kind === "conflict" ? (
        <Banner tone="warning">
          <p>The actions file changed on disk since you opened it, so it was not saved. Reload it to see the change; your edits here will be lost.</p>
          <div className="mt-2">
            <Button type="button" variant="outline" size="sm" onClick={load}>
              Reload
            </Button>
          </div>
        </Banner>
      ) : null}
      {notice?.kind === "error" ? <Banner tone="error">{notice.message}</Banner> : null}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!dirty || problem !== null || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!dirty || saving} onClick={load}>
          Discard changes
        </Button>
      </div>
    </div>
  );
}

export function EditorTab({ threadId }: ExperimentalThreadTabProps) {
  return <ActionsEditor threadId={threadId} />;
}
