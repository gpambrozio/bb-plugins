/**
 * The plugin's `templates/` folder: every file the plugin writes into the first mate's home, laid out as
 * it lands there; the parts it puts inside them (`parts/`); and everything it says to the first mate
 * itself (`messages/`). They are Markdown — and the home's icon — so they can be read and changed as the
 * text they become, rather than as strings in code.
 *
 * `bb plugin build` bundles the server half into one script, so the templates are compiled into it:
 * `npm run gen:templates` writes `templates.generated.ts` from the folder, and the tests check the two
 * agree. HTML comments in a template are notes for whoever edits it; `withoutNotes` leaves them out where
 * a template becomes a message or a part of another file.
 */
import { TEMPLATE_FILES } from "./templates.generated";

/** Every template, by the path it has under `templates/` — for a home file, the path it has in the home. */
export const TEMPLATES = {
  agents: "AGENTS.md",
  icon: "icon.svg",
  backlog: "data/backlog.md",
  captain: "data/captain.md",
  charter: "data/charter.md",
  charterNew: "data/charter.new.md",
  learnings: "data/learnings.md",
  opening: "data/opening.md",
  projects: "data/projects.md",
  suggestions: "data/suggestions.md",
  watchesReadme: "watches/README.md",
  watchPr: "watches/pr-watch",
  crewReasoningChosen: "parts/crew-reasoning-chosen.md",
  crewReasoningOpen: "parts/crew-reasoning-open.md",
  crewProviderChosen: "parts/crew-provider-chosen.md",
  crewProviderOpen: "parts/crew-provider-open.md",
  ahoy: "messages/ahoy.md",
  ahoyArgs: "messages/ahoy-args.md",
  boardNote: "messages/board-note.md",
  bearings: "messages/bearings.md",
  bearingsArgs: "messages/bearings-args.md",
  relaunch: "messages/relaunch.md",
  restartNote: "messages/restart-note.md",
  watchOutput: "messages/watch-output.md",
  watchFailed: "messages/watch-failed.md",
  watchDropped: "messages/watch-dropped.md",
} as const;

export type TemplatePath = (typeof TEMPLATES)[keyof typeof TEMPLATES];

/** A template's text, exactly as written. */
export async function readTemplate(path: TemplatePath): Promise<string> {
  const text = Object.hasOwn(TEMPLATE_FILES, path) ? TEMPLATE_FILES[path] : undefined;
  if (text === undefined) throw new Error(`Unknown template ${path}`);
  return text;
}

/** Text without its notes — its HTML comments — and without the whitespace around it. */
export function withoutNotes(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** A template from `messages/` or `parts/`, its notes left out and its placeholders filled. */
export async function message(path: TemplatePath, values: Readonly<Record<string, string>> = {}): Promise<string> {
  return fill(withoutNotes(await readTemplate(path)), values);
}

/** `{{name}}` filled from `values` in one pass, so a value is never read for placeholders; a name it does not have is left as it is. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}
