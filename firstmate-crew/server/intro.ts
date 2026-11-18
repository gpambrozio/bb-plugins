/**
 * The first-run guide's server half: whether to offer it, and starting the first mate it sets up.
 *
 * Whether this install is new is decided once, the first time the guide is considered, and kept in the
 * store (`IntroState`): an install with no first mate, the home setting at its default and no home
 * prepared there is new, and is `offered` the guide; anything else is `settled` and never sees it, even
 * after its first mate is released. Launching or adopting a first mate by any way makes it `done`, and
 * "Don't ask again" makes it `dismissed`. "Later" is the app's alone: it hides the offer in that window
 * until the app loads again, and the server keeps offering.
 *
 * The guide can always be started by hand (the palette, the settings section, the tab), whatever the
 * state says: `startIntro` does not read it.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { isHomeReady } from "./home";
import { launchMate, resolveMate, type MateDeps } from "./mate";
import type { ThreadInfo } from "./ports";
import { serialized } from "./serialize";
import { SETTINGS, homePath } from "./settings";
import type { IntroState } from "./store";
import { TEMPLATES } from "./templates";

export interface IntroDeps extends MateDeps {
  /** Writes the home directory setting, as typed (`~/…` kept). */
  setHomeDirectory(value: string): Promise<void>;
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

/** Whether nothing of FirstMate has been set up here yet: no first mate, the default home, and nothing prepared there. */
async function isNewInstall(deps: MateDeps): Promise<boolean> {
  if ((await deps.store.mateThreadId()) !== null) return false;
  const { homeDirectory } = await deps.settings();
  if (homeDirectory.trim() !== SETTINGS.homeDirectory.default) return false;
  return !(await isHomeReady(homePath(homeDirectory)));
}

/** The guide's state, deciding it on the first call for this install. */
export function considerIntro(deps: MateDeps): Promise<IntroState> {
  return serialized(INTRO_LOCK, async () => {
    const known = await deps.store.introState();
    if (known !== null) return known;
    const state: IntroState = (await isNewInstall(deps)) ? "offered" : "settled";
    await deps.store.setIntroState(state);
    return state;
  });
}

export async function introStatus(deps: MateDeps): Promise<IntroStatus> {
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

async function entries(path: string): Promise<string[] | null> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`${path} is a file, not a folder. Choose a folder for the first mate's home.`);
  return readdir(path);
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

/**
 * Refuses a folder that holds anything but a first mate's home, because preparing a home writes its own
 * `AGENTS.md` and records there. A folder that does not exist yet, an empty one, or an earlier home is fine.
 */
export async function checkHomeFolder(home: string): Promise<void> {
  const found = await entries(home);
  if (found === null || found.filter((name) => name !== ".DS_Store").length === 0) return;
  if (await isEarlierHome(home)) return;
  throw new Error(`${home} already holds other files. Choose a new or empty folder for the first mate's home.`);
}

/**
 * The guide's last step: writes the home setting, then launches the first mate with the first-session
 * prompt (`templates/messages/first-session.md`). Refused before anything changes when a first mate is
 * already aboard or the folder is unusable; a launch that fails leaves the state `offered`.
 */
export async function startIntro(deps: IntroDeps, input: IntroStart): Promise<ThreadInfo> {
  const homeDirectory = input.homeDirectory.trim();
  const home = homePath(homeDirectory);
  const current = await resolveMate(deps);
  if (current !== null) throw new Error(`A first mate is already aboard (${current.id}).`);
  await checkHomeFolder(home);
  await deps.setHomeDirectory(homeDirectory);
  const mate = await launchMate(
    deps,
    { providerId: input.providerId, model: input.model, reasoningLevel: input.reasoningLevel },
    { firstSession: true },
  );
  // The first mate is aboard whatever happens next: a failure to record it is logged, not the guide's.
  await finishIntro(deps).catch((error: unknown) => {
    deps.log.error(`The first-run guide could not be marked done: ${error instanceof Error ? error.message : String(error)}`);
  });
  return mate;
}
