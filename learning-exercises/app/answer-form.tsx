/**
 * An answer form (`shared/answer-form.ts`) drawn in the exercise card, and the same answer read back in
 * the transcript and the Learning tab.
 *
 * Native form controls styled with bb's theme tokens: each is keyboard-operable as it is, every input
 * has a label tied to it (`htmlFor`, a `legend`, or an `aria-label` for a table cell), and groups are
 * `fieldset`s. The layout is a six-column grid under a container query, so `half` and `third` fields
 * share a line in a wide card and stack in a narrow one. Labels and option names are plain text; help
 * and notes are bb's Markdown, with workspace file links (`file-refs.tsx`).
 *
 * Every button is `type="button"`: the card is drawn inside the composer's form.
 */
import { Fragment, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  choiceDisplay,
  describeValue,
  fieldProblem,
  isAnswered,
  isRequired,
  scaleRange,
  type AnswerForm,
  type FieldValue,
  type FormField,
  type FormItem,
  type FormValues,
  type TableCell,
  type TableColumn,
  withUnit,
} from "../shared/answer-form";
import type { Workspace } from "../shared/types";
import { FileMarkdown } from "./file-refs";

const CONTROL = "rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const SPAN = { full: "@md:col-span-6", half: "@md:col-span-3", third: "@md:col-span-2" } as const;
const CHECK = "size-4 shrink-0 accent-foreground";

type Group = { section: Extract<FormItem, { kind: "section" }> | null; items: FormItem[] };

/** The items split at each section heading; items before the first section form a group of their own. */
function groups(form: AnswerForm): Group[] {
  const result: Group[] = [{ section: null, items: [] }];
  for (const item of form.items) {
    if (item.kind === "section") result.push({ section: item, items: [] });
    else result.at(-1)!.items.push(item);
  }
  return result.filter((group) => group.section !== null || group.items.length > 0);
}

function GroupFrame(props: { group: Group; workspace: Workspace | null; children: ReactNode }) {
  const headingId = useId();
  const { section } = props.group;
  if (section === null) return <div className="grid grid-cols-1 gap-3 @md:grid-cols-6">{props.children}</div>;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 id={headingId} className="text-sm font-medium">
        {section.title}
      </h3>
      {section.help !== undefined && section.help !== "" && <FileMarkdown content={section.help} workspace={props.workspace} className="text-xs text-muted-foreground" />}
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-6">{props.children}</div>
    </section>
  );
}

export interface AnswerFormFieldsProps {
  form: AnswerForm;
  values: FormValues;
  onChange: (id: string, value: FieldValue) => void;
  disabled?: boolean;
  workspace: Workspace | null;
}

/** The form's controls. The caller keeps the values (`initialValues`) and decides when it can be sent. */
export function AnswerFormFields(props: AnswerFormFieldsProps) {
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (id: string) => setTouched((seen) => (seen.has(id) ? seen : new Set(seen).add(id)));
  return (
    <div className="@container flex flex-col gap-3" data-answer-form="">
      {groups(props.form).map((group, index) => (
        <GroupFrame key={index} group={group} workspace={props.workspace}>
          {group.items.map((item, itemIndex) =>
            item.kind === "note" ? (
              <FileMarkdown key={`note-${itemIndex}`} content={item.text} workspace={props.workspace} className={cn("text-sm text-muted-foreground", SPAN.full)} />
            ) : item.kind === "section" ? null : (
              <div key={item.id} className={cn("min-w-0", SPAN[item.width ?? "full"])} onBlur={() => touch(item.id)}>
                <FieldControl
                  field={item}
                  value={props.values[item.id] ?? null}
                  onChange={(value) => props.onChange(item.id, value)}
                  disabled={props.disabled === true}
                  workspace={props.workspace}
                  showProblem={touched.has(item.id)}
                />
              </div>
            ),
          )}
        </GroupFrame>
      ))}
    </div>
  );
}

interface ControlProps<F extends FormField = FormField> {
  field: F;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  disabled: boolean;
  workspace: Workspace | null;
  showProblem: boolean;
}

function LabelText(props: { field: FormField; extra?: string }) {
  return (
    <>
      {props.field.label}
      {props.extra !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">{props.extra}</span>}
      {!isRequired(props.field) && <span className="ml-1.5 font-normal text-muted-foreground">(optional)</span>}
    </>
  );
}

function Help(props: { field: FormField; id: string; workspace: Workspace | null }) {
  if (props.field.help === undefined || props.field.help === "") return null;
  return (
    <div id={props.id}>
      <FileMarkdown content={props.field.help} workspace={props.workspace} className="text-xs text-muted-foreground" />
    </div>
  );
}

function Problem(props: { id: string; text: string | null }) {
  if (props.text === null) return null;
  return (
    <p id={props.id} className="text-xs text-destructive">
      {props.text}
    </p>
  );
}

/** Ids for a field's label, help and problem, and the `aria-*` an input carries. */
function useFieldIds(props: ControlProps) {
  const base = useId();
  const problem = props.showProblem ? fieldProblem(props.field, props.value) : null;
  const helpId = `${base}-help`;
  const problemId = `${base}-problem`;
  const describedBy = [props.field.help ? helpId : null, problem !== null ? problemId : null].filter(Boolean).join(" ") || undefined;
  return {
    inputId: `${base}-input`,
    helpId,
    problemId,
    problem,
    aria: { "aria-describedby": describedBy, "aria-invalid": problem !== null ? true : undefined, "aria-required": isRequired(props.field) || undefined },
  };
}

/** A field with one input, labelled by a `label`. */
function Single(props: ControlProps & { extra?: string; children: (ids: ReturnType<typeof useFieldIds>) => ReactNode }) {
  const ids = useFieldIds(props);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={ids.inputId} className="text-sm font-medium">
        <LabelText field={props.field} extra={props.extra} />
      </label>
      <Help field={props.field} id={ids.helpId} workspace={props.workspace} />
      {props.children(ids)}
      <Problem id={ids.problemId} text={ids.problem} />
    </div>
  );
}

/** A field of several inputs, a `fieldset` whose `legend` is the label. */
function FieldGroup(props: ControlProps & { children: (ids: ReturnType<typeof useFieldIds>) => ReactNode }) {
  const ids = useFieldIds(props);
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={ids.aria["aria-describedby"]} aria-invalid={ids.aria["aria-invalid"]}>
      <legend className="mb-1.5 text-sm font-medium">
        <LabelText field={props.field} />
      </legend>
      <Help field={props.field} id={ids.helpId} workspace={props.workspace} />
      {props.children(ids)}
      <Problem id={ids.problemId} text={ids.problem} />
    </fieldset>
  );
}

function asString(value: FieldValue): string {
  return typeof value === "string" ? value : "";
}

function asStrings(value: FieldValue): string[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: FieldValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function FieldControl(props: ControlProps) {
  const { field } = props;
  switch (field.kind) {
    case "text":
      return (
        <Single {...props}>
          {(ids) => (
            <Input
              id={ids.inputId}
              {...ids.aria}
              className="bg-background text-sm"
              value={asString(props.value)}
              placeholder={field.placeholder}
              maxLength={field.maxLength ?? 500}
              disabled={props.disabled}
              onChange={(event) => props.onChange(event.target.value)}
            />
          )}
        </Single>
      );
    case "long-text":
    case "code":
      return (
        <Single {...props} extra={field.kind === "code" && field.language ? field.language : undefined}>
          {(ids) => (
            <textarea
              id={ids.inputId}
              {...ids.aria}
              className={cn(CONTROL, "w-full resize-y p-2", field.kind === "code" && "whitespace-pre font-mono text-xs")}
              rows={field.rows ?? (field.kind === "code" ? 8 : 4)}
              value={asString(props.value)}
              placeholder={field.placeholder}
              maxLength={field.maxLength ?? (field.kind === "code" ? 8_000 : 4_000)}
              spellCheck={field.kind === "code" ? false : undefined}
              wrap={field.kind === "code" ? "off" : undefined}
              disabled={props.disabled}
              onChange={(event) => props.onChange(event.target.value)}
            />
          )}
        </Single>
      );
    case "number":
      return (
        <Single {...props}>
          {(ids) => (
            <div className="flex items-center gap-2">
              <Input
                id={ids.inputId}
                {...ids.aria}
                type="number"
                inputMode="decimal"
                className="bg-background text-sm"
                value={asNumber(props.value) ?? ""}
                placeholder={field.placeholder}
                min={field.min}
                max={field.max}
                step={field.step ?? "any"}
                disabled={props.disabled}
                onChange={(event) => props.onChange(readNumber(event.target.value))}
              />
              {field.unit !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span>}
            </div>
          )}
        </Single>
      );
    case "slider":
      return <Slider {...props} field={field} />;
    case "choice":
      return choiceDisplay(field) === "dropdown" ? (
        <Single {...props}>
          {(ids) => (
            <select
              id={ids.inputId}
              {...ids.aria}
              className={cn(CONTROL, "h-9 w-full px-2")}
              value={asString(props.value)}
              disabled={props.disabled}
              onChange={(event) => props.onChange(event.target.value === "" ? null : event.target.value)}
            >
              <option value="">Choose…</option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Single>
      ) : (
        <FieldGroup {...props}>
          {() => <Radios name={field.id} options={field.options} value={asString(props.value)} disabled={props.disabled} onChange={props.onChange} />}
        </FieldGroup>
      );
    case "multi-choice":
      return (
        <FieldGroup {...props}>
          {() => {
            const picked = asStrings(props.value);
            const full = field.maxSelected !== undefined && picked.length >= field.maxSelected;
            return (
              <div className="flex flex-col gap-1">
                {field.options.map((option) => {
                  const checked = picked.includes(option.value);
                  return (
                    <label key={option.value} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className={cn(CHECK, "mt-0.5")}
                        checked={checked}
                        disabled={props.disabled || (full && !checked)}
                        onChange={() =>
                          props.onChange(checked ? picked.filter((entry) => entry !== option.value) : field.options.map((each) => each.value).filter((value) => value === option.value || picked.includes(value)))
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
                {(field.minSelected !== undefined || field.maxSelected !== undefined) && (
                  <span className="text-xs text-muted-foreground">{selectionHint(field.minSelected, field.maxSelected)}</span>
                )}
              </div>
            );
          }}
        </FieldGroup>
      );
    case "yes-no":
      return (
        <FieldGroup {...props}>
          {() => (
            <Radios
              name={field.id}
              inline
              options={[
                { value: "yes", label: field.yesLabel ?? "Yes" },
                { value: "no", label: field.noLabel ?? "No" },
              ]}
              value={props.value === true ? "yes" : props.value === false ? "no" : ""}
              disabled={props.disabled}
              onChange={(value) => props.onChange(value === "yes")}
            />
          )}
        </FieldGroup>
      );
    case "scale":
      return <Scale {...props} field={field} />;
    case "ranking":
      return <Ranking {...props} field={field} />;
    case "matching":
      return <Matching {...props} field={field} />;
    case "list":
      return <List {...props} field={field} />;
    case "table":
      return <Table {...props} field={field} />;
  }
}

function selectionHint(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return min === max ? `Tick ${min}.` : `Tick ${min} to ${max}.`;
  if (min !== undefined) return `Tick at least ${min}.`;
  return `Tick at most ${max}.`;
}

function Radios(props: { name: string; options: readonly { value: string; label: string }[]; value: string; disabled: boolean; inline?: boolean; onChange: (value: string) => void }) {
  const name = `${useId()}-${props.name}`;
  return (
    <div className={cn("flex gap-1", props.inline ? "flex-row flex-wrap gap-x-4" : "flex-col")}>
      {props.options.map((option) => (
        <label key={option.value} className="flex items-start gap-2 text-sm">
          <input type="radio" className={cn(CHECK, "mt-0.5")} name={name} value={option.value} checked={props.value === option.value} disabled={props.disabled} onChange={() => props.onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function Slider(props: ControlProps<Extract<FormField, { kind: "slider" }>>) {
  const { field } = props;
  const value = asNumber(props.value);
  const shown = value ?? (field.min + field.max) / 2;
  const commit = (text: string) => props.onChange(readNumber(text));
  return (
    <Single {...props}>
      {(ids) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <input
              id={ids.inputId}
              {...ids.aria}
              type="range"
              className="h-5 min-w-0 flex-1 accent-foreground"
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              value={shown}
              aria-valuetext={value === null ? "not set" : withUnit(value, field.unit)}
              disabled={props.disabled}
              onChange={(event) => commit(event.target.value)}
              // A click or a key on the value it already shows sets it too.
              onPointerUp={(event) => commit(event.currentTarget.value)}
              onKeyUp={(event) => {
                if (event.key === "Enter" || event.key === " ") commit(event.currentTarget.value);
              }}
            />
            <output htmlFor={ids.inputId} className={cn("w-20 shrink-0 text-right text-sm tabular-nums", value === null && "text-muted-foreground")}>
              {value === null ? "not set" : withUnit(value, field.unit)}
            </output>
          </div>
          <div className="flex justify-between gap-2 pr-23 text-xs text-muted-foreground">
            <span>{field.minLabel ?? withUnit(field.min, field.unit)}</span>
            <span className="text-right">{field.maxLabel ?? withUnit(field.max, field.unit)}</span>
          </div>
        </div>
      )}
    </Single>
  );
}

function Scale(props: ControlProps<Extract<FormField, { kind: "scale" }>>) {
  const { field } = props;
  const { min, max } = scaleRange(field);
  const points = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  const name = useId();
  const value = asNumber(props.value);
  return (
    <FieldGroup {...props}>
      {() => (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-1">
            {points.map((point, index) => {
              const label = field.pointLabels?.[index];
              return (
                <label
                  key={point}
                  className={cn(
                    "flex min-w-9 cursor-pointer flex-col items-center gap-0.5 rounded-md border border-input px-2 py-1 text-sm has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                    value === point ? "border-foreground bg-state-active" : "hover:bg-state-hover",
                    props.disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input type="radio" className="sr-only" name={name} value={point} checked={value === point} disabled={props.disabled} onChange={() => props.onChange(point)} />
                  <span className="tabular-nums">{point}</span>
                  {label !== undefined && label !== "" && <span className="text-xs text-muted-foreground">{label}</span>}
                </label>
              );
            })}
          </div>
          {(field.minLabel || field.maxLabel) && (
            <div className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span>{field.minLabel ? `${min}: ${field.minLabel}` : ""}</span>
              <span className="text-right">{field.maxLabel ? `${max}: ${field.maxLabel}` : ""}</span>
            </div>
          )}
        </div>
      )}
    </FieldGroup>
  );
}

function Ranking(props: ControlProps<Extract<FormField, { kind: "ranking" }>>) {
  const { field } = props;
  const order = asStrings(props.value);
  const labelOf = (value: string) => field.items.find((item) => item.value === value)?.label ?? value;
  const move = (index: number, by: -1 | 1) => {
    const next = [...order];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    props.onChange(next);
  };
  return (
    <FieldGroup {...props}>
      {() => (
        <ol className="flex flex-col gap-1">
          {order.map((value, index) => (
            <li key={value} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm">
              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1">{labelOf(value)}</span>
              <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Move ${labelOf(value)} up`} disabled={props.disabled || index === 0} onClick={() => move(index, -1)}>
                <Icon name="ChevronUp" className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={`Move ${labelOf(value)} down`}
                disabled={props.disabled || index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                <Icon name="ChevronDown" className="size-4" />
              </Button>
            </li>
          ))}
        </ol>
      )}
    </FieldGroup>
  );
}

function Matching(props: ControlProps<Extract<FormField, { kind: "matching" }>>) {
  const { field } = props;
  const matches = props.value !== null && typeof props.value === "object" && !Array.isArray(props.value) ? (props.value as Record<string, string | null>) : {};
  const base = useId();
  return (
    <FieldGroup {...props}>
      {() => (
        <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 @sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {field.left.map((item, index) => {
            const id = `${base}-${index}`;
            const usedElsewhere = new Set(Object.entries(matches).flatMap(([left, right]) => (left !== item.value && right !== null ? [right] : [])));
            return (
              <Fragment key={item.value}>
                <label htmlFor={id} className="text-sm">
                  {item.label}
                </label>
                <select
                  id={id}
                  className={cn(CONTROL, "h-9 w-full px-2")}
                  value={matches[item.value] ?? ""}
                  disabled={props.disabled}
                  onChange={(event) => props.onChange({ ...matches, [item.value]: event.target.value === "" ? null : event.target.value })}
                >
                  <option value="">Choose…</option>
                  {field.right.map((option) => (
                    <option key={option.value} value={option.value} disabled={field.oneToOne === true && usedElsewhere.has(option.value)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Fragment>
            );
          })}
        </div>
      )}
    </FieldGroup>
  );
}

function List(props: ControlProps<Extract<FormField, { kind: "list" }>>) {
  const { field } = props;
  const entries = asStrings(props.value).length > 0 ? asStrings(props.value) : [""];
  const max = field.maxEntries ?? 12;
  const set = (next: string[]) => props.onChange(next);
  return (
    <FieldGroup {...props}>
      {() => (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                aria-label={`${field.label}, entry ${index + 1}`}
                className="bg-background text-sm"
                value={entry}
                placeholder={field.placeholder}
                maxLength={field.maxLength ?? 500}
                disabled={props.disabled}
                onChange={(event) => set(entries.map((each, at) => (at === index ? event.target.value : each)))}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                aria-label={`Remove entry ${index + 1}`}
                disabled={props.disabled || entries.length === 1}
                onClick={() => set(entries.filter((_, at) => at !== index))}
              >
                <Icon name="X" className="size-4" />
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" size="sm" variant="outline" disabled={props.disabled || entries.length >= max} onClick={() => set([...entries, ""])}>
              Add another
            </Button>
          </div>
        </div>
      )}
    </FieldGroup>
  );
}

function Table(props: ControlProps<Extract<FormField, { kind: "table" }>>) {
  const { field } = props;
  const table = props.value !== null && typeof props.value === "object" && !Array.isArray(props.value) ? (props.value as Record<string, Record<string, TableCell>>) : {};
  const setCell = (rowId: string, columnId: string, cell: TableCell) => props.onChange({ ...table, [rowId]: { ...(table[rowId] ?? {}), [columnId]: cell } });
  return (
    <FieldGroup {...props}>
      {() => (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <td />
                {field.columns.map((column) => (
                  <th key={column.id} scope="col" className="px-1.5 pb-1 text-left text-xs font-medium text-muted-foreground">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {field.rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <th scope="row" className="py-1 pr-2 text-left align-middle font-normal">
                    {row.label}
                  </th>
                  {field.columns.map((column) => (
                    <td key={column.id} className="px-1 py-1 align-middle">
                      <Cell column={column} label={`${row.label}, ${column.label}`} value={table[row.id]?.[column.id] ?? null} disabled={props.disabled} onChange={(cell) => setCell(row.id, column.id, cell)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FieldGroup>
  );
}

function Cell(props: { column: TableColumn; label: string; value: TableCell; disabled: boolean; onChange: (cell: TableCell) => void }) {
  const { column } = props;
  switch (column.control) {
    case "checkbox":
      return <input type="checkbox" aria-label={props.label} className={CHECK} checked={props.value === true} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />;
    case "choice":
      return (
        <select
          aria-label={props.label}
          className={cn(CONTROL, "h-8 w-full min-w-24 px-1.5")}
          value={typeof props.value === "string" ? props.value : ""}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">—</option>
          {(column.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <Input
          aria-label={props.label}
          type="number"
          inputMode="decimal"
          step="any"
          className="h-8 min-w-20 bg-background text-sm"
          value={typeof props.value === "number" ? props.value : ""}
          placeholder={column.placeholder}
          disabled={props.disabled}
          onChange={(event) => props.onChange(readNumber(event.target.value))}
        />
      );
    case "text":
      return (
        <Input
          aria-label={props.label}
          className="h-8 min-w-28 bg-background text-sm"
          value={typeof props.value === "string" ? props.value : ""}
          placeholder={column.placeholder}
          maxLength={500}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
      );
  }
}

// ── reading an answer back ──────────────────────────────────────────────────

/** A form answer as the transcript and the Learning tab show it: each part under its label, by section. */
export function AnswerView(props: { form: AnswerForm; fields: FormValues; workspace: Workspace | null; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", props.className)} data-answer-view="">
      {groups(props.form).map((group, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          {group.section !== null && <span className="font-medium">{group.section.title}</span>}
          <dl className="flex flex-col gap-1.5">
            {group.items.map((item) =>
              item.kind === "note" || item.kind === "section" ? null : (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd>
                    <ValueView field={item} value={props.fields[item.id] ?? null} />
                  </dd>
                </div>
              ),
            )}
          </dl>
        </div>
      ))}
    </div>
  );
}

function ValueView(props: { field: FormField; value: FieldValue }) {
  const { field, value } = props;
  if (!isAnswered(field, value)) return <span className="text-muted-foreground">No answer.</span>;
  if (field.kind === "code") return <pre className="overflow-x-auto rounded-md border border-border p-2 font-mono text-xs">{value as string}</pre>;
  if (field.kind === "table") {
    return (
      <div className="overflow-x-auto">
        <table className="border-collapse text-left">
          <thead>
            <tr>
              <td />
              {field.columns.map((column) => (
                <th key={column.id} scope="col" className="px-1.5 font-medium text-muted-foreground">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {field.rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <th scope="row" className="pr-2 font-normal">
                  {row.label}
                </th>
                {field.columns.map((column) => (
                  <td key={column.id} className="px-1.5">
                    {cellView(column, (value as Record<string, Record<string, TableCell>>)[row.id]?.[column.id] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const lines = describeValue(field, value);
  return lines.length === 1 ? <span className="whitespace-pre-wrap">{lines[0]}</span> : <span className="block whitespace-pre-wrap">{lines.join("\n")}</span>;
}

function cellView(column: TableColumn, cell: TableCell): string {
  if (column.control === "checkbox") return cell === true ? "✓" : "—";
  if (cell === null || cell === "") return "—";
  if (column.control === "choice") return column.options?.find((option) => option.value === cell)?.label ?? String(cell);
  return String(cell);
}
