/**
 * The first mate's home: the directory it runs in, and the only place it
 * writes. FirstMate called this the distro — a charter and a set of records
 * that turn a general-purpose agent into a first mate — and it is the same
 * here, minus the scripts.
 *
 *     <home>/AGENTS.md           the charter, rendered from data/charter.md on every launch
 *     <home>/data/charter.md     the charter's source; follows the plugin until the captain edits it
 *     <home>/data/captain.md     standing orders; the captain's, never overwritten
 *     <home>/data/projects.md    the project registry
 *     <home>/data/backlog.md     every work item; the board reads it
 *     <home>/data/suggestions.md what the captain might do next; the board's buttons
 *     <home>/data/suggestions-dismissed.md  the ones the captain removed; the board writes it (suggestions.ts)
 *     <home>/data/learnings.md
 *     <home>/data/opening.md     a new first mate's first message; the captain's, never overwritten
 *     <home>/watches/            scripts the plugin runs on a schedule (watch-files.ts, watches.ts)
 *     <home>/projects/           clones for projects with no local checkout
 *     <home>/.firstmate/         the plugin's own state; the first mate never needs it
 *     <home>/icon.svg            the plugin's ship icon, kept from the Paseo plugin
 *
 * Every file starts as its namesake in the plugin's `templates/` folder, which
 * is laid out the same way (`templates.ts`). Everything but the charter is
 * written only when missing, so a relaunch never loses a record the first
 * mate has been keeping.
 *
 * The icon is Lucide's ship — the plugin's own icon, ISC-licensed — in white on
 * a blue rounded square. Paseo showed an icon it found in a project's folder;
 * bb 0.44 documents no such lookup, so here it is only a file in the home, left
 * for any tool that does look for one.
 *
 * The charter is the home's `AGENTS.md`, which bb itself does not inject (bb
 * reads only `<workspace>/.bb/AGENTS.md`). Codex reads a repo-root `AGENTS.md`,
 * and Claude Code 2.1.277 and later does too when no `CLAUDE.md` takes
 * precedence. There is no `CLAUDE.md`: importing `AGENTS.md` from one risks the
 * charter twice over in every turn's context. The opening prompt asks a harness
 * that has not loaded the file to read it in full.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { STATE_DIR, type BacklogItem, type Project, type Suggestion } from "../shared/types";
import { parseBacklog } from "./backlog";
import { renderCharter } from "./charter";
import { syncCharter } from "./charter-file";
import {
  FileChangedError,
  createInHome,
  makeDirInHome,
  readInHome,
  readTextFile,
  replaceTextIfUnchanged,
  updateInHome,
  writeInHome,
  type WriteHooks,
} from "./files";
import { DISMISSED_FILE, parseDismissedPrompts, parseSuggestions, withDismissal, withoutSuggestion } from "./suggestions";
import { TEMPLATES, readTemplate, withoutNotes, type TemplatePath } from "./templates";
import { seedWatches } from "./watch-files";

/** What `prepareHome` renders into the charter: the crew's settings. Both empty leaves them to the first mate. */
export interface HomeConfig {
  /** `provider/model` for crewmates, or empty to leave it to the first mate. */
  crewProvider: string;
  /** Reasoning effort for crewmates, or empty to leave it to the first mate. */
  crewReasoning: string;
}

/** The home's records: written from their templates when missing, and the captain's or the first mate's after. */
const RECORDS: readonly TemplatePath[] = [
  TEMPLATES.captain,
  TEMPLATES.projects,
  TEMPLATES.learnings,
  TEMPLATES.backlog,
  TEMPLATES.suggestions,
  TEMPLATES.opening,
  TEMPLATES.icon,
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Creates whatever of the home is missing, brings `data/charter.md` in step with the plugin's charter
 * (`charter-file.ts`) and the built-in watches with theirs (`watch-files.ts`), and renders `AGENTS.md`
 * from the charter with the current config. Every path is confined to the home (`files.ts`): a symlink
 * the first mate left that leads out of it is refused, never written through.
 */
export async function prepareHome(home: string, config: HomeConfig): Promise<void> {
  await makeDirInHome(home, "data");
  await makeDirInHome(home, "projects");
  await makeDirInHome(home, STATE_DIR);
  const charter = await syncCharter(home);
  await writeInHome(
    home,
    TEMPLATES.agents,
    await renderCharter({ home, crewProvider: config.crewProvider, crewReasoning: config.crewReasoning }, charter.template),
  );
  for (const record of RECORDS) await createInHome(home, record, await readTemplate(record));
  await seedWatches(home);
}

/** Whether a launch has ever prepared this home. */
export function isHomeReady(home: string): Promise<boolean> {
  return exists(join(home, TEMPLATES.agents));
}

/**
 * A new first mate's first message: `data/opening.md` without its HTML comments, which are notes to the
 * captain. A missing or empty file gives the template's wording, so a first mate is never started with
 * nothing to act on.
 */
export async function readOpening(home: string): Promise<string> {
  const text = withoutNotes((await readInHome(home, TEMPLATES.opening)) ?? "");
  return text === "" ? withoutNotes(await readTemplate(TEMPLATES.opening)) : text;
}

export async function readBacklog(home: string): Promise<BacklogItem[]> {
  const markdown = await readInHome(home, TEMPLATES.backlog);
  return markdown === null ? [] : parseBacklog(markdown);
}

/** The normalized prompts the captain dismissed; none when the board has never written the file. */
async function readDismissed(home: string): Promise<Set<string>> {
  return parseDismissedPrompts((await readInHome(home, DISMISSED_FILE)) ?? "");
}

/** The board's suggestions: `data/suggestions.md` without any the captain dismissed. Never writes. */
export async function readSuggestions(home: string): Promise<Suggestion[]> {
  const markdown = await readInHome(home, TEMPLATES.suggestions);
  return markdown === null ? [] : parseSuggestions(markdown, await readDismissed(home));
}

/** How many times a removal starts over when the first mate rewrites the file under it. */
export const REMOVE_ATTEMPTS = 3;

/**
 * Takes one suggestion out of `data/suggestions.md`, leaving every other byte as it was, and answers
 * with the suggestions left. One the file no longer has — the first mate rewrote it since the board
 * looked — is not an error: nothing is written.
 *
 * The write is confined to the home, staged in a temporary file and renamed into place, and refused
 * if the file no longer reads as it did (`replaceTextIfUnchanged`), checked again just before the
 * rename. A refusal is the first mate rewriting its list at the same moment, and the removal starts
 * over from what it wrote. A write of its that lands between that last check and the rename is still
 * lost; see `stageAndReplace`.
 */
export async function removeSuggestion(home: string, target: Suggestion, hooks: WriteHooks = {}): Promise<Suggestion[]> {
  for (let attempt = 1; ; attempt++) {
    let file: Awaited<ReturnType<typeof readTextFile>>;
    try {
      file = await readTextFile(home, TEMPLATES.suggestions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (file.content === null) throw new Error(`${TEMPLATES.suggestions} is not a text file the board can edit.`);
    const next = withoutSuggestion(file.content, target);
    if (next === null) return parseSuggestions(file.content, await readDismissed(home));
    try {
      await replaceTextIfUnchanged(home, TEMPLATES.suggestions, file.content, next, hooks);
      return parseSuggestions(next, await readDismissed(home));
    } catch (error) {
      if (!(error instanceof FileChangedError)) throw error;
      if (attempt >= REMOVE_ATTEMPTS) {
        throw new Error("The first mate kept rewriting its suggestions while this one was being removed. Try again.");
      }
    }
  }
}

/**
 * The trash: records the suggestion in `data/suggestions-dismissed.md`, so the first mate does not write
 * it again and the board hides it if it does, then takes it out of `data/suggestions.md` as
 * `removeSuggestion` does. Recorded first, so a removal that fails still leaves it hidden. Recorded even
 * when the first mate has rewritten its list without it since the board looked: the captain still meant
 * to dismiss it. The record is a staged rename, re-read and decided again when the file changes under it
 * (`updateInHome`).
 */
export async function dismissSuggestion(
  home: string,
  target: Suggestion,
  options: { now?: Date; hooks?: WriteHooks } = {},
): Promise<Suggestion[]> {
  const now = options.now ?? new Date();
  await updateInHome(home, DISMISSED_FILE, (current) => withDismissal(current, target, now));
  return removeSuggestion(home, target, options.hooks);
}

/**
 * `- <name> [<mode> +yolo] - <location> - <description>`, as the charter asks.
 * The line splits on ` - ` first, and only the name part is read for the
 * bracket, so a Markdown link or a `[WIP]` in the description stays text. The
 * bracket, the location and the description are each optional, and a line
 * that is not a list item is not a project.
 */
export function parseProjects(markdown: string): Project[] {
  const projects: Project[] = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const item = /^\s*[-*]\s+(?!\[[ xX]\])(.+)$/.exec(line);
    if (item === null) continue;
    const [head = "", ...rest] = (item[1] ?? "").split(/\s+[-–—]\s+/).map((part) => part.trim());
    const bracket = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(head);
    const name = (bracket?.[1] ?? head).replace(/[`*]/g, "").trim();
    if (name === "" || name.startsWith("(") || /\s/.test(name)) continue;
    const flags = (bracket?.[2] ?? "").split(/\s+/).filter((flag) => flag !== "");
    const parts = rest.filter((part) => part !== "");
    projects.push({
      name,
      mode: flags.find((flag) => !flag.startsWith("+")) ?? null,
      yolo: flags.includes("+yolo"),
      location: parts[0] ?? null,
      description: parts.slice(1).join(" - ") || null,
    });
  }
  return projects;
}

export async function readProjects(home: string): Promise<Project[]> {
  const markdown = await readInHome(home, TEMPLATES.projects);
  return markdown === null ? [] : parseProjects(markdown);
}
