/**
 * The captain's copy of the charter, `data/charter.md`, which `AGENTS.md` is rendered from.
 *
 * It starts as `templates/data/charter.md`: the plugin's charter under a note, the note recording a
 * fingerprint of the charter it was copied from. That is how a new plugin version tells two cases
 * apart:
 *
 * - **Untouched**: the text still matches its fingerprint. The captain never edited it, so it follows
 *   the plugin, and a changed plugin charter replaces it.
 * - **Edited**: it does not. The captain's text is kept and used. When the plugin's charter has moved
 *   on since the version the edit started from, the new one is written beside it as
 *   `data/charter.new.md` (from `templates/data/charter.new.md`) and the board says so;
 *   `acknowledgeCharter` moves the fingerprint on once the captain has taken what they want from it,
 *   and removes that file.
 *
 * An emptied or deleted copy goes back to the plugin's charter. A copy whose fingerprint is gone — the
 * note deleted — counts as edited and based on nothing, so any plugin charter is news to it.
 *
 * HTML comments are notes to the captain: they are left out of `AGENTS.md` and of the comparison, so
 * the fingerprint is of the words alone.
 */
import { createHash } from "node:crypto";
import type { CharterState } from "../shared/types";
import { FileChangedError, readInHome, removeInHome, replaceTextIfUnchanged, updateInHome, writeInHome, type WriteHooks } from "./files";
import { TEMPLATES, fill, readTemplate, withoutNotes } from "./templates";

export const CHARTER_FILE = TEMPLATES.charter;
export const NEW_CHARTER_FILE = TEMPLATES.charterNew;

/** Where in the note the fingerprint is, and its shape. */
const MARK = /firstmate-charter ([0-9a-f]{16})/;

/** The copy's state, with what `AGENTS.md` is rendered from: the captain's copy, or the plugin's charter. */
export type CharterFileState = CharterState & { template: string };

/** The plugin's two charter templates, as written: the copy's, and the comparison's. */
export interface PluginCharter {
  /** `templates/data/charter.md`: the note, with `{{fingerprint}}`, then the charter. */
  charter: string;
  /** `templates/data/charter.new.md`: a note, then `{{charter}}`. */
  charterNew: string;
}

async function pluginTemplates(): Promise<PluginCharter> {
  const [charter, charterNew] = await Promise.all([readTemplate(TEMPLATES.charter), readTemplate(TEMPLATES.charterNew)]);
  return { charter, charterNew };
}

export function fingerprint(charter: string): string {
  return createHash("sha256").update(withoutNotes(charter)).digest("hex").slice(0, 16);
}

/** The copy as the plugin writes it: its template, fingerprinted. */
function copyOf(plugin: PluginCharter): string {
  return fill(plugin.charter, { fingerprint: fingerprint(plugin.charter) });
}

function newCopyOf(plugin: PluginCharter): string {
  return fill(plugin.charterNew, { charter: withoutNotes(plugin.charter) });
}

/** The note the copy's template starts with, fingerprinted — for a copy whose note was deleted. */
function noteOf(plugin: PluginCharter, base: string): string {
  const note = /^\s*<!--[\s\S]*?-->/.exec(plugin.charter)?.[0].trim() ?? `<!-- firstmate-charter {{fingerprint}} -->`;
  return fill(note, { fingerprint: base });
}

/** What a copy means, given the plugin's current charter; `rewrite` when the copy should become it. */
export function assessCharter(copy: string | null, pluginCharter: string): CharterFileState & { rewrite: boolean } {
  const text = copy === null ? "" : withoutNotes(copy);
  const plugin = withoutNotes(pluginCharter);
  if (text === "") return { template: plugin, edited: false, outdated: false, rewrite: true };
  const base = MARK.exec(copy ?? "")?.[1] ?? null;
  const current = fingerprint(pluginCharter);
  if (base !== null && fingerprint(text) === base) {
    return base === current
      ? { template: text, edited: false, outdated: false, rewrite: false }
      : { template: plugin, edited: false, outdated: false, rewrite: true };
  }
  return { template: text, edited: true, outdated: base !== current, rewrite: false };
}

/** The copy's state, touching nothing: what the board reads on every poll. */
export async function readCharterState(home: string, plugin?: PluginCharter): Promise<CharterFileState> {
  const templates = plugin ?? (await pluginTemplates());
  const { rewrite: _rewrite, ...state } = assessCharter(await readInHome(home, CHARTER_FILE), templates.charter);
  return state;
}

/**
 * Brings the home's copy in step with the plugin's charter — writing it when missing, empty or untouched
 * and out of date, and `charter.new.md` beside an edited one that is out of date — and says what
 * `AGENTS.md` should be rendered from. The caller has created `data/`.
 */
export async function syncCharter(home: string, plugin?: PluginCharter, hooks: WriteHooks = {}): Promise<CharterFileState> {
  const templates = plugin ?? (await pluginTemplates());
  // Replaced only while it still reads as assessed: an edit saved meanwhile is assessed again, and kept.
  const decided = await updateInHome(
    home,
    CHARTER_FILE,
    (copy) => (assessCharter(copy, templates.charter).rewrite ? copyOf(templates) : null),
    { hooks },
  );
  const { rewrite: _rewrite, ...state } = assessCharter(decided, templates.charter);
  if (state.outdated) await writeInHome(home, NEW_CHARTER_FILE, newCopyOf(templates));
  else await removeInHome(home, NEW_CHARTER_FILE);
  return state;
}

/** Writes `charter.new.md` for the captain to compare, when there is anything to compare. */
export async function writeNewCharter(home: string, plugin?: PluginCharter): Promise<boolean> {
  const templates = plugin ?? (await pluginTemplates());
  const state = await readCharterState(home, templates);
  if (state.outdated) await writeInHome(home, NEW_CHARTER_FILE, newCopyOf(templates));
  return state.outdated;
}

/** How many times an acknowledgement starts over when the charter is saved under it. */
export const ACKNOWLEDGE_ATTEMPTS = 3;

/**
 * The captain has taken what they want from the plugin's new charter: the copy is now based on it.
 * Moves the fingerprint on — restoring the note if it was deleted — keeps every word the captain wrote,
 * and removes `charter.new.md`.
 *
 * The copy is replaced only if it still reads as it did (`replaceTextIfUnchanged`), so an edit saved
 * while this ran is not overwritten: the acknowledgement starts over from it.
 */
export async function acknowledgeCharter(home: string, plugin?: PluginCharter, hooks: WriteHooks = {}): Promise<void> {
  const templates = plugin ?? (await pluginTemplates());
  const current = fingerprint(templates.charter);
  for (let attempt = 1; ; attempt++) {
    const copy = await readInHome(home, CHARTER_FILE);
    if (copy === null || withoutNotes(copy) === "") break;
    const next = MARK.test(copy)
      ? copy.replace(MARK, `firstmate-charter ${current}`)
      : `${noteOf(templates, current)}\n\n${copy.trimStart()}`;
    if (next === copy) break;
    try {
      await replaceTextIfUnchanged(home, CHARTER_FILE, copy, next, hooks);
      break;
    } catch (error) {
      if (!(error instanceof FileChangedError)) throw error;
      if (attempt >= ACKNOWLEDGE_ATTEMPTS) {
        throw new Error("data/charter.md kept changing while it was being marked up to date. Try again.");
      }
    }
  }
  await removeInHome(home, NEW_CHARTER_FILE);
}
