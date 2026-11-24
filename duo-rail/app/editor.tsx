// The Buttons section of Duo Rail's settings page: which buttons each display's rail shows, in what
// order, with what symbol, and what each does. It edits a draft and saves it to the `layout` setting,
// which lives on the bb server, so the rail on every device follows it.
import {
  experimental_usePluginId,
  experimental_useSidebarThreads,
  experimental_useThreadActionRegistrations,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import {
  DISPLAY_LABELS,
  DISPLAYS,
  defaultLayout,
  joinArgs,
  layoutProblem,
  MAX_LABEL,
  MAX_RECENT_THREADS,
  parseLayout,
  serializeLayout,
  splitArgs,
  type Display,
  type Layout,
  type LeafAction,
  type MenuItem,
  type RailButton,
} from "../shared/layout";
import { LAYOUT_SETTING } from "../shared/settings";
import {
  ACTION_CHOICES,
  canAddButton,
  canAddMenuItem,
  describeAction,
  ICON_CHOICES,
  MENU_ITEM_CHOICES,
  moveAt,
  newButton,
  newMenuItem,
  removeAt,
  replaceAt,
  withKind,
  type ActionChoice,
  type Names,
  type Offers,
} from "./editor-model";
import { ActionIcon } from "./rail";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Choices {
  projects: readonly { id: string; name: string }[];
  threads: readonly { id: string; title: string }[];
  threadActions: readonly { key: string; title: string }[];
  cliCommands: readonly { name: string; summary: string }[];
  offers: Offers;
  names: Names;
}

/** What the pickers offer: the owner's projects, threads, bb's thread-menu actions and plugin commands. */
function useChoices(): Choices {
  const sdk = useSdk();
  const { threads: sidebar } = experimental_useSidebarThreads();
  const registrations = experimental_useThreadActionRegistrations();
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const [cliCommands, setCliCommands] = useState<readonly { name: string; summary: string }[]>([]);
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
      .catch((error: unknown) => console.warn("duo-rail: could not list plugin commands", error));
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
      offers: { firstThreadId: threads[0]?.id, firstProjectId: projects[0]?.id, firstThreadActionKey: threadActions[0]?.key, firstCliCommand: cliCommands[0]?.name },
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

/** A select that keeps a value it no longer offers, named as such, so opening the editor changes nothing. */
function PickOne({ id, value, options, missing, onChange }: { id: string; value: string; options: readonly { value: string; label: string }[]; missing: string; onChange(value: string): void }) {
  const known = value === "" || options.some((option) => option.value === value);
  return (
    <select id={id} className={SELECT_CLASS} value={value} onChange={(event) => onChange(event.target.value)}>
      {value === "" && <option value="">Pick one…</option>}
      {!known && <option value={value}>{missing}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function CommandField({ args, cliCommands, onChange }: { args: readonly string[]; cliCommands: Choices["cliCommands"]; onChange(args: string[]): void }) {
  // The text as typed, so quotes and spaces stay while the owner types; the words are what is saved.
  const [text, setText] = useState(() => joinArgs(args));
  const list = useId();
  return (
    <Field
      label="Command, after bb"
      hint="Runs on the bb server's machine with the bb command-line tool, and its last lines show in a notice. Plugin commands are listed as you type."
    >
      {(id) => (
        <>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">bb</span>
            <Input
              id={id}
              className="font-mono"
              list={list}
              placeholder="herald say 'Hello'"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                onChange(splitArgs(event.target.value));
              }}
            />
          </div>
          <datalist id={list}>
            {cliCommands.map((command) => (
              <option key={command.name} value={command.name}>
                {command.summary}
              </option>
            ))}
          </datalist>
        </>
      )}
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

function IconPicker({ value, onChange }: { value: string; onChange(icon: string): void }) {
  return (
    <div role="radiogroup" aria-label="Symbol" className="flex flex-wrap gap-1">
      {ICON_CHOICES.map((icon) => (
        <Button
          key={icon}
          type="button"
          variant="ghost"
          size="icon"
          role="radio"
          aria-checked={value === icon}
          aria-label={icon === ICON_CHOICES[0] ? "New thread" : icon}
          className={cn("size-9", value === icon && "bg-state-active ring-1 ring-ring")}
          onClick={() => onChange(icon)}
        >
          <ActionIcon icon={icon} />
        </Button>
      ))}
    </div>
  );
}

type Entry = RailButton | MenuItem;

function EntryEditor<T extends Entry>({ entry, kinds, choices, onChange }: { entry: T; kinds: readonly ActionChoice[]; choices: Choices; onChange(entry: T): void }) {
  const { action } = entry;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <Field label="Name" hint="Read out by VoiceOver; the button itself shows only its symbol.">
        {(id) => <Input id={id} maxLength={MAX_LABEL} value={entry.label} onChange={(event) => onChange({ ...entry, label: event.target.value })} />}
      </Field>
      <Field label="Symbol">{() => <IconPicker value={entry.icon} onChange={(icon) => onChange({ ...entry, icon })} />}</Field>
      <Field label="Action">
        {(id) => (
          <select
            id={id}
            className={SELECT_CLASS}
            value={action.kind}
            onChange={(event) => onChange(withKind(entry, event.target.value as T["action"]["kind"], choices.offers))}
          >
            {kinds.map((kind) => (
              <option key={kind.kind} value={kind.kind}>
                {kind.title}
              </option>
            ))}
          </select>
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
          onAdd={() => onChange({ ...entry, action: { ...action, items: [...action.items, newMenuItem(action.items, "forward", choices.offers)] } })}
          canRemoveLast={false}
        />
      ) : (
        <ActionFields action={action} choices={choices} onChange={(next) => onChange({ ...entry, action: next } as T)} />
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
  onAdd(): void;
}) {
  const [open, setOpen] = useState<string | null>(null);
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
            {open === entry.id && <EntryEditor entry={entry} kinds={kinds} choices={choices} onChange={(next) => onChange(replaceAt(entries, index, next))} />}
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={onAdd}>
          <Icon name="Plus" />
          Add {what}
        </Button>
      </div>
    </div>
  );
}

export function ButtonsEditor() {
  const settings = useSettings();
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const choices = useChoices();
  const stored = useMemo(() => parseLayout(settings.values?.[LAYOUT_SETTING]), [settings.values]);
  const storedText = serializeLayout(stored.layout);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [display, setDisplay] = useState<Display>("folded");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const current = draft ?? stored.layout;
  const draftText = serializeLayout(current);
  const dirty = draft !== null && draftText !== storedText;
  const problem = dirty ? layoutProblem(draftText) : null;
  const other: Display = display === "folded" ? "unfolded" : "folded";

  // Once saved (or saved elsewhere to the same thing), the draft is the stored layout again.
  useEffect(() => {
    if (draft !== null && serializeLayout(draft) === storedText) setDraft(null);
  }, [draft, storedText]);

  const setButtons = (buttons: RailButton[]) => {
    setSaveError(null);
    setDraft({ ...current, [display]: { buttons } });
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await sdk.plugins.updateSettings({ pluginId, values: { [LAYOUT_SETTING]: draftText } });
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (settings.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" className="animate-spin" /> Loading…
      </div>
    );
  }

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
          The saved layout could not be read, so the rail shows the default: {stored.problem}
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
        onAdd={() => setButtons([...buttons, newButton(buttons, "newThread", choices.offers)])}
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
    </div>
  );
}
