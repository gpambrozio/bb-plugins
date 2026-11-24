// The owner's buttons: which ones the rail shows on each display, in what order, and what each does.
//
// Stored in the plugin's key-value store on the bb server (server/layout-store.ts), so it follows the
// owner to every device; the app reads and writes it through the plugin's RPCs (contract.ts), which
// validate it with `layoutSchema`. `parseLayout` reads the text form, as the editor's Import and the old
// `layout` setting hold it, and never throws.
//
// No SDK import: the app imports this at run time (see app/imports.test.ts).
import { z } from "zod";

export const DISPLAYS = ["folded", "unfolded"] as const;
/**
 * Which of the Duo's displays the page is on. bb's own layout tells them apart: the folded cover
 * screen (466 pt wide) gets bb's compact phone layout, the unfolded display (about 950 pt) its wide one.
 */
export type Display = (typeof DISPLAYS)[number];

export const DISPLAY_LABELS: Record<Display, string> = { folded: "Folded", unfolded: "Unfolded" };

export function displayFor(compact: boolean): Display {
  return compact ? "folded" : "unfolded";
}

export const MAX_BUTTONS = 8;
export const MAX_MENU_ITEMS = 12;
export const MAX_RECENT_THREADS = 10;
export const MAX_LABEL = 40;

/** bb's own New thread glyph, the sidebar's, which `experimental_Icon` does not draw. */
export const NEW_THREAD_ICON = "nav:new-thread";

const id = z.string().min(1).max(64);
const label = z.string().trim().min(1).max(MAX_LABEL);
const icon = z.string().min(1).max(64);

/** A URL with a scheme: `https:` opens in bb's browser, an app link (`shortcuts:`) asks first. */
const url = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => /^[a-z][a-z0-9+.-]*:/i.test(value), "Start the address with its scheme, such as https://");

const leafActions = [
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("forward") }),
  z.object({ kind: z.literal("reload") }),
  /** bb's New thread screen; `projectId` picks the project, null leaves bb's own choice. */
  z.object({ kind: z.literal("newThread"), projectId: id.nullable() }),
  z.object({ kind: z.literal("openThread"), threadId: id }),
  z.object({ kind: z.literal("openProject"), projectId: id }),
  /** The most recent threads, as a menu of their own on a button or a section in a menu. */
  z.object({ kind: z.literal("recentThreads"), count: z.number().int().min(1).max(MAX_RECENT_THREADS) }),
  /** An action from bb's thread menu (`<owner>/<id>`, bb's own or a plugin's), on the open thread. */
  z.object({ kind: z.literal("threadAction"), key: id.max(200) }),
  /** `bb <args…>` on the bb server's machine, a plugin's command or one of bb's. */
  z.object({ kind: z.literal("bbCommand"), args: z.array(z.string().min(1).max(500)).min(1).max(32) }),
  z.object({ kind: z.literal("openUrl"), url }),
] as const;

export const leafActionSchema = z.discriminatedUnion("kind", [...leafActions]);
export type LeafAction = z.infer<typeof leafActionSchema>;

export const menuItemSchema = z.object({ id, label, icon, action: leafActionSchema });
export type MenuItem = z.infer<typeof menuItemSchema>;

const menuAction = z.object({ kind: z.literal("menu"), items: z.array(menuItemSchema).min(1).max(MAX_MENU_ITEMS) });

export const actionSchema = z.discriminatedUnion("kind", [...leafActions, menuAction]);
export type RailAction = z.infer<typeof actionSchema>;
export type ActionKind = RailAction["kind"];
export type LeafKind = LeafAction["kind"];

export const buttonSchema = z.object({ id, label, icon, action: actionSchema });
export type RailButton = z.infer<typeof buttonSchema>;

const uniqueIds = (list: readonly { id: string }[]) => new Set(list.map((entry) => entry.id)).size === list.length;

const buttonsSchema = z
  .array(buttonSchema)
  .max(MAX_BUTTONS)
  .refine(uniqueIds, "Two buttons share an id")
  .refine((buttons) => buttons.every((button) => button.action.kind !== "menu" || uniqueIds(button.action.items)), "Two menu items share an id");

export const layoutSchema = z.object({
  version: z.literal(1),
  folded: z.object({ buttons: buttonsSchema }),
  unfolded: z.object({ buttons: buttonsSchema }),
});
export type Layout = z.infer<typeof layoutSchema>;

/** Today's set, on both displays: Back, New thread, and More with the recent threads, Forward and Reload. */
export const DEFAULT_BUTTONS: readonly RailButton[] = [
  { id: "back", label: "Back", icon: "ArrowLeft", action: { kind: "back" } },
  { id: "new-thread", label: "New thread", icon: NEW_THREAD_ICON, action: { kind: "newThread", projectId: null } },
  {
    id: "more",
    label: "More",
    icon: "MoreHorizontal",
    action: {
      kind: "menu",
      items: [
        { id: "recent", label: "Recent threads", icon: "Clock", action: { kind: "recentThreads", count: 5 } },
        { id: "forward", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } },
        { id: "reload", label: "Reload bb", icon: "ArrowReloadHorizontal", action: { kind: "reload" } },
      ],
    },
  },
];

export function defaultLayout(): Layout {
  return { version: 1, folded: { buttons: structuredClone([...DEFAULT_BUTTONS]) }, unfolded: { buttons: structuredClone([...DEFAULT_BUTTONS]) } };
}

export const DEFAULT_LAYOUT_JSON = serializeLayout(defaultLayout());

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout);
}

/** The first problem zod found, in words a person can act on. */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "The layout is not valid.";
  const where = issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
  return `${issue.message}${where}`;
}

/** Checks a layout as typed in the settings form: valid JSON, and a layout. Null when it is fine. */
export function layoutProblem(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "The layout is not valid JSON.";
  }
  const parsed = layoutSchema.safeParse(value);
  return parsed.success ? null : describeIssue(parsed.error);
}

export interface ParsedLayout {
  layout: Layout;
  /** Why the stored layout was not used, or null. The default stands in for a broken one. */
  problem: string | null;
}

/** The setting as stored, made usable: missing means the default, broken means the default and a reason. */
export function parseLayout(raw: unknown): ParsedLayout {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { layout: defaultLayout(), problem: null };
  if (typeof raw !== "string") return { layout: defaultLayout(), problem: "The layout is not text." };
  const problem = layoutProblem(raw);
  if (problem !== null) return { layout: defaultLayout(), problem };
  return { layout: layoutSchema.parse(JSON.parse(raw)), problem: null };
}

/**
 * The words of a `bb` command line, as a shell would split them: spaces separate words, and single or
 * double quotes keep spaces in one. Backslash escapes the next character outside single quotes.
 */
export function splitArgs(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      word += text[index + 1];
      index += 1;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

/** The reverse of `splitArgs`, for showing and editing a command. */
export function joinArgs(args: readonly string[]): string {
  return args.map((arg) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(" ");
}
