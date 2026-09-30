/**
 * FirstMate's server: the RPCs the panels call, `bb firstmate-crew`, the watch runner, and the thread
 * events that keep the board live.
 *
 * Every decision lives in `server/`; this file only wires it to bb. The ports over `bb.sdk` are built
 * on first use, from a handler, a service or a listener — never in the factory body.
 */
import { join } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { STATE_DIR } from "./shared/types";
import { bbProjects, bbThreads } from "./server/bb-ports";
import { acknowledgeCharter, NEW_CHARTER_FILE, writeNewCharter } from "./server/charter-file";
import { firstmateCli } from "./server/cli";
import { endCrew, interruptCrew, noteCrew, relaunchCrew, steerCrew } from "./server/crew";
import { loadFleet, ReportCache } from "./server/fleet";
import { isHomeReady, prepareHome, removeSuggestion } from "./server/home";
import { adoptMate, askMate, commandText, compactMate, launchMate, releaseMate, resolveMate, restartMate, type MateDeps } from "./server/mate";
import type { ProjectsPort, ThreadsPort } from "./server/ports";
import { serialized } from "./server/serialize";
import { homeConfig, homePath, SETTINGS } from "./server/settings";
import { createStore } from "./server/store";
import { createDeliver } from "./server/watch-delivery";
import { WatchRunner } from "./server/watches";

export { rpcContract } from "./shared/contract";

/** The channel the board listens on; any message means "load the fleet again". */
const FLEET_CHANNEL = "fleet";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves once the signal aborts, at once if it already has. */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  const store = createStore(bb.storage.kv);

  let threads: ThreadsPort | null = null;
  let projects: ProjectsPort | null = null;
  /** One set of dependencies for the RPCs, the CLI and the watches. The ports are made on first read. */
  const deps: MateDeps = {
    get threads() {
      return (threads ??= bbThreads(bb.sdk));
    },
    get projects() {
      return (projects ??= bbProjects(bb.sdk));
    },
    store,
    settings: () => settings.get(),
  };

  /** Crewmates' status lines, kept for the plugin's lifetime so the board's polls stay cheap. */
  let reports: ReportCache | null = null;
  const reportCache = () => (reports ??= new ReportCache(deps.threads));

  const currentHome = async () => homePath((await settings.get()).homeDirectory);

  function publishFleet(): void {
    bb.realtime.publish(FLEET_CHANNEL, { at: Date.now() });
  }

  // --- Watches -------------------------------------------------------------------------------------

  let runner: WatchRunner | null = null;
  /** True while the watch service runs, so a settings change rebuilds the runner only then. */
  let watching = false;

  /**
   * A runner for the home the setting names. It runs nothing until a launch has prepared that home
   * (`isHomeReady`), so a launch after load needs no rebuild. An unusable setting gives no runner.
   */
  function buildRunner(homeDirectory: string): WatchRunner | null {
    let home: string;
    try {
      home = homePath(homeDirectory);
    } catch (error) {
      bb.log.warn(`Watches are off: ${reason(error)}`);
      return null;
    }
    return new WatchRunner({
      home: async () => ((await isHomeReady(home)) ? home : null),
      disabled: () => store.disabledWatches(),
      deliver: createDeliver({
        // A getter, as in `deps`: bb.sdk is reached at delivery, never while the runner is built.
        get threads() {
          return deps.threads;
        },
        store,
        home,
        log: bb.log,
      }),
      stateFile: join(home, STATE_DIR, "watches.json"),
      scriptStateRoot: join(home, STATE_DIR, "watch-state"),
      log: bb.log,
    });
  }

  function stopRunner(): void {
    runner?.stop();
    runner = null;
  }

  function startRunner(homeDirectory: string): void {
    stopRunner();
    runner = buildRunner(homeDirectory);
    runner?.start();
  }

  /**
   * Brings a stored first mate's home up to this version of the plugin — `AGENTS.md` re-rendered, the
   * charter synced, the built-in watches seeded — so an upgrade reaches it without a launch. Only a
   * home a launch has already prepared is touched.
   */
  async function refreshHome(): Promise<void> {
    try {
      if ((await resolveMate(deps)) === null) return;
      const current = await settings.get();
      const home = homePath(current.homeDirectory);
      if (!(await isHomeReady(home))) return;
      await prepareHome(home, homeConfig(current));
    } catch (error) {
      bb.log.error(`The home could not be brought up to date on load: ${reason(error)}`);
    }
  }

  bb.background.service("watches", {
    async start(signal) {
      await refreshHome();
      if (signal.aborted) return;
      const current = await settings.get();
      watching = true;
      startRunner(current.homeDirectory);
      try {
        await untilAborted(signal);
      } finally {
        watching = false;
        stopRunner();
      }
    },
  });

  settings.onChange((next, prev) => {
    if (next.homeDirectory === prev.homeDirectory) return;
    if (watching) startRunner(next.homeDirectory);
    publishFleet();
  });

  // --- Thread events -------------------------------------------------------------------------------

  /** Whether the thread is the stored first mate, one of its children, or neither. */
  async function roleOf(thread: { id: string; parentThreadId: string | null }): Promise<"mate" | "crew" | null> {
    const mateId = await store.mateThreadId();
    if (mateId === null) return null;
    if (thread.id === mateId) return "mate";
    if (thread.parentThreadId === mateId) return "crew";
    return null;
  }

  /** Runs a listener's work; a failure is logged, never left to reject inside the bb server. */
  function listen(event: string, work: () => Promise<void>): Promise<void> {
    return work().catch((error: unknown) => {
      bb.log.error(`Handling ${event} failed: ${reason(error)}`);
    });
  }

  /** The events that change nothing but what the board shows. */
  function publishOnFleetThread(event: string, thread: { id: string; parentThreadId: string | null }): Promise<void> {
    return listen(event, async () => {
      if ((await roleOf(thread)) !== null) publishFleet();
    });
  }

  bb.events.on("thread.created", ({ thread }) => publishOnFleetThread("thread.created", thread));
  bb.events.on("thread.active", ({ thread }) => publishOnFleetThread("thread.active", thread));
  bb.events.on("thread.failed", ({ thread }) => publishOnFleetThread("thread.failed", thread));
  bb.events.on("thread.archived", ({ thread }) => publishOnFleetThread("thread.archived", thread));
  // A crewmate waiting on a permission or a question moves to Blocked now, not at the next poll.
  bb.events.on("interaction.pending", ({ thread }) => publishOnFleetThread("interaction.pending", thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    listen("thread.idle", async () => {
      const role = await roleOf(thread);
      if (role === null) return;
      // The turn's closing text is in hand, so the board's next load needs no fetch for it.
      if (role === "crew") reportCache().remember(thread.id, thread.updatedAt, lastAssistantText);
      publishFleet();
      // The first mate's turn has ended: whatever the watches queued meanwhile can go now.
      if (role === "mate") await runner?.flush();
    }),
  );

  // --- RPCs and the CLI ----------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    "fleet.load": () =>
      loadFleet({
        ...deps,
        reports: reportCache(),
        watches: () => (runner === null ? Promise.resolve([]) : runner.summaries()),
        log: bb.log,
      }),
    "mate.launch": async (pick) => {
      const mate = await launchMate(deps, pick);
      publishFleet();
      return { threadId: mate.id };
    },
    "mate.adopt": async ({ threadId }) => {
      await adoptMate(deps, threadId);
      publishFleet();
      return null;
    },
    "mate.release": async () => {
      await releaseMate(deps);
      publishFleet();
      return null;
    },
    "mate.restart": async () => {
      await restartMate(deps);
      return null;
    },
    "mate.compact": async () => {
      await compactMate(deps);
      return null;
    },
    "mate.command": async ({ command, args }) => {
      await askMate(deps, await commandText(command, args));
      return null;
    },
    "mate.ask": async ({ text }) => {
      await askMate(deps, text);
      return null;
    },
    "crew.steer": async ({ threadId, text }) => {
      await steerCrew(deps, threadId, text);
      return null;
    },
    "crew.interrupt": async ({ threadId }) => {
      await interruptCrew(deps, threadId);
      return null;
    },
    "crew.end": ({ threadId, confirmed }) => endCrew(deps, threadId, confirmed),
    "crew.relaunch": async ({ threadId, note }) => {
      await relaunchCrew(deps, threadId, note);
      return null;
    },
    "crew.note": async ({ threadId, note }) => {
      await noteCrew(deps, threadId, note);
      return null;
    },
    "suggestion.remove": async (suggestion) => removeSuggestion(await currentHome(), suggestion),
    "charter.compare": async () => {
      await writeNewCharter(await currentHome());
      return { path: NEW_CHARTER_FILE };
    },
    "charter.acknowledge": async () => {
      await acknowledgeCharter(await currentHome());
      return null;
    },
    "watch.toggle": async ({ name, enabled }) => {
      // Read and written as one step, so two quick toggles cannot undo each other.
      await serialized("watches-toggle", async () => {
        const off = new Set(await store.disabledWatches());
        if (enabled) off.delete(name);
        else off.add(name);
        await store.setDisabledWatches([...off].sort());
      });
      return runner === null ? [] : runner.summaries();
    },
  });

  bb.cli.register(firstmateCli(deps));

  bb.onDispose(() => {
    watching = false;
    stopRunner();
  });
}
