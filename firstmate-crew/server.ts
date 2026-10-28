/**
 * FirstMate's server: the RPCs the panels call, `bb firstmate-crew`, the watch runner, and the thread
 * events that keep the board live.
 *
 * Every decision lives in `server/`; this file only wires it to bb. The ports over `bb.sdk` are built
 * on first use, from a handler, a service or a listener — never in the factory body.
 */
import { join } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { FLEET_TAG, rpcContract } from "./shared/contract";
import { STATE_DIR } from "./shared/types";
import { AUTOCOMPACT_INTERVAL_MS, checkAutoCompact, FailureLog } from "./server/autocompact";
import { bbProjects, bbThreads } from "./server/bb-ports";
import { acknowledgeCharter, NEW_CHARTER_FILE, writeNewCharter } from "./server/charter-file";
import { firstmateCli } from "./server/cli";
import { endCrew, interruptCrew, noteCrew, relaunchCrew, steerCrew } from "./server/crew";
import { loadFleet, ReportCache } from "./server/fleet";
import { dismissSuggestion, isHomeReady, prepareHome, removeSuggestion } from "./server/home";
import {
  activeHome,
  adoptMate,
  askMate,
  commandText,
  compactMate,
  launchMate,
  releaseMate,
  resolveMate,
  restartMate,
  withMateLock,
  type MateDeps,
} from "./server/mate";
import type { ProjectsPort, ThreadsPort } from "./server/ports";
import { serialized } from "./server/serialize";
import { autoCompactRules, DEFAULT_REFRESH_SECONDS, homeConfig, homePath, refreshMs, SETTINGS } from "./server/settings";
import { createStore } from "./server/store";
import { createDeliver } from "./server/watch-delivery";
import { readWatchNote } from "./server/watch-notes";
import { WatchRunner } from "./server/watches";

export { rpcContract } from "./shared/contract";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves once the signal aborts, at once if it already has. */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Resolves after `ms`, or as soon as the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
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
    log: bb.log,
  };

  /** Crewmates' status lines, kept for the plugin's lifetime so the board's polls stay cheap. */
  let reports: ReportCache | null = null;
  const reportCache = () => (reports ??= new ReportCache(deps.threads));

  /** The first mate's own home while one is aboard, else the setting's (`activeHome`). */
  const currentHome = () => activeHome(deps);

  /** Every open board reads the fleet again (bb's live reads, tag `fleet`). */
  function publishFleet(): void {
    bb.rpc.experimental_invalidate([FLEET_TAG]);
  }

  // --- Watches -------------------------------------------------------------------------------------

  let runner: WatchRunner | null = null;
  /** The home `runner` works in, so a sync that finds the same home leaves it running. */
  let runnerHome: string | null = null;
  /** True while the watch service runs, so a change of home rebuilds the runner only then. */
  let watching = false;
  /** Runner changes, one at a time: a new runner starts only once the one before it has stopped. */
  let runnerChange: Promise<void> = Promise.resolve();

  /**
   * A runner for the home: the first mate's own, or the setting's with none aboard (`activeHome`). It
   * runs nothing until a launch has prepared that home (`isHomeReady`). An unusable setting gives no runner.
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
        rules: async () => autoCompactRules(await settings.get()),
        withMateLock,
      }),
      root: home,
      stateFile: join(home, STATE_DIR, "watches.json"),
      scriptStateRoot: join(home, STATE_DIR, "watch-state"),
      log: bb.log,
    });
  }

  /**
   * Brings the runner in step with the home — after a launch, adoption or release, a change of the home
   * setting, and when the service starts or stops. The old runner is stopped and drained before a new
   * one reads the state file, so a delivery it had under way cannot overwrite what the new one saves.
   */
  function syncRunner(): Promise<void> {
    const change = runnerChange.then(async () => {
      let home: string | null = null;
      if (watching) {
        try {
          home = await activeHome(deps);
        } catch (error) {
          bb.log.warn(`Watches are off: ${reason(error)}`);
        }
      }
      if (home !== null && home === runnerHome && runner !== null) return;
      const previous = runner;
      runner = null;
      runnerHome = null;
      await previous?.stop();
      if (home === null) return;
      runner = buildRunner(home);
      runnerHome = runner === null ? null : home;
      runner?.start();
    });
    runnerChange = change.catch((error: unknown) => bb.log.error(`The watch runner could not be changed: ${reason(error)}`));
    return runnerChange;
  }

  /**
   * Brings a stored first mate's home up to this version of the plugin — `AGENTS.md` re-rendered, the
   * charter synced, the built-in watches seeded — so an upgrade reaches it without a launch. Only a
   * home a launch has already prepared is touched.
   */
  async function refreshHome(): Promise<void> {
    try {
      if ((await resolveMate(deps)) === null) return;
      const home = await activeHome(deps);
      if (!(await isHomeReady(home))) return;
      await prepareHome(home, homeConfig(await settings.get()));
    } catch (error) {
      bb.log.error(`The home could not be brought up to date on load: ${reason(error)}`);
    }
  }

  bb.background.service("watches", {
    async start(signal) {
      await refreshHome();
      if (signal.aborted) return;
      watching = true;
      await syncRunner();
      try {
        await untilAborted(signal);
      } finally {
        watching = false;
        await syncRunner();
      }
    },
  });

  // --- Autocompact --------------------------------------------------------------------------------

  /**
   * Checks once a minute, the first time a minute after loading, so a reload's new instance does not check
   * while the old one is being disposed. Each check reads bb afresh and compacts at most one thread
   * (`server/autocompact.ts`). The service's signal goes into the check, so a check under way when the
   * plugin stops or reloads sends nothing more to bb.
   */
  const autoCompactFailures = new FailureLog(bb.log);
  bb.background.service("autocompact", {
    async start(signal) {
      while (!signal.aborted) {
        await pause(AUTOCOMPACT_INTERVAL_MS, signal);
        if (signal.aborted) return;
        try {
          await checkAutoCompact({
            threads: deps.threads,
            store,
            rules: async () => autoCompactRules(await settings.get()),
            withMateLock,
            now: Date.now,
            log: bb.log,
            failures: autoCompactFailures,
            signal,
          });
        } catch (error) {
          if (!signal.aborted) autoCompactFailures.warn("settings", `Autocompact's check failed: ${reason(error)}`);
        }
      }
    },
  });

  settings.onChange((next, prev) => {
    if (next.homeDirectory === prev.homeDirectory) return;
    // With a first mate aboard the runner stays in its home; with none it follows the setting.
    if (watching) void syncRunner();
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
  // A thread moved under the first mate, or off it, joins or leaves the board now (bb 0.46.1).
  bb.events.on("experimental_thread.parentChanged", ({ thread, previousParentThreadId }) =>
    listen("experimental_thread.parentChanged", async () => {
      const mateId = await store.mateThreadId();
      if (mateId === null) return;
      if (thread.parentThreadId === mateId || previousParentThreadId === mateId) publishFleet();
    }),
  );
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
      void syncRunner();
      publishFleet();
      return { threadId: mate.id };
    },
    "mate.adopt": async ({ threadId }) => {
      await adoptMate(deps, threadId);
      void syncRunner();
      publishFleet();
      return null;
    },
    "mate.release": async () => {
      await releaseMate(deps);
      void syncRunner();
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
    "suggestion.dismiss": async (suggestion) => dismissSuggestion(await currentHome(), suggestion),
    "charter.compare": async () => {
      await writeNewCharter(await currentHome());
      return { path: NEW_CHARTER_FILE };
    },
    "charter.acknowledge": async () => {
      await acknowledgeCharter(await currentHome());
      return null;
    },
    "watch.note": async ({ file }) => readWatchNote(await currentHome(), file),
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

  /**
   * While any board is open, every `refreshSeconds` it reads the fleet again, for what no event reports (a
   * backlog edit, a status line, a watch's last run). One wait on the server for every window, run by bb
   * while the read is watched: it ends when the last board closes, or on bb 0.48 is hidden.
   */
  bb.rpc.experimental_whileWatched("fleet.load", async (_read, signal) => {
    while (!signal.aborted) {
      let wait: number;
      try {
        wait = refreshMs(await settings.get());
      } catch (error) {
        bb.log.warn(`The board refresh setting could not be read: ${reason(error)}`);
        wait = DEFAULT_REFRESH_SECONDS * 1000;
      }
      await pause(wait, signal);
      if (!signal.aborted) publishFleet();
    }
  });

  bb.cli.register(firstmateCli(deps));

  // Waits for the runner to drain, so a reload's new instance cannot read the state file mid-save.
  bb.onDispose(async () => {
    watching = false;
    await syncRunner();
  });
}
