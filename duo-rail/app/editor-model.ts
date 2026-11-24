// The button editor's model: what each action is called, what a new one starts as, and the list edits.
// Pure, so the editor's rules are tested without rendering it.
import {
  joinArgs,
  MAX_BUTTONS,
  MAX_MENU_ITEMS,
  NEW_THREAD_ICON,
  type ActionKind,
  type LeafAction,
  type LeafKind,
  type MenuItem,
  type RailAction,
  type RailButton,
} from "../shared/layout";

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

/** The symbols the icon picker offers: bb's New thread glyph and bb icons that suit a button. */
export const ICON_CHOICES: readonly string[] = [
  NEW_THREAD_ICON,
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "ArrowTurnBackward",
  "ArrowTurnForward",
  "ArrowReloadHorizontal",
  "MoreHorizontal",
  "Plus",
  "MessageSquare",
  "MessageSquarePlus",
  "MessageQuestion",
  "Clock",
  "Folder",
  "FolderOpen",
  "Zap",
  "Star",
  "Pin",
  "Archive",
  "Check",
  "Bot",
  "Brain",
  "Terminal",
  "Code",
  "Globe",
  "ExternalLink",
  "Github",
  "GitPullRequest",
  "GitBranch",
  "Play",
  "Pause",
  "Mic",
  "Mail",
  "Calendar",
  "BellDot",
  "Eye",
  "Search",
  "Settings",
  "Smartphone",
  "Laptop",
  "ListTodo",
  "Workflow",
  "Puzzle",
  "Palette",
  "Coffee",
];

/** What a new action of a kind starts as. The ones that name something start with the first on offer. */
export interface Offers {
  firstThreadId?: string;
  firstProjectId?: string;
  firstThreadActionKey?: string;
  firstCliCommand?: string;
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
      return { kind, args: offers.firstCliCommand === undefined ? [] : [offers.firstCliCommand] };
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

/**
 * A button or item given another kind of action. Its label and icon follow the new kind while they
 * are still the old kind's defaults; once the owner changed them, they stay.
 */
export function withKind<T extends RailButton | MenuItem>(entry: T, kind: T["action"]["kind"], offers: Offers = {}): T {
  if (entry.action.kind === kind) return entry;
  const before = choiceFor(entry.action.kind);
  const after = choiceFor(kind);
  return {
    ...entry,
    label: entry.label === before.label ? after.label : entry.label,
    icon: entry.icon === before.icon ? after.icon : entry.icon,
    // A button's kind may be a menu; an item's never is (the editor offers items no menu).
    action: newAction(kind, offers) as T["action"],
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
