// learning-exercises — the server entry.
//
// Offers a short learning exercise after real work (a commit, new files, a schema change, a merged pull
// request), decided from bb's thread events with no model involved; runs the accepted session in a
// fork of the work thread (or in the thread itself), with the question card, pause and resume; builds a
// repo orientation in a hidden builder thread on request and runs an orientation session on it; and keeps
// the record in the plugin's own SQLite. Nothing reaches an agent until the user starts a session or a
// build: no skills, no tools and no instructions for any other thread. See AGENTS.md.
import { experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";

import { LEARNING_TAG, rpcContract } from "./shared/contract";
import { LearningApi } from "./server/api";
import { bbPorts, SESSION_METADATA_KEY } from "./server/bb-ports";
import { learningCli } from "./server/cli";
import { ORIENT_TOOL_INVARIANT, SESSION_INVARIANT } from "./server/content";
import { OfferEngine } from "./server/offers";
import { ORIENTATION_METADATA_KEY, OrientationError, OrientationService } from "./server/orientation";
import { OrientationApi } from "./server/orientation-api";
import { ORIENT_TOOL_NAMES, registerOrientationTools } from "./server/orientation-tools";
import { OrientationStore } from "./server/orientation-store";
import type { Ports } from "./server/ports";
import { SessionError, SessionService } from "./server/sessions";
import { readSettings, SETTINGS } from "./server/settings";
import { LearningStore, MIGRATIONS, OPEN_STATES, reconcileOpenSessions } from "./server/store";
import { registerTools, TOOL_NAMES } from "./server/tools";
import { LIVE_ORIENTATION_STATUSES, type OrientationStatus } from "./shared/orientation";
import { PLUGIN_ID } from "./shared/types";

export { rpcContract };

/** The plugin with bb's ports replaced, for tests; bb loads the default export, which runs the real one. */
export function learningPlugin(deps: { ports?: (bb: BbPluginApi, changed: () => void) => Ports } = {}) {
  return (bb: BbPluginApi) => plugin(bb, deps);
}

export default learningPlugin();

async function plugin(bb: BbPluginApi, deps: { ports?: (bb: BbPluginApi, changed: () => void) => Ports }): Promise<void> {
  const settingsHandle = bb.settings.define(SETTINGS);
  // Settings are read once here and kept current by onChange; the engine reads them synchronously.
  let current = readSettings(await settingsHandle.get());
  const settings = () => current;

  const db = bb.storage.database();
  const reconciled = reconcileOpenSessions(db, Date.now());
  if (reconciled > 0) bb.log.warn(`Closed ${reconciled} duplicate open learning session(s) left by an earlier version; their answers are kept.`);
  bb.storage.migrate(db, MIGRATIONS);
  const store = new LearningStore(db);
  const changed = () => bb.rpc.experimental_invalidate([LEARNING_TAG]);
  const ports = (deps.ports ?? bbPorts)(bb, changed);
  const orientationStore = new OrientationStore(db);
  const sessions = new SessionService(ports, store, settings);
  const orientations = new OrientationService(ports, orientationStore, settings);
  const offers = new OfferEngine({ ports, store, settings });
  const api = new LearningApi({ ports, store, offers, sessions, settings });
  const orientationApi = new OrientationApi({ ports, sessions, orientations, orientationStore });
  bb.onDispose(() => sessions.dispose());
  bb.onDispose(() => orientations.dispose());

  // A card does not survive a reload or a restart; its session waits, paused, for Resume.
  sessions.pauseOrphanedCards();
  settingsHandle.onChange((next) => {
    current = readSettings(next);
    // Turning offers off takes the offers already made with it.
    if (!current.offersEnabled) store.expireLiveOffers(null);
    // A plugin added to the never-offer list takes the offers in its threads with it.
    else void guard("Dropping offers the never-offer list now rules out", () => offers.dropIneligible())();
    changed();
  });

  // The changes are the user's to make from the app: another plugin calling through
  // `bb.sdk.plugins.callRpc` (bb verifies that caller) is refused. Reads stay open.
  const fromUser = <I, O>(work: (input: I) => O) => (input: I, ctx?: ExperimentalPluginRpcHandlerContext): O => {
    if (ctx?.experimental_caller?.kind === "plugin") {
      throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Learning Exercises' offers and sessions are changed from its own app only." });
    }
    return work(input);
  };
  // An orientation's (or a session's) refusal reaches the app as a refusal, not as a plugin crash.
  const refusing = <I, O>(work: (input: I) => Promise<O> | O) => async (input: I): Promise<O> => {
    try {
      return await work(input);
    } catch (error) {
      if (error instanceof OrientationError || error instanceof SessionError) throw new experimental_PluginRpcRefusal({ code: "conflict", message: error.message });
      throw error;
    }
  };

  bb.rpc.register(rpcContract, {
    threadView: (input) => api.threadView(input),
    projectSessions: (input) => api.projectSessions(input),
    sessionDetail: (input) => api.sessionDetail(input),
    feedbackCards: (input) => api.feedbackCards(input),
    topicChoices: (input) => api.topicChoices(input),
    offerSeen: fromUser((input) => api.offerSeen(input)),
    answerOffer: fromUser((input) => api.answerOffer(input)),
    startSession: fromUser((input) => api.startSession(input)),
    cardDraft: (input) => api.cardDraft(input),
    saveDraft: fromUser((input) => api.saveDraft(input)),
    openQuestions: (input) => api.openQuestions(input),
    pauseSession: fromUser((input) => api.pauseSession(input)),
    resumeSession: fromUser((input) => api.resumeSession(input)),
    finishSession: fromUser((input) => api.finishSession(input)),
    deleteSession: fromUser((input) => api.deleteSession(input)),
    threadOffers: (input) => api.threadOffers(input),
    setThreadOffers: fromUser((input) => api.setThreadOffers(input)),
    setProjectNever: fromUser((input) => api.setProjectNever(input)),
    neverProjects: () => api.neverProjects(),
    removeNeverProject: fromUser((input) => api.removeNeverProject(input)),
    orientation: refusing((input) => orientationApi.orientation(input)),
    orientationDocument: refusing((input) => orientationApi.orientationDocument(input)),
    startOrientation: fromUser(refusing((input) => orientationApi.startOrientation(input))),
    cancelOrientation: fromUser(refusing((input) => orientationApi.cancelOrientation(input))),
    deleteOrientation: fromUser(refusing((input) => orientationApi.deleteOrientation(input))),
    verifyOrientation: fromUser(refusing((input) => orientationApi.verifyOrientation(input))),
    exportOrientation: fromUser(refusing((input) => orientationApi.exportOrientation(input))),
    startOrientationSession: fromUser(refusing((input) => orientationApi.startOrientationSession(input))),
  });

  bb.cli.register(learningCli(sessions, orientations));
  registerTools(bb, sessions);
  registerOrientationTools(bb, orientations);

  // Zero context upfront: no skill folder, no instructions, and tools only for a session's own thread
  // and for an orientation's builder. The metadata is only a hint (any client can write it); the store
  // decides, and the tools check the calling thread again on every call.
  bb.agents.configure((context) => {
    const none = { tools: [], skills: [] };
    const sessionId = context.pluginMetadata[SESSION_METADATA_KEY];
    if (typeof sessionId === "string") {
      const session = store.session(sessionId);
      if (session === null || !OPEN_STATES.includes(session.state)) return none;
      // Unbound: a fork may resolve before `fork` answers (bound by its source), a spawned session thread
      // before `spawn` answers (only while the session is starting).
      const bound =
        session.threadId === context.thread.id ||
        (session.threadId === null && session.mode === "fork" && session.sourceThreadId === context.thread.sourceThreadId) ||
        (session.threadId === null && session.mode === "spawn" && session.state === "starting");
      if (!bound || (session.mode !== "fork" && session.mode !== "spawn")) return none;
      return { tools: [...TOOL_NAMES], skills: [], instructions: SESSION_INVARIANT };
    }
    const orientationId = context.pluginMetadata[ORIENTATION_METADATA_KEY];
    if (typeof orientationId === "string") {
      const row = orientationStore.get(orientationId);
      if (row === null || !(LIVE_ORIENTATION_STATUSES as readonly OrientationStatus[]).includes(row.status)) return none;
      // The builder may resolve before `spawn` answers, while the row is still `starting` and unbound.
      const bound = row.builderThreadId === context.thread.id || (row.builderThreadId === null && row.status === "starting");
      if (!bound) return none;
      return { tools: [...ORIENT_TOOL_NAMES], skills: [], instructions: ORIENT_TOOL_INVARIANT };
    }
    return none;
  });

  const guard = (what: string, work: () => Promise<unknown> | unknown) => async () => {
    try {
      await work();
    } catch (error) {
      bb.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // A builder never reaches the offer engine. Only a thread this plugin may have started goes to the
  // orientation service (a bound builder, or one of this plugin's threads it has not bound yet), so an
  // idle in any other thread costs no bb read.
  const mayBuild = (thread: { id: string; originPluginId: string | null }) => orientations.isBuilderThread(thread.id) || thread.originPluginId === PLUGIN_ID;
  bb.events.on("thread.active", ({ thread }) =>
    guard("Noting a turn's start", () => {
      if (orientations.isBuilderThread(thread.id)) return;
      return offers.onActive(thread);
    })(),
  );
  bb.events.on("thread.idle", ({ thread }) =>
    guard("Weighing an offer", async () => {
      if (mayBuild(thread)) await orientations.onIdle(thread.id);
      if (orientations.isBuilderThread(thread.id)) return;
      await offers.onIdle(thread);
    })(),
  );
  bb.events.on("thread.failed", ({ thread }) =>
    guard("Clearing a failed turn", async () => {
      if (mayBuild(thread)) await orientations.onFailed(thread.id);
      if (orientations.isBuilderThread(thread.id)) return;
      offers.threadGone(thread.id);
    })(),
  );
  bb.events.on("thread.archived", ({ thread }) =>
    guard("Pausing an archived thread's session", () => {
      offers.threadGone(thread.id);
      sessions.threadArchived(thread.id);
    })(),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    guard("Closing a deleted thread's session", () => {
      offers.threadGone(thread.id);
      sessions.threadDeleted(thread.id);
    })(),
  );

  bb.background.schedule("hourly-sweep", "17 * * * *", guard("The hourly sweep", async () => {
    offers.expireOld();
    sessions.abandonStale();
    await offers.checkPullRequests();
  }));
  // Cancels builds past their 30 minutes, purges old failed ones, and retries an unfinished clean-up.
  bb.background.schedule("orientation-sweep", "*/5 * * * *", guard("The orientation sweep", () => orientations.sweep()));

  // Settles the builders an earlier copy left; starts are refused until it has (never throws into bb).
  void guard("Cleaning up orientation builders", () => orientations.reconcile())();
}
