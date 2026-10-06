/**
 * The first mate: launching one, adopting one, releasing it, restarting it, and carrying the
 * captain's words to it.
 *
 * The plugin never dispatches a crewmate. It gives the first mate a home and a charter and starts it
 * there; from then on the first mate owns intake, dispatch and supervision, with bb's own tools.
 *
 * The first mate is found only by the id in the store (`store.ts`). It is seeded with
 * `{ role: "first-mate" }` metadata for display, never for lookup, so a released first mate stays
 * released.
 */
import { mkdir } from "node:fs/promises";

import { CREW_METADATA } from "../shared/types";
import { canonicalPath } from "./files";
import { prepareHome, readOpening } from "./home";
import type { ProjectsPort, SpawnArgs, ThreadInfo, ThreadsPort } from "./ports";
import { serialized } from "./serialize";
import { homeConfig, homePath, type FirstmateSettings } from "./settings";
import type { Store } from "./store";
import { TEMPLATES, message } from "./templates";

export const MATE_TITLE = "First mate";
/** The bb project the home is registered as. */
export const PROJECT_NAME = "FirstMate";

export interface MateDeps {
  threads: ThreadsPort;
  projects: ProjectsPort;
  store: Store;
  settings: () => Promise<FirstmateSettings>;
}

/**
 * Every change of first mate — a launch, restart, adoption or release — runs under this key. The
 * "already aboard" check reads the store, which is only written once the thread exists, so two
 * launches that overlap (a double press, two windows) would both pass it, and an adoption or release
 * landing mid-launch would be overwritten by it. Every client reaches this one plugin instance, so
 * holding the change here makes the second one wait for the first — and then refuse.
 */
const MATE_LOCK = "mate";

const NO_MATE = "No first mate aboard. Launch one in FirstMate settings.";

function aboard(mate: ThreadInfo): Error {
  return new Error(`A first mate is already aboard (${mate.id}). Release it first.`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one step of a launch, naming the step in the error when it fails. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${what}: ${reason(error)}`, { cause: error });
  }
}

/** The stored first mate, or null when none is stored or the stored thread is gone (deleted or archived). */
export async function resolveMate(deps: MateDeps): Promise<ThreadInfo | null> {
  const id = await deps.store.mateThreadId();
  return id === null ? null : deps.threads.get(id);
}

/** The first mate, or a sentence saying there is none and what to do. */
export async function requireMate(deps: MateDeps): Promise<ThreadInfo> {
  const mate = await resolveMate(deps);
  if (mate === null) throw new Error(NO_MATE);
  return mate;
}

/**
 * The home every operation on the crew works in: the first mate's own workspace while one is aboard, so
 * a home setting changed since its launch cannot mix another home's backlog, charter, watches or notes
 * with this crew. With no first mate, or one whose workspace is not on this machine, it is the setting,
 * which otherwise names only where the next launch or adoption goes.
 */
export async function activeHome(deps: MateDeps): Promise<string> {
  const mate = await resolveMate(deps);
  if (mate !== null && mate.environmentId !== null) {
    const workspace = await deps.threads.workspacePath(mate.environmentId);
    if (workspace !== null) return workspace;
  }
  return homePath((await deps.settings()).homeDirectory);
}

/** The home, created if missing and prepared (`home.ts`) with the current settings. */
async function readyHome(settings: FirstmateSettings, home: string = homePath(settings.homeDirectory)): Promise<string> {
  await step(`The home ${home} could not be prepared`, async () => {
    await mkdir(home, { recursive: true });
    await prepareHome(home, homeConfig(settings));
  });
  return home;
}

/**
 * Prepares the home, registers it as the FirstMate project (or finds the project already there), and
 * starts a pinned first mate in it with the captain's opening. Refused when a first mate is already
 * aboard, so a second launch cannot start a second one.
 *
 * A failure before the thread exists leaves no stored id and names the step that failed. bb creates
 * the thread pinned in the same request, so there is no later step to fail between starting the first
 * mate and storing its id.
 */
export function launchMate(
  deps: MateDeps,
  pick: { providerId: string; model: string; reasoningLevel?: string },
): Promise<ThreadInfo> {
  return serialized(MATE_LOCK, async () => {
    const current = await resolveMate(deps);
    if (current !== null) throw aboard(current);

    const home = await readyHome(await deps.settings());
    const project = await step(`The ${PROJECT_NAME} project could not be registered at ${home}`, async () => {
      return (await deps.projects.findByPath(home)) ?? (await deps.projects.create(PROJECT_NAME, home));
    });
    const args: SpawnArgs = {
      projectId: project.id,
      title: MATE_TITLE,
      prompt: await readOpening(home),
      environment: { kind: "path", path: home },
      providerId: pick.providerId,
      model: pick.model,
      ...(pick.reasoningLevel === undefined || pick.reasoningLevel === "" ? {} : { reasoningLevel: pick.reasoningLevel }),
      metadata: { [CREW_METADATA.role]: CREW_METADATA.mateRole },
      pinned: true,
    };
    const mate = await step("The first mate could not be started", () => deps.threads.spawn(args));
    await deps.store.setMateThreadId(mate.id);
    return mate;
  });
}

/** Whether the thread's workspace is the home, compared through symlinks, on the bb server's machine. */
async function worksInHome(deps: MateDeps, thread: ThreadInfo, home: string): Promise<boolean> {
  if (thread.environmentId === null) return false;
  const workspace = await deps.threads.workspacePath(thread.environmentId);
  if (workspace === null) return false;
  const [a, b] = await Promise.all([canonicalPath(workspace), canonicalPath(home)]);
  return a === b;
}

/**
 * Makes an existing thread the first mate. Only a thread whose workspace is the home can be adopted:
 * the charter is the home's `AGENTS.md`, and the board opens the home's files through the first mate's
 * workspace, so a thread working anywhere else would never see the charter and the board would open
 * the wrong files. The home is prepared (the charter written) once the thread passes, and the thread
 * picks it up on its next session. Adopting the thread that already is the first mate is allowed and
 * changes nothing but the home.
 */
export function adoptMate(deps: MateDeps, threadId: string): Promise<ThreadInfo> {
  return serialized(MATE_LOCK, async () => {
    // Checked here rather than trusted from the panel: a launch may have finished while this waited.
    const current = await resolveMate(deps);
    if (current !== null && current.id !== threadId) throw aboard(current);
    const thread = await deps.threads.get(threadId);
    if (thread === null) throw new Error(`There is no thread ${threadId} to adopt: it does not exist or is archived.`);
    const settings = await deps.settings();
    const home = homePath(settings.homeDirectory);
    if (!(await worksInHome(deps, thread, home))) {
      throw new Error(`Only a thread working in the first mate's home (${home}) can be adopted.`);
    }
    await readyHome(settings);
    await deps.store.setMateThreadId(thread.id);
    return thread;
  });
}

/** Forgets the first mate. The thread and its crew are untouched. */
export function releaseMate(deps: MateDeps): Promise<void> {
  return serialized(MATE_LOCK, () => deps.store.setMateThreadId(null));
}

/**
 * The note a restart adds after the opening (`templates/messages/restart-note.md`). It stays out of
 * `data/opening.md` so that it is said whatever the captain's opening says.
 */
export function restartNote(): Promise<string> {
  return message(TEMPLATES.restartNote);
}

/**
 * Clears the first mate's context and starts it over with the opening and the restart note, on the
 * same thread: crew stay its children and keep notifying it, and two first mates cannot exist. The
 * home is prepared again first, so the charter carries the current settings. Refused unless the first
 * mate is idle or failed — a turn cut off halfway through a dispatch can leave a crewmate the records
 * never heard of.
 */
export function restartMate(deps: MateDeps): Promise<void> {
  return serialized(MATE_LOCK, async () => {
    const mate = await resolveMate(deps);
    if (mate === null) throw new Error("No first mate aboard.");
    if (mate.status !== "idle" && mate.status !== "error") throw new Error("Restart refused: the first mate is mid-turn.");
    // The first mate's own home, not the setting: it may name another home since the launch.
    const home = await readyHome(await deps.settings(), await activeHome(deps));
    const text = `${await readOpening(home)}\n\n${await restartNote()}`;
    await deps.threads.clearContext(mate.id);
    await deps.threads.send(mate.id, text, "auto");
  });
}

/**
 * Has bb compact the first mate's conversation — the structured `/compact` turn its composer sends — to
 * free context. Refused mid-turn, like restart: a compaction must be a turn of its own, and a send would
 * bury it inside the running one. bb itself accepts an idle or errored thread.
 */
export function compactMate(deps: MateDeps): Promise<void> {
  return serialized(MATE_LOCK, async () => {
    const mate = await resolveMate(deps);
    if (mate === null) throw new Error("No first mate aboard.");
    if (mate.status !== "idle" && mate.status !== "error") throw new Error("Compact refused: the first mate is mid-turn.");
    await deps.threads.compact(mate.id);
  });
}

export type MateCommand = "bearings";

/** The template for each request, with nothing after it and with something. */
const COMMANDS = {
  bearings: [TEMPLATES.bearings, TEMPLATES.bearingsArgs],
} as const;

/**
 * What Bearings sends, from `templates/messages/`: a plain request, which the charter defines,
 * rather than a slash command, which the first mate's own harness would take as its own. `args` is
 * whatever the captain typed after the command.
 */
export function commandText(command: MateCommand, args: string): Promise<string> {
  const extra = args.trim();
  const [plain, withArgs] = COMMANDS[command];
  return extra === "" ? message(plain) : message(withArgs, { args: extra });
}

/** Delivers the captain's words, joining the first mate's turn if it is mid-way through one. */
export async function askMate(deps: MateDeps, text: string): Promise<void> {
  const mate = await requireMate(deps);
  await deps.threads.send(mate.id, text, "auto");
}
