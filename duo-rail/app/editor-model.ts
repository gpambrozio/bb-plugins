// The button editor's model: what each action is called, what a new one starts as, and the list edits.
// Pure, so the editor's rules are tested without rendering it.
import {
  joinArgs,
  MAX_BUTTONS,
  MAX_LABEL,
  MAX_MENU_ITEMS,
  NEW_THREAD_ICON,
  type ActionKind,
  type LeafAction,
  type LeafKind,
  type MenuItem,
  type RailAction,
  type RailButton,
} from "../shared/layout";
import { BB_ICON_NAMES } from "./icon-names";

export interface ActionChoice {
  kind: ActionKind;
  /** What the action picker shows. */
  title: string;
  /** What a new button of this kind is called and shows. */
  label: string;
  icon: string;
}

/** Every action a button can take, in the picker's order. Each one has an SDK route; see README.md for what bb does not expose. */
export const ACTION_CHOICES: readonly ActionChoice[] = [
  { kind: "back", title: "Go back", label: "Back", icon: "ArrowLeft" },
  { kind: "forward", title: "Go forward", label: "Forward", icon: "ArrowRight" },
  { kind: "newThread", title: "New thread", label: "New thread", icon: NEW_THREAD_ICON },
  { kind: "recentThreads", title: "Recent threads", label: "Recent threads", icon: "Clock" },
  { kind: "openThread", title: "Open a thread", label: "Thread", icon: "MessageSquare" },
  { kind: "openProject", title: "Open a project", label: "Project", icon: "Folder" },
  { kind: "threadAction", title: "Thread menu action, on the open thread", label: "Thread action", icon: "Zap" },
  { kind: "bbCommand", title: "Run a bb command (a plugin's or bb's)", label: "bb command", icon: "Terminal" },
  { kind: "openUrl", title: "Open a URL", label: "Link", icon: "Globe" },
  { kind: "reload", title: "Reload bb", label: "Reload bb", icon: "ArrowReloadHorizontal" },
  { kind: "menu", title: "Menu of its own items", label: "More", icon: "MoreHorizontal" },
];

/** What a menu item can do: anything but another menu. */
export const MENU_ITEM_CHOICES = ACTION_CHOICES.filter((choice): choice is ActionChoice & { kind: LeafKind } => choice.kind !== "menu");

export function choiceFor(kind: ActionKind): ActionChoice {
  const choice = ACTION_CHOICES.find((candidate) => candidate.kind === kind);
  if (choice === undefined) throw new Error(`duo-rail: no action called ${kind}`);
  return choice;
}

/** The symbols the icon picker offers: bb's New thread glyph first, then every name bb's host Icon draws. */
export const ICON_CHOICES: readonly string[] = [NEW_THREAD_ICON, ...BB_ICON_NAMES];

/** A symbol's name, as the picker reads it out and shows it on hover. */
export const iconLabel = (icon: string): string => (icon === NEW_THREAD_ICON ? "New thread" : icon);

/** Whether bb draws this symbol, rather than its generic bolt. */
export const isKnownIcon = (icon: string): boolean => ICON_CHOICES.includes(icon);

/**
 * What the picker lists for an entry whose symbol is `current`: every choice, plus, right after New
 * thread, a saved symbol bb's list lacks, so it still shows and stays selected.
 */
export function iconOptions(current: string): readonly string[] {
  if (isKnownIcon(current)) return ICON_CHOICES;
  return [NEW_THREAD_ICON, current, ...BB_ICON_NAMES];
}

/** The options whose name holds the query, ignoring case and the spaces around it, in their order. */
export function matchIcons(options: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter((icon) => iconLabel(icon).toLowerCase().includes(needle) || icon.toLowerCase().includes(needle));
}

/** What a new action of a kind starts as. The ones that name something start with the first on offer. */
export interface Offers {
  firstThreadId?: string;
  firstProjectId?: string;
  firstThreadActionKey?: string;
}

export function newLeafAction(kind: LeafKind, offers: Offers = {}): LeafAction {
  switch (kind) {
    case "back":
    case "forward":
    case "reload":
      return { kind };
    case "newThread":
      return { kind, projectId: null };
    case "openThread":
      return { kind, threadId: offers.firstThreadId ?? "" };
    case "openProject":
      return { kind, projectId: offers.firstProjectId ?? "" };
    case "recentThreads":
      return { kind, count: 5 };
    case "threadAction":
      return { kind, key: offers.firstThreadActionKey ?? "" };
    case "bbCommand":
      // Empty, so the command picker starts with every command on offer.
      return { kind, args: [] };
    case "openUrl":
      return { kind, url: "https://" };
  }
}

export function newAction(kind: ActionKind, offers: Offers = {}): RailAction {
  if (kind === "menu") return { kind, items: [newMenuItem([], "recentThreads", offers)] };
  return newLeafAction(kind, offers);
}

/** `base`, or `base-2`, `base-3`…: the first not already taken. */
export function uniqueId(base: string, taken: readonly { id: string }[]): string {
  const ids = new Set(taken.map((entry) => entry.id));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n += 1) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function newButton(existing: readonly RailButton[], kind: ActionKind, offers: Offers = {}): RailButton {
  const choice = choiceFor(kind);
  return { id: uniqueId(kind, existing), label: choice.label, icon: choice.icon, action: newAction(kind, offers) };
}

export function newMenuItem(existing: readonly MenuItem[], kind: LeafKind, offers: Offers = {}): MenuItem {
  const choice = choiceFor(kind);
  return { id: uniqueId(kind, existing), label: choice.label, icon: choice.icon, action: newLeafAction(kind, offers) };
}

const fitLabel = (text: string) => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1).trimEnd()}…` : text);

/** The command words of a `bb` command: what comes before its first option or placeholder. */
export function commandWords(args: readonly string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (!/^[A-Za-z0-9][\w.-]*$/.test(arg)) break;
    words.push(arg);
  }
  return words.join(" ");
}

/** The name an action's pick suggests (the thread's title, the command…), or null when it suggests none. */
export function suggestedLabel(action: RailAction, names: Names): string | null {
  switch (action.kind) {
    case "bbCommand":
      return commandWords(action.args) || null;
    case "openThread":
      return names.thread(action.threadId) ?? null;
    case "openProject":
      return names.project(action.projectId) ?? null;
    case "newThread": {
      const project = action.projectId === null ? undefined : names.project(action.projectId);
      return project === undefined ? null : `New thread in ${project}`;
    }
    case "threadAction":
      return names.threadAction(action.key) ?? null;
    case "openUrl":
      try {
        return new URL(action.url).hostname || null;
      } catch {
        return null;
      }
    default:
      return null;
  }
}

/** The name an action gives a button the owner has not named: its pick's, or its kind's. */
function automaticLabel(action: RailAction, names: Names): string {
  return fitLabel(suggestedLabel(action, names) ?? choiceFor(action.kind).label);
}

/** Whether the owner named the entry: its name is neither its kind's default nor what its pick suggests. */
export function hasOwnLabel(entry: RailButton | MenuItem, names: Names): boolean {
  return entry.label !== choiceFor(entry.action.kind).label && entry.label !== automaticLabel(entry.action, names);
}

/** An entry with a changed action of the same kind. Its name follows the pick unless the owner named it. */
export function withAction<T extends RailButton | MenuItem>(entry: T, action: T["action"], names: Names): T {
  return { ...entry, action, label: hasOwnLabel(entry, names) ? entry.label : automaticLabel(action, names) };
}

/**
 * A button or item given another kind of action. Its name and symbol follow the new kind while the
 * owner has not chosen their own; once they have, they stay.
 */
export function withKind<T extends RailButton | MenuItem>(entry: T, kind: T["action"]["kind"], offers: Offers = {}, names: Names = NO_NAMES): T {
  if (entry.action.kind === kind) return entry;
  const before = choiceFor(entry.action.kind);
  const after = choiceFor(kind);
  // A button's kind may be a menu; an item's never is (the editor offers items no menu).
  const action = newAction(kind, offers) as T["action"];
  return {
    ...entry,
    label: hasOwnLabel(entry, names) ? entry.label : automaticLabel(action, names),
    icon: entry.icon === before.icon ? after.icon : entry.icon,
    action,
  };
}

export function canAddButton(buttons: readonly RailButton[]): boolean {
  return buttons.length < MAX_BUTTONS;
}

export function canAddMenuItem(items: readonly MenuItem[]): boolean {
  return items.length < MAX_MENU_ITEMS;
}

export function moveAt<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved as T);
  return next;
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, at) => at !== index);
}

export function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  return list.map((entry, at) => (at === index ? value : entry));
}

/** Names the editor knows things by; an id it cannot name is shown as is. */
export interface Names {
  thread(id: string): string | undefined;
  project(id: string): string | undefined;
  threadAction(key: string): string | undefined;
}

const NO_NAMES: Names = { thread: () => undefined, project: () => undefined, threadAction: () => undefined };

/** One line saying what an action does, for the button list. */
export function describeAction(action: RailAction, names: Names): string {
  switch (action.kind) {
    case "back":
      return "Goes back";
    case "forward":
      return "Goes forward";
    case "reload":
      return "Reloads bb";
    case "newThread":
      return action.projectId === null ? "Opens bb's New thread screen" : `New thread in ${names.project(action.projectId) ?? action.projectId}`;
    case "openThread":
      return action.threadId === "" ? "Opens a thread (pick one)" : `Opens ${names.thread(action.threadId) ?? "a thread that is no longer listed"}`;
    case "openProject":
      return action.projectId === "" ? "Opens a project (pick one)" : `Opens ${names.project(action.projectId) ?? "a project that is no longer listed"}`;
    case "recentThreads":
      return `The ${action.count} most recent threads`;
    case "threadAction":
      return action.key === "" ? "A thread menu action (pick one)" : `${names.threadAction(action.key) ?? action.key}, on the open thread`;
    case "bbCommand":
      return action.args.length === 0 ? "Runs a bb command (type one)" : `Runs bb ${joinArgs(action.args)}`;
    case "openUrl":
      return `Opens ${action.url}`;
    case "menu":
      return `A menu: ${action.items.map((item) => item.label).join(", ")}`;
  }
}
