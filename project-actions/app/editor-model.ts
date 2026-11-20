// The editor's draft, without React: actions as rows of fields, the file they make, and which field a
// problem in that file belongs to. The draft is checked by the same parser the menu and the server
// use, so the editor's messages are theirs.
import { parseActionsFile, serializeActionsFile, type ActionFields } from "../shared/actions-file";
import type { Problem } from "../shared/views";

export type Field = keyof ActionFields;

export interface Row extends ActionFields {
  /** Stable across moves, for React and for focus. */
  key: string;
  /** Edited since it was added: a new, untouched row shows no errors yet. */
  touched: boolean;
}

export type Mode = "form" | "json";

let nextKey = 0;
function newKey(): string {
  nextKey += 1;
  return `row-${nextKey}`;
}

export function blankRow(): Row {
  return { key: newKey(), name: "", command: "", cwd: "", description: "", touched: false };
}

/** The rows a file's text holds, or the problem that keeps it out of the form. */
export function rowsFromText(text: string): { ok: true; rows: Row[]; schema: string | null } | { ok: false; problem: Problem } {
  const parsed = parseActionsFile(text);
  if (!parsed.ok) return parsed;
  const rows = parsed.actions.map((action) => ({
    key: newKey(),
    name: action.name,
    command: action.command,
    cwd: action.cwd ?? "",
    description: action.description ?? "",
    touched: true,
  }));
  return { ok: true, rows, schema: parsed.schema };
}

export function textFromRows(rows: readonly Row[], schema: string | null): string {
  return serializeActionsFile(rows, schema);
}

/** Moves the row at `from` by `by` places, if it can move. */
export function moveRow(rows: readonly Row[], from: number, by: -1 | 1): Row[] {
  const to = from + by;
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Where a problem sits in the form: a field of a row, a whole row, or the file as a whole. */
export type ProblemPlace = { kind: "field"; row: number; field: Field } | { kind: "row"; row: number } | { kind: "file" };

const FIELDS = new Set<string>(["name", "command", "cwd", "description"]);

export function placeOf(problem: Problem): ProblemPlace {
  const match = /^actions\[(\d+)\](?:\.(\w+))?$/.exec(problem.path ?? "");
  if (match === null) return { kind: "file" };
  const row = Number(match[1]);
  const field = match[2];
  if (field !== undefined && FIELDS.has(field)) return { kind: "field", row, field: field as Field };
  return { kind: "row", row };
}
