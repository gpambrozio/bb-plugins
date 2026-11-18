/**
 * The first-run guide's server half: whether to offer it, and starting the first mate it sets up.
 *
 * Whether this install is new is decided once, the first time the guide is considered, and kept in the
 * store (`IntroState`): an install with no trace of use (`isNewInstall`) is `offered` the guide; anything
 * else is `settled` and never sees it, even after its first mate is released. Launching or adopting a first mate by any way makes it `done`, and
 * "Don't ask again" makes it `dismissed`. "Later" is the app's alone: it hides the offer in that window
 * until the app loads again, and the server keeps offering.
 *
 * The guide can always be started by hand (the palette, the settings section, the tab), whatever the
 * state says: `startIntro` does not read it. It checks its folder and launches in one hold of the `mate`
 * lock, in the folder's real path, and never writes into a folder it does not own: a new or empty folder is
 * replaced whole by a home prepared beside it (`placeFreshHome`). It never deletes anything it placed.
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isHomeReady, prepareHome } from "./home";
import { launchInHome, resolveMate, withMateLock, type MateDeps } from "./mate";
import type { ThreadInfo } from "./ports";
import { serialized } from "./serialize";
import { defaultSettings, homeConfig, homePath, type FirstmateSettings } from "./settings";
import type { IntroState } from "./store";
import { TEMPLATES } from "./templates";

/** The first version with the guide: an install that ran an older one is an upgrade. */
export const GUIDE_SINCE = "0.11.0";

/** What deciding whether this install is new reads, beyond the plugin's own deps. */
export interface IntroHistoryDeps extends MateDeps {
  /**
   * The builds of this plugin bb keeps, newest first (`plugins.getSource`'s `history`): versions for an npm
   * install, commit SHAs for a git one, none for a local folder. bb keeps a build for seven days after it
   * stops being used, so at the first load after an update the previous one is still there.
   */
  installedVersions?: () => Promise<string[]>;
}

export interface IntroDeps extends IntroHistoryDeps {
  /** Writes the home directory setting, as typed (`~/…` kept). */
  setHomeDirectory(value: string): Promise<void>;
}

/** Test seams: run between the folder's check and its use, where another process could change it. */
export interface IntroHooks {
  /** After the folder is checked, before anything is written. */
  afterCheck?: () => Promise<void>;
  /** After a new home is prepared beside the folder, before it is renamed into place. */
  beforePlace?: () => Promise<void>;
}

export interface IntroStatus {
  /** Whether this install should be offered the guide on its own. */
  offer: boolean;
  /** The home directory setting, as the guide's first step starts from. */
  homeDirectory: string;
}

export interface IntroStart {
  homeDirectory: string;
  providerId: string;
  model: string;
  reasoningLevel?: string;
}

const INTRO_LOCK = "intro";

/** Whether `version` is an x.y.z older than `than`; a commit SHA or anything else is not. */
function olderThan(version: string, than: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())?.slice(1).map(Number);
  const b = than.split(".").map(Number);
  if (a === undefined) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}

/** Whether bb's builds show this install was updated: more than one build, or a version before the guide. */
function wasUpdated(builds: string[]): boolean {
  return new Set(builds).size > 1 || builds.some((build) => olderThan(build, GUIDE_SINCE));
}

function changedSettings(settings: FirstmateSettings): string[] {
  const defaults = defaultSettings() as unknown as Record<string, unknown>;
  const current = settings as unknown as Record<string, unknown>;
  return Object.keys(defaults).filter((key) => current[key] !== defaults[key]);
}

/**
 * Whether nothing of FirstMate has been set up here yet. Any trace of use settles it: anything stored (a
 * first mate, a switched-off watch, autocompact's marks), a setting changed from its default, a home
 * prepared at the default folder, or bb's builds showing an update (`wasUpdated`). An older install with
 * none of these — never configured, never launched, installed from a local folder (no builds) — looks new.
 */
async function isNewInstall(deps: IntroHistoryDeps): Promise<boolean> {
  if (await deps.store.hasRecords()) return false;
  const settings = await deps.settings();
  if (changedSettings(settings).length > 0) return false;
  if (await isHomeReady(homePath(settings.homeDirectory))) return false;
  // Last, as the only check that asks bb: an install that looks untouched may still be an upgrade.
  if (deps.installedVersions !== undefined) {
    try {
      if (wasUpdated(await deps.installedVersions())) return false;
    } catch (error) {
      deps.log.warn(`The first-run guide could not read this install's history: ${reason(error)}`);
    }
  }
  return true;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The guide's state, deciding it on the first call for this install. */
export function considerIntro(deps: IntroHistoryDeps): Promise<IntroState> {
  return serialized(INTRO_LOCK, async () => {
    const known = await deps.store.introState();
    if (known !== null) return known;
    const state: IntroState = (await isNewInstall(deps)) ? "offered" : "settled";
    await deps.store.setIntroState(state);
    return state;
  });
}

export async function introStatus(deps: IntroHistoryDeps): Promise<IntroStatus> {
  const state = await considerIntro(deps);
  return { offer: state === "offered", homeDirectory: (await deps.settings()).homeDirectory };
}

/** "Don't ask again": the guide is never offered on its own again. */
export function dismissIntro(deps: MateDeps): Promise<void> {
  return serialized(INTRO_LOCK, () => deps.store.setIntroState("dismissed"));
}

/** A first mate is aboard, by the guide or any other way: the guide has nothing left to offer. */
export function finishIntro(deps: MateDeps): Promise<void> {
  return serialized(INTRO_LOCK, () => deps.store.setIntroState("done"));
}

/**
 * What the guide found at the folder: nothing, an empty folder or an earlier home. `real`, `dev` and `ino`
 * name the folder itself, so a later look can tell it is still the same one; `entries` is what it held.
 */
export type HomeFolder =
  | { kind: "missing" }
  | { kind: "empty" | "home"; real: string; dev: number; ino: number; entries: string[] };

const IGNORED = new Set([".DS_Store"]);

/**
 * The guide's home folder as typed, as an absolute path. A `.` or `..` part is refused: a missing folder
 * followed by `..` names its parent once it is created, which is a folder the check never looked at.
 */
export function guideHomePath(typed: string): string {
  const value = typed.trim();
  if (value.split(/[\\/]+/).some((part) => part === "." || part === "..")) {
    throw new Error(`Write the home folder without "." or ".." in it: ${value}`);
  }
  return homePath(value);
}

/**
 * Refuses a folder that holds anything but a first mate's home, because preparing a home writes its own
 * `AGENTS.md` and records there. A folder that does not exist yet, an empty one, or an earlier home is fine.
 */
export async function checkHomeFolder(home: string): Promise<HomeFolder> {
  let info;
  try {
    info = await stat(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`${home} is a file, not a folder. Choose a folder for the first mate's home.`);
  const entries = await readdir(home);
  const found = { real: await realpath(home), dev: info.dev, ino: info.ino, entries };
  if (entries.every((name) => IGNORED.has(name))) return { kind: "empty", ...found };
  if (await isEarlierHome(home)) return { kind: "home", ...found };
  throw new Error(`${home} already holds other files. Choose a new or empty folder for the first mate's home.`);
}

/**
 * Whether the folder is an earlier first mate's home: its `AGENTS.md` and its charter's source. `AGENTS.md`
 * alone is any project's agent instructions, which preparing a home would overwrite.
 */
async function isEarlierHome(home: string): Promise<boolean> {
  return (await isHomeReady(home)) && (await isFile(join(home, TEMPLATES.charter)));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The guide's folder as placed: its identity, so every later step can tell it is still the same one. */
interface Placement {
  dev: number;
  ino: number;
}

async function identity(path: string): Promise<Placement | null> {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}

async function sameFolder(path: string, expected: Placement): Promise<boolean> {
  const found = await identity(path);
  return found !== null && found.dev === expected.dev && found.ino === expected.ino;
}

const CHANGED = (home: string) => `${home} changed while the guide was starting. Check the folder and try again.`;

/**
 * The home as the filesystem names it, every link in it resolved once: the real path of its nearest
 * existing folder, then the parts still to be created. The guide checks, places, launches and records
 * this path and nothing else, so a link in the typed path that is retargeted later leads nowhere it writes.
 */
export async function canonicalHome(home: string): Promise<string> {
  const missing: string[] = [];
  for (let at = home; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error;
      missing.unshift(basename(at));
    }
  }
}

/**
 * Prepares a new home beside the chosen folder and renames it into place. The rename is the guard: it
 * replaces nothing but a missing path or an empty folder, and refuses a folder something has been put
 * in since the check, a file and a link swapped in, so the guide never writes into a folder it does not
 * own. Finder's `.DS_Store` moves into the new folder first. The charter names the staging folder until
 * the launch prepares the home again in place, moments later. A staging folder that was never placed is
 * removed; nothing placed is.
 */
async function placeFreshHome(
  home: string,
  folder: HomeFolder,
  settings: FirstmateSettings,
  hooks: IntroHooks,
): Promise<Placement> {
  await mkdir(dirname(home), { recursive: true });
  const staging = await mkdtemp(join(dirname(home), `.${basename(home)}.firstmate-`));
  try {
    await prepareHome(staging, homeConfig(settings));
    await chmod(staging, 0o755);
    const own = (await identity(staging))!;
    await hooks.beforePlace?.();
    if (folder.kind !== "missing" && !(await sameFolder(home, folder))) throw new Error(CHANGED(home));
    const moved = folder.kind === "missing" ? [] : await moveIgnored(home, staging);
    try {
      await rename(staging, home);
    } catch (error) {
      await moveIgnored(staging, home, moved).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") throw new Error(CHANGED(home));
      throw error;
    }
    return own;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Moves Finder's files (or the ones named) from one folder to another; answers with the names moved. */
async function moveIgnored(from: string, to: string, names?: string[]): Promise<string[]> {
  const moving = names ?? (await readdir(from)).filter((name) => IGNORED.has(name));
  for (const name of moving) await rename(join(from, name), join(to, name));
  return moving;
}

/** An earlier home is used in place, once it is checked to be the same folder, holding the same names. */
async function confirmEarlierHome(home: string, folder: Exclude<HomeFolder, { kind: "missing" }>): Promise<Placement> {
  const entries = await readdir(home).catch(() => null);
  const same =
    (await sameFolder(home, folder)) &&
    entries !== null &&
    entries.length === folder.entries.length &&
    entries.every((name) => folder.entries.includes(name));
  if (!same) throw new Error(CHANGED(home));
  return { dev: folder.dev, ino: folder.ino };
}

/**
 * The guide's last step, in one hold of the `mate` lock, so no other launch, adoption or guide can come
 * between its check and its launch: resolves the folder to its real path (`canonicalHome`), checks it,
 * places a new home there (or confirms an earlier one), launches the first mate in that path with the
 * first-session prompt (`templates/messages/first-session.md`), then writes the home setting.
 *
 * Refused before anything is written when a first mate is aboard or the folder is unusable. A failure
 * after that changes no setting and deletes nothing: a placed home and a registered project stay (both
 * harmless, and the next start uses them), and a first mate started but not recorded keeps running with
 * its id in the error (`launchInHome`), so the captain can adopt it.
 */
export async function startIntro(deps: IntroDeps, input: IntroStart, hooks: IntroHooks = {}): Promise<ThreadInfo> {
  const homeDirectory = input.homeDirectory.trim();
  const typed = guideHomePath(homeDirectory);
  const pick = { providerId: input.providerId, model: input.model, reasoningLevel: input.reasoningLevel };
  const mate = await withMateLock(async () => {
    const current = await resolveMate(deps);
    if (current !== null) throw new Error(`A first mate is already aboard (${current.id}).`);
    const home = await canonicalHome(typed);
    const folder = await checkHomeFolder(home);
    await hooks.afterCheck?.();
    const placed = folder.kind === "home" ? await confirmEarlierHome(home, folder) : await placeFreshHome(home, folder, await deps.settings(), hooks);
    if (!(await sameFolder(home, placed))) throw new Error(CHANGED(home));
    const launched = await launchInHome(deps, home, pick, { firstSession: true });
    // The setting keeps the captain's spelling (`~/…`) when it names the same folder.
    const setting = typed === home ? homeDirectory : home;
    // The first mate is aboard: a setting that cannot be written is logged, and its own workspace is the
    // home meanwhile (`activeHome`).
    await deps.setHomeDirectory(setting).catch((error: unknown) => {
      deps.log.error(`The first-run guide could not set the home directory to ${setting}: ${reason(error)}`);
    });
    return launched;
  });
  // The first mate is aboard whatever happens next: a failure to record it is logged, not the guide's.
  await finishIntro(deps).catch((error: unknown) => {
    deps.log.error(`The first-run guide could not be marked done: ${reason(error)}`);
  });
  return mate;
}
