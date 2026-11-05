/**
 * Answer forms: the controls an agent can lay out under a question, so a question with several parts,
 * a comparison or a ranking is answered in the shape it asks for, not in one text box.
 *
 * A form is a flat list of items. A `section` item starts a group with a heading; a field's `width`
 * (`full`, `half`, `third`) lets neighbours share a line, and the card stacks them again when it is
 * narrow. Every text an agent writes here is untrusted: labels and option names are drawn as plain
 * text, `help` and `note` as bb's Markdown (no raw HTML), and nothing is ever run.
 *
 * The answer comes back as `FormValues`, keyed by field id, plus a readable summary of it
 * (`summarizeAnswer`). The server re-reads what a card sent against the form it asked with
 * (`sanitizeValues`): a value of the wrong shape becomes "no answer", a number is clamped, a text cut.
 *
 * Plain zod, no SDK import: the app imports this at run time (see `types.ts`).
 */
import { z } from "zod";

/** The most a form may hold; checked when it is asked, so a card never has to cope with more. */
export const FORM_LIMITS = {
  items: 30,
  fields: 24,
  options: 20,
  ranked: 12,
  matched: 12,
  listEntries: 12,
  tableRows: 12,
  tableColumns: 6,
  tableCells: 60,
  scalePoints: 11,
  sliderSteps: 10_000,
  label: 200,
  help: 1_000,
  note: 2_000,
  placeholder: 200,
  shortText: 2_000,
  longText: 20_000,
  /** The form as JSON, in characters. */
  json: 24_000,
} as const;

/** Above this many options, a single choice is a dropdown unless the form says otherwise. */
export const RADIO_MAX = 6;

const Id = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u, "an id is a letter followed by up to 39 letters, digits, - or _")
  .describe("Unique within the form; the answer is keyed by it");
const Label = z.string().trim().min(1).max(FORM_LIMITS.label);
const Help = z.string().max(FORM_LIMITS.help).optional().describe("Markdown under the label; backticked workspace paths open as links");
const Placeholder = z.string().max(FORM_LIMITS.placeholder).optional();
const Width = z.enum(["full", "half", "third"]).optional().describe("full (default) takes the line; half and third share it with neighbours");
const OptionSchema = z.object({
  value: z.string().trim().min(1).max(60).describe("What the answer records"),
  label: Label.describe("What the learner reads"),
});
const Options = (min: number, max: number) => z.array(OptionSchema).min(min).max(max);

const base = {
  id: Id,
  label: Label,
  help: Help,
  required: z.boolean().optional().describe("Defaults to true; false for a part the learner may leave empty"),
  width: Width,
};

export const TextFieldSchema = z.object({
  kind: z.literal("text"),
  ...base,
  placeholder: Placeholder,
  default: z.string().max(FORM_LIMITS.shortText).optional(),
  minLength: z.number().int().min(1).max(FORM_LIMITS.shortText).optional(),
  maxLength: z.number().int().min(1).max(FORM_LIMITS.shortText).optional(),
});
export const LongTextFieldSchema = z.object({
  kind: z.literal("long-text"),
  ...base,
  placeholder: Placeholder,
  default: z.string().max(FORM_LIMITS.longText).optional(),
  minLength: z.number().int().min(1).max(FORM_LIMITS.longText).optional(),
  maxLength: z.number().int().min(1).max(FORM_LIMITS.longText).optional(),
  rows: z.number().int().min(2).max(20).optional(),
});
export const CodeFieldSchema = z.object({
  kind: z.literal("code"),
  ...base,
  language: z.string().max(30).optional().describe("Shown beside the label, e.g. ts or sql"),
  placeholder: Placeholder,
  default: z.string().max(FORM_LIMITS.longText).optional(),
  maxLength: z.number().int().min(1).max(FORM_LIMITS.longText).optional(),
  rows: z.number().int().min(2).max(30).optional(),
});
export const NumberFieldSchema = z.object({
  kind: z.literal("number"),
  ...base,
  placeholder: Placeholder,
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional().describe("1 for whole numbers"),
  unit: z.string().max(20).optional(),
  default: z.number().finite().optional(),
});
export const SliderFieldSchema = z.object({
  kind: z.literal("slider"),
  ...base,
  min: z.number().finite(),
  max: z.number().finite(),
  step: z.number().finite().positive().optional(),
  unit: z.string().max(20).optional(),
  minLabel: z.string().max(60).optional().describe("Words under the low end"),
  maxLabel: z.string().max(60).optional().describe("Words under the high end"),
  default: z.number().finite().optional().describe("Without one the learner must move the slider before it counts as answered"),
});
export const ChoiceFieldSchema = z.object({
  kind: z.literal("choice"),
  ...base,
  options: Options(2, FORM_LIMITS.options),
  display: z.enum(["auto", "radio", "dropdown"]).optional().describe(`auto: radio buttons up to ${RADIO_MAX} options, a dropdown above`),
  default: z.string().optional().describe("An option value"),
});
export const MultiChoiceFieldSchema = z.object({
  kind: z.literal("multi-choice"),
  ...base,
  options: Options(2, FORM_LIMITS.options),
  minSelected: z.number().int().min(0).max(FORM_LIMITS.options).optional(),
  maxSelected: z.number().int().min(1).max(FORM_LIMITS.options).optional(),
  default: z.array(z.string()).max(FORM_LIMITS.options).optional().describe("Option values ticked at first"),
});
export const YesNoFieldSchema = z.object({
  kind: z.literal("yes-no"),
  ...base,
  yesLabel: z.string().trim().min(1).max(40).optional(),
  noLabel: z.string().trim().min(1).max(40).optional(),
  default: z.boolean().optional(),
});
export const ScaleFieldSchema = z.object({
  kind: z.literal("scale"),
  ...base,
  min: z.number().int().min(-10).max(10).optional().describe("Defaults to 1"),
  max: z.number().int().min(-9).max(20).optional().describe(`Defaults to 5; at most ${FORM_LIMITS.scalePoints} points`),
  minLabel: z.string().max(60).optional(),
  maxLabel: z.string().max(60).optional(),
  pointLabels: z.array(z.string().max(40)).max(FORM_LIMITS.scalePoints).optional().describe("One label per point, low to high"),
  default: z.number().int().optional(),
});
export const RankingFieldSchema = z.object({
  kind: z.literal("ranking"),
  ...base,
  items: Options(2, FORM_LIMITS.ranked).describe("In the order the learner first sees them; do not give away the answer"),
});
export const MatchingFieldSchema = z.object({
  kind: z.literal("matching"),
  ...base,
  left: Options(1, FORM_LIMITS.matched).describe("Each gets a dropdown of the right-hand items"),
  right: Options(2, FORM_LIMITS.matched),
  oneToOne: z.boolean().optional().describe("Each right-hand item may be used once"),
});
export const ListFieldSchema = z.object({
  kind: z.literal("list"),
  ...base,
  placeholder: Placeholder,
  minEntries: z.number().int().min(1).max(FORM_LIMITS.listEntries).optional(),
  maxEntries: z.number().int().min(1).max(FORM_LIMITS.listEntries).optional(),
  maxLength: z.number().int().min(1).max(500).optional().describe("Per entry; defaults to 500"),
});
export const TableColumnSchema = z.object({
  id: Id,
  label: Label,
  control: z.enum(["text", "number", "choice", "checkbox"]),
  options: Options(2, FORM_LIMITS.options).optional().describe("For a choice column"),
  placeholder: Placeholder,
});
export const TableFieldSchema = z.object({
  kind: z.literal("table"),
  ...base,
  columns: z.array(TableColumnSchema).min(1).max(FORM_LIMITS.tableColumns),
  rows: z.array(z.object({ id: Id, label: Label })).min(1).max(FORM_LIMITS.tableRows),
});
export const SectionItemSchema = z.object({
  kind: z.literal("section"),
  title: Label,
  help: Help,
});
export const NoteItemSchema = z.object({
  kind: z.literal("note"),
  text: z.string().trim().min(1).max(FORM_LIMITS.note).describe("Markdown shown between fields"),
});

const FIELD_SCHEMAS = [
  TextFieldSchema,
  LongTextFieldSchema,
  CodeFieldSchema,
  NumberFieldSchema,
  SliderFieldSchema,
  ChoiceFieldSchema,
  MultiChoiceFieldSchema,
  YesNoFieldSchema,
  ScaleFieldSchema,
  RankingFieldSchema,
  MatchingFieldSchema,
  ListFieldSchema,
  TableFieldSchema,
] as const;

export const FormItemSchema = z.discriminatedUnion("kind", [...FIELD_SCHEMAS, SectionItemSchema, NoteItemSchema]);

/** A form's shape. `checkForm` adds what a schema cannot say (unique ids, ranges, defaults). */
export const AnswerFormSchema = z.object({
  items: z.array(FormItemSchema).min(1).max(FORM_LIMITS.items),
});

export type AnswerForm = z.infer<typeof AnswerFormSchema>;
export type FormItem = z.infer<typeof FormItemSchema>;
export type FormField = Exclude<FormItem, { kind: "section" } | { kind: "note" }>;
export type FieldKind = FormField["kind"];
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableCell = string | number | boolean | null;

/** What one field answers. Null is "no answer". */
export type FieldValue = string | number | boolean | string[] | Record<string, string | null> | Record<string, Record<string, TableCell>> | null;
export type FormValues = Record<string, FieldValue>;

const CellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const FormValuesSchema: z.ZodType<FormValues> = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()), z.record(z.string(), z.string().nullable()), z.record(z.string(), z.record(z.string(), CellSchema))]),
);

export const FIELD_KINDS: readonly FieldKind[] = FIELD_SCHEMAS.map((schema) => schema.shape.kind.value);

export function isField(item: FormItem): item is FormField {
  return item.kind !== "section" && item.kind !== "note";
}

export function formFields(form: AnswerForm): FormField[] {
  return form.items.filter(isField);
}

export function isRequired(field: FormField): boolean {
  return field.required !== false;
}

export function scaleRange(field: Extract<FormField, { kind: "scale" }>): { min: number; max: number } {
  return { min: field.min ?? 1, max: field.max ?? 5 };
}

export function choiceDisplay(field: Extract<FormField, { kind: "choice" }>): "radio" | "dropdown" {
  if (field.display === "radio" || field.display === "dropdown") return field.display;
  return field.options.length > RADIO_MAX ? "dropdown" : "radio";
}

function textMax(field: Extract<FormField, { kind: "text" | "long-text" | "code" }>): number {
  return field.maxLength ?? (field.kind === "text" ? 500 : field.kind === "code" ? 8_000 : 4_000);
}

function listEntryMax(field: Extract<FormField, { kind: "list" }>): number {
  return field.maxLength ?? 500;
}

// ── checking a form ─────────────────────────────────────────────────────────

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

/** What is wrong with a form that has the right shape, in words an agent can act on. */
export function checkForm(form: AnswerForm): string[] {
  const problems: string[] = [];
  const fields = formFields(form);
  if (fields.length === 0) problems.push("the form has no field to answer");
  if (fields.length > FORM_LIMITS.fields) problems.push(`the form has ${fields.length} fields; at most ${FORM_LIMITS.fields}`);
  for (const id of duplicates(fields.map((field) => field.id))) problems.push(`two fields have the id "${id}"`);
  const json = JSON.stringify(form).length;
  if (json > FORM_LIMITS.json) problems.push(`the form is ${json} characters as JSON; at most ${FORM_LIMITS.json}`);
  for (const field of fields) {
    const say = (problem: string) => problems.push(`field "${field.id}": ${problem}`);
    const optionValues = (options: readonly { value: string }[], what = "options") => {
      for (const value of duplicates(options.map((option) => option.value))) say(`two ${what} have the value "${value}"`);
      return new Set(options.map((option) => option.value));
    };
    switch (field.kind) {
      case "text":
      case "long-text":
        if (field.minLength !== undefined && field.minLength > textMax(field)) say(`minLength is above the ${textMax(field)} characters it takes (set maxLength)`);
        if (field.default !== undefined && field.default.length > textMax(field)) say(`the default is longer than the ${textMax(field)} characters it takes`);
        break;
      case "code":
        if (field.default !== undefined && field.default.length > textMax(field)) say(`the default is longer than the ${textMax(field)} characters it takes`);
        break;
      case "number":
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) say("min is above max");
        if (field.default !== undefined && numberProblem(field, field.default) !== null) say(`the default ${numberProblem(field, field.default)}`);
        break;
      case "slider":
        if (field.min >= field.max) say("min must be below max");
        else if ((field.max - field.min) / (field.step ?? 1) > FORM_LIMITS.sliderSteps) say(`more than ${FORM_LIMITS.sliderSteps} steps; use a larger step`);
        if (field.default !== undefined && (field.default < field.min || field.default > field.max)) say("the default is outside min..max");
        break;
      case "choice": {
        const values = optionValues(field.options);
        if (field.default !== undefined && !values.has(field.default)) say(`the default "${field.default}" is not an option value`);
        break;
      }
      case "multi-choice": {
        const values = optionValues(field.options);
        for (const value of field.default ?? []) if (!values.has(value)) say(`the default "${value}" is not an option value`);
        if (field.minSelected !== undefined && field.minSelected > field.options.length) say("minSelected is more than the options");
        if (field.minSelected !== undefined && field.maxSelected !== undefined && field.minSelected > field.maxSelected) say("minSelected is above maxSelected");
        break;
      }
      case "scale": {
        const { min, max } = scaleRange(field);
        const points = max - min + 1;
        if (points < 2 || points > FORM_LIMITS.scalePoints) say(`a scale has 2 to ${FORM_LIMITS.scalePoints} points; this one has ${points}`);
        if (field.pointLabels !== undefined && field.pointLabels.length !== points) say(`pointLabels has ${field.pointLabels.length} labels for ${points} points`);
        if (field.default !== undefined && (field.default < min || field.default > max)) say("the default is outside the scale");
        break;
      }
      case "ranking":
        optionValues(field.items, "items");
        break;
      case "matching": {
        optionValues(field.left, "left items");
        optionValues(field.right, "right items");
        if (field.oneToOne === true && field.left.length > field.right.length) say("oneToOne needs at least as many right items as left ones");
        break;
      }
      case "list":
        if (field.minEntries !== undefined && field.maxEntries !== undefined && field.minEntries > field.maxEntries) say("minEntries is above maxEntries");
        break;
      case "table": {
        for (const id of duplicates(field.columns.map((column) => column.id))) say(`two columns have the id "${id}"`);
        for (const id of duplicates(field.rows.map((row) => row.id))) say(`two rows have the id "${id}"`);
        const cells = field.columns.length * field.rows.length;
        if (cells > FORM_LIMITS.tableCells) say(`${cells} cells; at most ${FORM_LIMITS.tableCells}`);
        for (const column of field.columns) {
          if (column.control === "choice" && column.options === undefined) say(`column "${column.id}" is a choice with no options`);
          if (column.options !== undefined) optionValues(column.options, `options of column "${column.id}"`);
        }
        break;
      }
      case "yes-no":
        break;
    }
  }
  return problems;
}

/** A form from untrusted input: the form, or every problem found with it. */
export function parseAnswerForm(raw: unknown): { form: AnswerForm } | { problems: string[] } {
  const parsed = AnswerFormSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.slice(0, 8).map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)),
    };
  }
  const problems = checkForm(parsed.data);
  return problems.length > 0 ? { problems: problems.slice(0, 8) } : { form: parsed.data };
}

/** A form that was checked once (a card's payload, a stored question), or null when it no longer reads. */
export function readAnswerForm(raw: unknown): AnswerForm | null {
  if (raw === null || raw === undefined) return null;
  const parsed = parseAnswerForm(raw);
  return "form" in parsed ? parsed.form : null;
}

// ── values ──────────────────────────────────────────────────────────────────

/** What each field holds before the learner touches it. */
export function initialValues(form: AnswerForm): FormValues {
  const values: FormValues = {};
  for (const field of formFields(form)) values[field.id] = initialValue(field);
  return values;
}

function initialValue(field: FormField): FieldValue {
  switch (field.kind) {
    case "text":
    case "long-text":
    case "code":
      return field.default ?? "";
    case "number":
    case "slider":
    case "scale":
    case "yes-no":
    case "choice":
      return field.default ?? null;
    case "multi-choice":
      return [...(field.default ?? [])];
    // Untouched until the learner moves an item or keeps the order shown (`isAnswered`).
    case "ranking":
      return null;
    case "matching":
      return Object.fromEntries(field.left.map((item) => [item.value, null]));
    case "list":
      return [""];
    // A checkbox cell is null until the learner ticks a box or confirms the unticked ones (`checkboxesDecided`).
    case "table":
      return Object.fromEntries(field.rows.map((row) => [row.id, Object.fromEntries(field.columns.map((column) => [column.id, null]))]));
  }
}

function numberProblem(field: { min?: number; max?: number; step?: number }, value: number): string | null {
  if (field.min !== undefined && value < field.min) return `is below ${field.min}`;
  if (field.max !== undefined && value > field.max) return `is above ${field.max}`;
  if (field.step !== undefined) {
    const steps = (value - (field.min ?? 0)) / field.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return `is not a multiple of ${field.step}`;
  }
  return null;
}

function filled(cell: TableCell): boolean {
  return cell !== null && cell !== "";
}

type TableField = Extract<FormField, { kind: "table" }>;

function checkboxColumns(field: TableField): TableColumn[] {
  return field.columns.filter((column) => column.control === "checkbox");
}

/**
 * Whether the learner decided a table's checkboxes: ticked or unticked any of them, or confirmed the
 * unticked ones (`confirmUnticked`). Once decided, a box never touched counts as unticked; before, an
 * unticked box is no answer, so a table left alone never reads as "no" everywhere.
 */
export function checkboxesDecided(field: TableField, value: FieldValue): boolean {
  return checkboxColumns(field).some((column) => field.rows.some((row) => typeof cellOf(value, row.id, column.id) === "boolean"));
}

/** The table with every checkbox not ticked set to unticked: the learner's "none of the others". */
export function confirmUnticked(field: TableField, value: FieldValue): Record<string, Record<string, TableCell>> {
  return Object.fromEntries(
    field.rows.map((row) => [
      row.id,
      Object.fromEntries(field.columns.map((column) => {
        const cell = cellOf(value, row.id, column.id);
        return [column.id, column.control === "checkbox" ? cell === true : cell];
      })),
    ]),
  );
}

/**
 * Whether the learner gave this field anything. A ranking counts once its order was moved or kept, a
 * table once a cell is filled or its checkboxes are decided.
 */
export function isAnswered(field: FormField, value: FieldValue): boolean {
  if (value === null || value === undefined) return false;
  switch (field.kind) {
    case "text":
    case "long-text":
    case "code":
      return typeof value === "string" && value.trim() !== "";
    case "multi-choice":
      return Array.isArray(value) && value.length > 0;
    case "list":
      return Array.isArray(value) && value.some((entry) => entry.trim() !== "");
    case "ranking":
      return Array.isArray(value) && value.length > 0;
    case "matching":
      return typeof value === "object" && !Array.isArray(value) && Object.values(value).some((match) => match !== null);
    case "table":
      return (
        typeof value === "object" &&
        !Array.isArray(value) &&
        (field.columns.some((column) => column.control !== "checkbox" && field.rows.some((row) => filled(cellOf(value, row.id, column.id)))) || checkboxesDecided(field, value))
      );
    default:
      return true;
  }
}

function cellOf(value: FieldValue, rowId: string, columnId: string): TableCell {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = (value as Record<string, unknown>)[rowId];
  if (row === null || typeof row !== "object") return null;
  const cell = (row as Record<string, unknown>)[columnId];
  return typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" ? cell : null;
}

/** Why the card cannot send this field yet, in a few words; null when it can. */
export function fieldProblem(field: FormField, value: FieldValue): string | null {
  const answered = isAnswered(field, value);
  if (!answered) {
    if (!isRequired(field)) return null;
    if (field.kind === "ranking") return "needs an order: move an item, or keep this order";
    if (field.kind === "table" && checkboxColumns(field).length === field.columns.length) return "needs its boxes ticked, or the unticked ones confirmed";
    return "needs an answer";
  }
  switch (field.kind) {
    case "text":
    case "long-text": {
      const text = (value as string).trim();
      if (field.minLength !== undefined && text.length < field.minLength) return `needs at least ${field.minLength} characters`;
      if ((value as string).length > textMax(field)) return `is longer than ${textMax(field)} characters`;
      return null;
    }
    case "code":
      return (value as string).length > textMax(field) ? `is longer than ${textMax(field)} characters` : null;
    case "number":
    case "slider": {
      const problem = typeof value === "number" && Number.isFinite(value) ? numberProblem(field, value) : "is not a number";
      return problem === null ? null : `${problem}`;
    }
    case "multi-choice": {
      const count = (value as string[]).length;
      if (field.minSelected !== undefined && count < field.minSelected) return `needs at least ${field.minSelected} ticked`;
      if (field.maxSelected !== undefined && count > field.maxSelected) return `takes at most ${field.maxSelected} ticked`;
      return null;
    }
    case "list": {
      const entries = (value as string[]).filter((entry) => entry.trim() !== "");
      if (field.minEntries !== undefined && entries.length < field.minEntries) return `needs at least ${field.minEntries} entries`;
      if (field.maxEntries !== undefined && entries.length > field.maxEntries) return `takes at most ${field.maxEntries} entries`;
      if (entries.some((entry) => entry.length > listEntryMax(field))) return `has an entry longer than ${listEntryMax(field)} characters`;
      return null;
    }
    case "matching": {
      const matches = value as Record<string, string | null>;
      if (isRequired(field) && field.left.some((item) => matches[item.value] === null || matches[item.value] === undefined)) return "needs every item matched";
      if (field.oneToOne === true) {
        const used = Object.values(matches).filter((match): match is string => match !== null);
        if (new Set(used).size !== used.length) return "uses an item twice";
      }
      return null;
    }
    case "table": {
      if (!isRequired(field)) return null;
      const empty = field.columns.some((column) => column.control !== "checkbox" && field.rows.some((row) => !filled(cellOf(value, row.id, column.id))));
      if (empty) return "needs every cell filled";
      return checkboxColumns(field).length > 0 && !checkboxesDecided(field, value) ? "needs its boxes ticked, or the unticked ones confirmed" : null;
    }
    default:
      return null;
  }
}

/** Each field's problem, by id; empty when the card can send. */
export function formProblems(form: AnswerForm, values: FormValues): Map<string, string> {
  const problems = new Map<string, string>();
  for (const field of formFields(form)) {
    const problem = fieldProblem(field, values[field.id] ?? null);
    if (problem !== null) problems.set(field.id, problem);
  }
  return problems;
}

/** Whether the learner answered anything at all. */
export function hasAnyAnswer(form: AnswerForm, values: FormValues): boolean {
  return formFields(form).some((field) => isAnswered(field, values[field.id] ?? null));
}

function cutText(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function clampNumber(value: unknown, min: number | undefined, max: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

/**
 * What a card sent, read against the form it was asked with. Only the form's fields are kept, each in
 * its own shape: anything else in a field is "no answer", a number is clamped to its range, a text cut
 * to its limit, a choice outside the options dropped. It never throws.
 */
/**
 * An unsent answer (a draft) read against the form, as `sanitizeValues` reads a submitted one: whatever does
 * not fit the form is dropped. Where that leaves a text field with no text or a list with no entries, the
 * field starts as a fresh card has it (its default, or one empty entry), since those controls hold text.
 */
export function draftValues(form: AnswerForm, raw: unknown): FormValues {
  const values = sanitizeValues(form, raw);
  const fresh = initialValues(form);
  for (const field of formFields(form)) {
    const value = values[field.id];
    const holdsText = field.kind === "text" || field.kind === "long-text" || field.kind === "code";
    if ((holdsText && value === null) || (field.kind === "list" && Array.isArray(value) && value.length === 0)) values[field.id] = fresh[field.id]!;
  }
  return values;
}

export function sanitizeValues(form: AnswerForm, raw: unknown): FormValues {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const values: FormValues = {};
  for (const field of formFields(form)) values[field.id] = sanitizeValue(field, Object.hasOwn(source, field.id) ? source[field.id] : null);
  return values;
}

function sanitizeValue(field: FormField, value: unknown): FieldValue {
  switch (field.kind) {
    case "text":
    case "long-text":
    case "code":
      return cutText(value, textMax(field));
    case "number":
      return clampNumber(value, field.min, field.max);
    case "slider":
      return clampNumber(value, field.min, field.max);
    case "scale": {
      const { min, max } = scaleRange(field);
      const number = clampNumber(value, min, max);
      return number === null ? null : Math.round(number);
    }
    case "yes-no":
      return typeof value === "boolean" ? value : null;
    case "choice":
      return typeof value === "string" && field.options.some((option) => option.value === value) ? value : null;
    case "multi-choice": {
      if (!Array.isArray(value)) return [];
      const picked = new Set(value.filter((entry): entry is string => typeof entry === "string"));
      return field.options.filter((option) => picked.has(option.value)).map((option) => option.value);
    }
    case "ranking": {
      const known = field.items.map((item) => item.value);
      const given = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && known.includes(entry)) : [];
      if (given.length === 0) return null;
      const order = [...new Set(given)];
      return [...order, ...known.filter((item) => !order.includes(item))];
    }
    case "matching": {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const right = new Set(field.right.map((item) => item.value));
      return Object.fromEntries(
        field.left.map((item) => {
          const match = Object.hasOwn(source, item.value) ? source[item.value] : null;
          return [item.value, typeof match === "string" && right.has(match) ? match : null];
        }),
      );
    }
    case "list": {
      if (!Array.isArray(value)) return [];
      return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.slice(0, listEntryMax(field)))
        .filter((entry) => entry.trim() !== "")
        .slice(0, field.maxEntries ?? FORM_LIMITS.listEntries);
    }
    case "table": {
      const table = Object.fromEntries(
        field.rows.map((row) => [
          row.id,
          Object.fromEntries(field.columns.map((column) => [column.id, sanitizeCell(column, cellOf(value as FieldValue, row.id, column.id))])),
        ]),
      );
      return checkboxesDecided(field, table) ? confirmUnticked(field, table) : table;
    }
  }
}

function sanitizeCell(column: TableColumn, cell: TableCell): TableCell {
  switch (column.control) {
    case "text":
      return typeof cell === "string" ? cell.slice(0, 500) : null;
    case "number":
      return typeof cell === "number" && Number.isFinite(cell) ? cell : null;
    case "choice":
      return typeof cell === "string" && (column.options ?? []).some((option) => option.value === cell) ? cell : null;
    case "checkbox":
      return typeof cell === "boolean" ? cell : null;
  }
}

// ── reading an answer ───────────────────────────────────────────────────────

function optionLabel(options: readonly { value: string; label: string }[], value: string | null): string {
  if (value === null) return "(none)";
  return options.find((option) => option.value === value)?.label ?? value;
}

/** A number with its unit: `30 ms`, but `30%` and `90°`. */
export function withUnit(value: number, unit: string | undefined): string {
  if (unit === undefined || unit === "") return String(value);
  return /^[%°]/u.test(unit) ? `${value}${unit}` : `${value} ${unit}`;
}

function cellText(column: TableColumn, cell: TableCell): string {
  if (column.control === "checkbox") return cell === true ? "yes" : cell === false ? "no" : "(not answered)";
  if (cell === null || cell === "") return "(empty)";
  if (column.control === "choice") return optionLabel(column.options ?? [], String(cell));
  return String(cell);
}

/**
 * One field's answer as lines of text: a single line for a short value, several for a list, a ranking,
 * a matching, a table or a block of code.
 */
export function describeValue(field: FormField, value: FieldValue): string[] {
  if (!isAnswered(field, value)) return ["(no answer)"];
  switch (field.kind) {
    case "text":
    case "long-text":
      return (value as string).trim().split("\n");
    case "code":
      return ["```" + (field.language ?? ""), ...(value as string).replace(/\n+$/u, "").split("\n"), "```"];
    case "number":
    case "slider":
      return [withUnit(value as number, field.unit)];
    case "scale": {
      const { min, max } = scaleRange(field);
      const point = value as number;
      const label = field.pointLabels?.[point - min] ?? (point === min ? field.minLabel : point === max ? field.maxLabel : undefined);
      return [`${point} on ${min}–${max}${label !== undefined && label !== "" ? ` (${label})` : ""}`];
    }
    case "yes-no":
      return [value === true ? (field.yesLabel ?? "Yes") : (field.noLabel ?? "No")];
    case "choice":
      return [optionLabel(field.options, value as string)];
    case "multi-choice":
      return [(value as string[]).map((entry) => optionLabel(field.options, entry)).join(", ")];
    case "ranking":
      return (value as string[]).map((entry, index) => `${index + 1}. ${optionLabel(field.items, entry)}`);
    case "matching": {
      const matches = value as Record<string, string | null>;
      return field.left.map((item) => `${item.label} → ${optionLabel(field.right, matches[item.value] ?? null)}`);
    }
    case "list":
      return (value as string[]).filter((entry) => entry.trim() !== "").map((entry) => `• ${entry.trim()}`);
    case "table":
      return field.rows.map((row) => `${row.label}: ${field.columns.map((column) => `${column.label} ${cellText(column, cellOf(value, row.id, column.id))}`).join("; ")}`);
  }
}

/** The whole answer as text the agent and the history read: each field's label and what was given, by section. */
export function summarizeAnswer(form: AnswerForm, values: FormValues): string {
  const lines: string[] = [];
  for (const item of form.items) {
    if (item.kind === "note") continue;
    if (item.kind === "section") {
      if (lines.length > 0) lines.push("");
      lines.push(`## ${item.title}`);
      continue;
    }
    const described = describeValue(item, values[item.id] ?? null);
    if (described.length === 1 && item.kind !== "code") lines.push(`- ${item.label}: ${described[0]}`);
    else lines.push(`- ${item.label}:`, ...described.map((line) => `    ${line}`));
  }
  return lines.join("\n");
}
