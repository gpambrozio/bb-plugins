// The Buttons section of Duo Rail's settings page: which buttons each display's rail shows, in what
// order, with what symbol, and what each does. It edits a draft and saves it through the plugin's
// `layout.set` RPC into the plugin's storage on the bb server, so the rail on every device follows it.
import {
  experimental_copyToClipboard,
  experimental_useSidebarThreads,
  experimental_useThreadActionRegistrations,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";

import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import {
  DISPLAY_LABELS,
  DISPLAYS,
  defaultLayout,
  layoutProblem,
  MAX_LABEL,
  MAX_RECENT_THREADS,
  parseLayout,
  serializeLayout,
  type Display,
  type Layout,
  type LeafAction,
  type MenuItem,
  type RailButton,
} from "../shared/layout";
import type { RpcContract } from "../shared/contract";
import {
  ACTION_CHOICES,
  canAddButton,
  canAddMenuItem,
  describeAction,
  ICON_CHOICES,
  iconLabel,
  iconOptions,
  isKnownIcon,
  matchIcons,
  MENU_ITEM_CHOICES,
  moveAt,
  newButton,
  newMenuItem,
  removeAt,
  replaceAt,
  withAction,
  withKind,
  type ActionChoice,
  type Names,
  type Offers,
} from "./editor-model";
import { CommandPicker } from "./command-picker";
import { useStoredLayout } from "./stored-layout";
import { ActionIcon } from "./rail";

/**
 * A dropdown's box. The browser's own chevron sits a few points from the right border, closer than the text
 * is to the left one, so it is hidden (`appearance-none`) and `Select` draws bb's: its glyph 13 pt from the
 * right border, as the text is from the left (border and 12 pt padding), with the right padding (32 pt)
 * keeping long text clear of it.
 */
const SELECT_CLASS =
  "h-9 w-full appearance-none truncate rounded-md border border-input bg-transparent pl-3 pr-8 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * A native select with bb's chevron, inset from the right border as far as its text is from the left. bb's
 * 16 pt icon draws its chevron with 4 pt to spare on each side, so the box sits 9 pt in.
 */
function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select {...props} className={cn(SELECT_CLASS, className)}>
        {children}
      </select>
      <span
        aria-hidden="true"
        data-testid="duo-rail-select-chevron"
        className="pointer-events-none absolute inset-y-0 right-[9px] flex items-center text-muted-foreground [&_[data-icon-root]]:size-4"
      >
        <Icon name="ChevronDown" />
      </span>
    </div>
  );
}

interface Choices {
  projects: readonly { id: string; name: string }[];
  threads: readonly { id: string; title: string }[];
  threadActions: readonly { key: string; title: string }[];
  /** The installed plugins' commands; null while they load. */
  cliCommands: readonly { name: string; summary: string }[] | null;
  offers: Offers;
  names: Names;
}

/** What the pickers offer: the owner's projects, threads, bb's thread-menu actions and plugin commands. */
function useChoices(): Choices {
  const sdk = useSdk();
  const { threads: sidebar } = experimental_useSidebarThreads();
  const registrations = experimental_useThreadActionRegistrations();
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const [cliCommands, setCliCommands] = useState<readonly { name: string; summary: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    sdk.projects
      .list({ includePersonal: true })
      .then((list) => live && setProjects(list.map((project) => ({ id: project.id, name: project.name }))))
      .catch((error: unknown) => console.warn("duo-rail: could not list projects", error));
    sdk.plugins
      .list()
      .then(
        (result) =>
          live &&
          setCliCommands(
            result.plugins.flatMap((plugin) => (plugin.enabled && plugin.cliCommand !== null ? [{ name: plugin.cliCommand.name, summary: plugin.cliCommand.summary }] : [])),
          ),
      )
      .catch((error: unknown) => {
        console.warn("duo-rail: could not list plugin commands", error);
        if (live) setCliCommands([]);
      });
    return () => {
      live = false;
    };
  }, [sdk]);
  return useMemo(() => {
    const threads = sidebar.filter((thread) => !thread.isHidden && !thread.isArchived).map((thread) => ({ id: thread.id, title: thread.displayTitle }));
    const threadActions = registrations.map((registration) => ({ key: registration.key, title: registration.title }));
    return {
      projects,
      threads,
      threadActions,
      cliCommands,
      offers: { firstThreadId: threads[0]?.id, firstProjectId: projects[0]?.id, firstThreadActionKey: threadActions[0]?.key },
      names: {
        thread: (id) => threads.find((thread) => thread.id === id)?.title,
        project: (id) => projects.find((project) => project.id === id)?.name,
        threadAction: (key) => threadActions.find((action) => action.key === key)?.title,
      },
    };
  }, [sidebar, registrations, projects, cliCommands]);
}

function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children(id)}
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * A select that keeps a value it no longer offers, named as such, so opening the editor changes nothing.
 * With `none`, the empty value is a real choice, always offered under that name (New thread's "bb's
 * choice"); without, it is only the "Pick one…" a required pick starts from.
 */
function PickOne({
  id,
  value,
  options,
  missing,
  none,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  missing: string;
  none?: string;
  onChange(value: string): void;
}) {
  const known = value === "" || options.some((option) => option.value === value);
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {none !== undefined ? <option value="">{none}</option> : value === "" && <option value="">Pick one…</option>}
      {!known && <option value={value}>{missing}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

function CommandField({ args, cliCommands, onChange }: { args: readonly string[]; cliCommands: Choices["cliCommands"]; onChange(args: string[]): void }) {
  return (
    <Field
      label="Command, after bb"
      hint="Pick from every installed plugin's commands and bb's own, or type one with its arguments. It runs on the bb server's machine with bb's command-line tool, and its last lines show in a notice."
    >
      {(id) => <CommandPicker id={id} args={args} plugins={cliCommands} onChange={onChange} />}
    </Field>
  );
}

function ActionFields({ action, choices, onChange }: { action: LeafAction; choices: Choices; onChange(action: LeafAction): void }) {
  const projectOptions = choices.projects.map((project) => ({ value: project.id, label: project.name }));
  switch (action.kind) {
    case "back":
    case "forward":
    case "reload":
      return null;
    case "newThread":
      return (
        <Field label="Project">
          {(id) => (
            <PickOne
              id={id}
              value={action.projectId ?? ""}
              options={projectOptions}
              missing="A project that is no longer listed"
              none="bb's choice (the project bb would pick)"
              onChange={(value) => onChange({ ...action, projectId: value === "" ? null : value })}
            />
          )}
        </Field>
      );
    case "openThread":
      return (
        <Field label="Thread">
          {(id) => (
            <PickOne
              id={id}
              value={action.threadId}
              options={choices.threads.map((thread) => ({ value: thread.id, label: thread.title }))}
              missing="A thread that is no longer listed"
              onChange={(threadId) => onChange({ ...action, threadId })}
            />
          )}
        </Field>
      );
    case "openProject":
      return (
        <Field label="Project">
          {(id) => <PickOne id={id} value={action.projectId} options={projectOptions} missing="A project that is no longer listed" onChange={(projectId) => onChange({ ...action, projectId })} />}
        </Field>
      );
    case "recentThreads":
      return (
        <Field label="How many threads">
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_RECENT_THREADS}
              value={action.count}
              onChange={(event) => onChange({ ...action, count: Math.min(MAX_RECENT_THREADS, Math.max(1, Math.round(Number(event.target.value) || 1))) })}
            />
          )}
        </Field>
      );
    case "threadAction":
      return (
        <Field label="Action from bb's thread menu" hint="Runs on the thread in view; the button is greyed out where no thread is open or the action does not apply.">
          {(id) => (
            <PickOne
              id={id}
              value={action.key}
              options={choices.threadActions.map((entry) => ({ value: entry.key, label: entry.title }))}
              missing={`${action.key} (not installed here)`}
              onChange={(key) => onChange({ ...action, key })}
            />
          )}
        </Field>
      );
    case "bbCommand":
      return <CommandField args={action.args} cliCommands={choices.cliCommands} onChange={(args) => onChange({ ...action, args })} />;
    case "openUrl":
      return (
        <Field label="Address" hint="A web address opens in bb's browser, as your bb settings say; an app link asks first.">
          {(id) => <Input id={id} type="url" inputMode="url" value={action.url} onChange={(event) => onChange({ ...action, url: event.target.value })} />}
        </Field>
      );
  }
}

/** A symbol's cell: at least 36 pt, and 44 pt on a phone, like the editor's other targets there. */
const ICON_CELL_CLASS =
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_[data-icon-root]]:size-4 max-md:pointer-coarse:size-11 max-md:pointer-coarse:[&_[data-icon-root]]:size-5";

/** The button beside the Name box that shows the symbol and opens the picker: as tall as the box. */
const ICON_TRIGGER_CLASS =
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-transparent text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active [&_[data-icon-root]]:size-5 max-md:pointer-coarse:size-10";

/** Brings the choice into view inside the grid, and moves nothing else on the page (see the root AGENTS.md). */
export function revealWithin(grid: HTMLElement, cell: HTMLElement) {
  const top = cell.offsetTop;
  const bottom = top + cell.offsetHeight;
  if (top >= grid.scrollTop && bottom <= grid.scrollTop + grid.clientHeight) return;
  grid.scrollTop = Math.max(0, top - (grid.clientHeight - cell.offsetHeight) / 2);
}

/** A symbol's name as the picker says it; a saved name bb does not have is marked as such. */
const symbolLabel = (icon: string): string => (isKnownIcon(icon) ? iconLabel(icon) : `${icon} (not one of bb's symbols)`);

/**
 * Every symbol bb draws, in a scrollable grid under a search box. The current choice is highlighted and
 * scrolled into the grid's view when it opens; a saved symbol bb no longer has still shows.
 */
function SymbolGrid({ value, searchRef, onPick }: { value: string; searchRef: RefObject<HTMLInputElement | null>; onPick(icon: string): void }) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => iconOptions(value), [value]);
  const shown = useMemo(() => matchIcons(options, query), [options, query]);
  const grid = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = grid.current;
    const selected = element?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (element != null && selected != null) revealWithin(element, selected);
    // Only when it mounts, which is each time the picker opens (`IconPicker` keys it).
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <Input
        ref={searchRef}
        type="search"
        aria-label="Search symbols"
        placeholder={`Search ${ICON_CHOICES.length} symbols`}
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        ref={grid}
        role="radiogroup"
        aria-label="Symbol"
        data-testid="duo-rail-icon-grid"
        className="relative flex max-h-60 flex-wrap content-start gap-1 overflow-y-auto p-1 max-md:max-h-[50vh]"
      >
        {shown.map((icon) => {
          const label = symbolLabel(icon);
          return (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={value === icon}
              aria-label={label}
              title={label}
              className={cn(ICON_CELL_CLASS, value === icon && "bg-state-active ring-1 ring-ring")}
              onClick={() => onPick(icon)}
            >
              <ActionIcon icon={icon} />
            </button>
          );
        })}
        {shown.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No symbol is called that.</p>}
      </div>
    </div>
  );
}

/**
 * The symbol, as a button beside the Name box; it opens the grid in a popover (bb's sheet on a phone),
 * which closes on a pick.
 */
function IconPicker({ id, value, onChange }: { id: string; value: string; onChange(icon: string): void }) {
  const [open, setOpen] = useState(false);
  // bb's sheet keeps its content mounted once shown, so each opening gets a fresh grid: an empty search,
  // and the choice brought into view again.
  const [opening, setOpening] = useState(0);
  const search = useRef<HTMLInputElement | null>(null);
  const label = symbolLabel(value);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpening((count) => count + 1);
        setOpen(next);
      }}
    >
      <PopoverTrigger id={id} type="button" className={ICON_TRIGGER_CLASS} aria-label={`Symbol: ${label}`} title={label}>
        <ActionIcon icon={value} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        mobileTitle="Symbol"
        autoFocusRef={search}
        className="w-[23rem] max-w-[var(--radix-popover-content-available-width)] p-2 max-md:px-4 max-md:pb-4"
      >
        <SymbolGrid
          key={opening}
          value={value}
          searchRef={search}
          onPick={(icon) => {
            onChange(icon);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

type Entry = RailButton | MenuItem;

function EntryEditor<T extends Entry>({
  entry,
  kinds,
  choices,
  focusName,
  onChange,
}: {
  entry: T;
  kinds: readonly ActionChoice[];
  choices: Choices;
  /** Just added: the owner starts by naming it. */
  focusName: boolean;
  onChange(entry: T): void;
}) {
  const { action } = entry;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Name" hint="Read out by VoiceOver; the button itself shows only its symbol.">
            {(id) => <Input id={id} autoFocus={focusName} maxLength={MAX_LABEL} value={entry.label} onChange={(event) => onChange({ ...entry, label: event.target.value })} />}
          </Field>
        </div>
        <Field label="Symbol">{(id) => <IconPicker id={id} value={entry.icon} onChange={(icon) => onChange({ ...entry, icon })} />}</Field>
      </div>
      <Field label="Action">
        {(id) => (
          <Select
            id={id}
            value={action.kind}
            onChange={(event) => onChange(withKind(entry, event.target.value as T["action"]["kind"], choices.offers, choices.names))}
          >
            {kinds.map((kind) => (
              <option key={kind.kind} value={kind.kind}>
                {kind.title}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {action.kind === "menu" ? (
        <EntryList
          what="menu item"
          entries={action.items}
          kinds={MENU_ITEM_CHOICES}
          choices={choices}
          canAdd={canAddMenuItem(action.items)}
          onChange={(items) => onChange({ ...entry, action: { ...action, items } })}
          onAdd={() => {
            const item = newMenuItem(action.items, "forward", choices.offers);
            onChange({ ...entry, action: { ...action, items: [...action.items, item] } });
            return item.id;
          }}
          canRemoveLast={false}
        />
      ) : (
        <ActionFields action={action} choices={choices} onChange={(next) => onChange(withAction(entry, next as T["action"], choices.names))} />
      )}
    </div>
  );
}

function EntryList<T extends Entry>({
  what,
  entries,
  kinds,
  choices,
  canAdd,
  canRemoveLast,
  onChange,
  onAdd,
}: {
  what: string;
  entries: readonly T[];
  kinds: readonly ActionChoice[];
  choices: Choices;
  canAdd: boolean;
  canRemoveLast: boolean;
  onChange(entries: T[]): void;
  /** Adds an entry and returns its id, which opens for editing. */
  onAdd(): string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2" aria-label={what === "button" ? "Buttons" : "Menu items"}>
        {entries.map((entry, index) => (
          <li key={entry.id} aria-label={entry.label} className="flex flex-col gap-2 rounded-md border border-border bg-card p-2">
            <div className="flex items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center text-foreground/80 [&_[data-icon-root]]:size-5 [&_svg]:size-5">
                <ActionIcon icon={entry.icon} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{entry.label || "(no name)"}</span>
                <span className="truncate text-xs text-muted-foreground">{describeAction(entry.action, choices.names)}</span>
              </span>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Move ${entry.label} up`} disabled={index === 0} onClick={() => onChange(moveAt(entries, index, -1))}>
                <Icon name="ArrowUp" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Move ${entry.label} down`}
                disabled={index === entries.length - 1}
                onClick={() => onChange(moveAt(entries, index, 1))}
              >
                <Icon name="ArrowDown" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Edit ${entry.label}`}
                aria-expanded={open === entry.id}
                onClick={() => setOpen(open === entry.id ? null : entry.id)}
              >
                <Icon name="Edit" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Remove ${entry.label}`}
                disabled={!canRemoveLast && entries.length === 1}
                onClick={() => onChange(removeAt(entries, index))}
              >
                <Icon name="Trash2" />
              </Button>
            </div>
            {open === entry.id && (
              <EntryEditor entry={entry} kinds={kinds} choices={choices} focusName={added === entry.id} onChange={(next) => onChange(replaceAt(entries, index, next))} />
            )}
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAdd}
          onClick={() => {
            const id = onAdd();
            setOpen(id);
            setAdded(id);
          }}
        >
          <Icon name="Plus" />
          Add {what}
        </Button>
      </div>
    </div>
  );
}

/** Copy a layout to another bb, or bring one in: the layout as JSON, through the clipboard or pasted. */
function ExportImport({ current, onImport }: { current: Layout; onImport(layout: Layout): void }) {
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const problem = text.trim() === "" ? null : layoutProblem(text);
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            void experimental_copyToClipboard({ text: JSON.stringify(current, null, 2) }).then((copied) =>
              setNote(copied ? "Copied both displays' buttons. Paste them into Import on another bb." : "Could not copy to the clipboard."),
            )
          }
        >
          Export
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-expanded={importing} onClick={() => setImporting(!importing)}>
          Import…
        </Button>
        {note !== null && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {importing && (
        <div className="flex flex-col gap-2">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            A layout exported from Duo Rail. It replaces both displays' buttons here; Save keeps it.
          </label>
          <textarea
            id={id}
            className="min-h-24 rounded-md border border-input bg-transparent p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {problem !== null && <span className="text-xs text-destructive">{problem}</span>}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={text.trim() === "" || problem !== null}
              onClick={() => {
                onImport(parseLayout(text).layout);
                setImporting(false);
                setText("");
              }}
            >
              Use this layout
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ButtonsEditor() {
  const rpc = useRpc<RpcContract>();
  const choices = useChoices();
  const stored = useStoredLayout();
  const storedText = stored.layout === null ? null : serializeLayout(stored.layout);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [display, setDisplay] = useState<Display>("folded");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Once saved (or saved elsewhere to the same thing), the draft is the stored layout again.
  useEffect(() => {
    if (draft !== null && serializeLayout(draft) === storedText) setDraft(null);
  }, [draft, storedText]);

  if (stored.layout === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" className="animate-spin" /> Loading…
      </div>
    );
  }

  const current = draft ?? stored.layout;
  const draftText = serializeLayout(current);
  const dirty = draft !== null && draftText !== storedText;
  const problem = dirty ? layoutProblem(draftText) : null;
  const other: Display = display === "folded" ? "unfolded" : "folded";

  const setButtons = (buttons: RailButton[]) => {
    setSaveError(null);
    setDraft({ ...current, [display]: { buttons } });
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await rpc.call("layout.set", { layout: current });
      await stored.refetch();
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const buttons = current[display].buttons;
  return (
    <div className="flex flex-col gap-3" data-testid="duo-rail-editor">
      <div role="tablist" aria-label="Display" className="flex items-center gap-1">
        {DISPLAYS.map((option) => (
          <Button key={option} type="button" role="tab" variant="ghost" size="sm" aria-selected={display === option} aria-pressed={display === option} onClick={() => setDisplay(option)}>
            {DISPLAY_LABELS[option]}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {display === "folded"
          ? "The buttons on the folded cover screen, top to bottom."
          : "The buttons on the unfolded display, top to bottom."}{" "}
        Search, the sidebar, bb's own pages and the command palette are not offered: bb gives plugins no way to open them.
      </p>
      {stored.problem !== null && draft === null && (
        <p role="alert" className="text-xs text-destructive">
          {stored.problem}
        </p>
      )}
      <EntryList
        what="button"
        entries={buttons}
        kinds={ACTION_CHOICES}
        choices={choices}
        canAdd={canAddButton(buttons)}
        canRemoveLast
        onChange={setButtons}
        onAdd={() => {
          const button = newButton(buttons, "newThread", choices.offers);
          setButtons([...buttons, button]);
          return button.id;
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setButtons(structuredClone(current[other].buttons))}>
          Copy the {DISPLAY_LABELS[other].toLowerCase()} buttons
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setButtons(defaultLayout()[display].buttons)}>
          Back to the default buttons
        </Button>
      </div>
      {buttons.length === 0 && <p className="text-xs text-muted-foreground">With no buttons, the rail does not show on this display.</p>}
      {(problem ?? saveError) !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem ?? saveError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!dirty || problem !== null || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(null)}>
          Discard changes
        </Button>
        {!dirty && <span className="text-xs text-muted-foreground">Saved. The rail on every device follows it.</span>}
      </div>
      <ExportImport
        current={current}
        onImport={(layout) => {
          setSaveError(null);
          setDraft(layout);
        }}
      />
    </div>
  );
}
