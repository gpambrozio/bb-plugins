// learning-exercises — the server entry.
//
// Offers a short learning exercise after real work (a commit, new files, a schema change, a merged pull
// request), decided from bb's thread events with no model involved; runs the accepted session in a
// fork of the work thread (or in the thread itself), with the question card, pause and resume; and keeps
// the record in the plugin's own SQLite. Nothing reaches an agent until the user starts a session: no
// skills, no tools and no instructions for any other thread. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { LEARNING_TAG, rpcContract } from "./shared/contract";
import { LearningApi } from "./server/api";
import { bbPorts, SESSION_METADATA_KEY } from "./server/bb-ports";
import { learningCli } from "./server/cli";
import { SESSION_INVARIANT } from "./server/content";
import { OfferEngine } from "./server/offers";
import type { Ports } from "./server/ports";
import { SessionService } from "./server/sessions";
import { readSettings, SETTINGS } from "./server/settings";
import { LearningStore, MIGRATIONS, OPEN_STATES } from "./server/store";
import { registerTools, TOOL_NAMES } from "./server/tools";

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
  bb.storage.migrate(db, MIGRATIONS);
  const store = new LearningStore(db);
  const changed = () => bb.rpc.experimental_invalidate([LEARNING_TAG]);
  const ports = (deps.ports ?? bbPorts)(bb, changed);
  const sessions = new SessionService(ports, store, settings);
  const offers = new OfferEngine({ ports, store, settings });
  const api = new LearningApi({ ports, store, offers, sessions, settings });
  bb.onDispose(() => sessions.dispose());

  // A card does not survive a reload or a restart; its session waits, paused, for Resume.
  sessions.pauseOrphanedCards();
  settingsHandle.onChange((next) => {
    current = readSettings(next);
    changed();
  });

  bb.rpc.register(rpcContract, {
    threadView: (input) => api.threadView(input),
    projectSessions: (input) => api.projectSessions(input),
    sessionDetail: (input) => api.sessionDetail(input),
    topicChoices: (input) => api.topicChoices(input),
    offerSeen: (input) => api.offerSeen(input),
    answerOffer: (input) => api.answerOffer(input),
    startSession: (input) => api.startSession(input),
    pauseSession: (input) => api.pauseSession(input),
    resumeSession: (input) => api.resumeSession(input),
    finishSession: (input) => api.finishSession(input),
    deleteSession: (input) => api.deleteSession(input),
    threadOffers: (input) => api.threadOffers(input),
    setThreadOffers: (input) => api.setThreadOffers(input),
    setProjectNever: (input) => api.setProjectNever(input),
    neverProjects: () => api.neverProjects(),
    removeNeverProject: (input) => api.removeNeverProject(input),
  });

  bb.cli.register(learningCli(sessions));
  registerTools(bb, sessions);

  // Zero context upfront: no skill folder, no instructions, and the tools only for a session's thread.
  // The metadata is only a hint (any client can write it); the store decides, and the tools check the
  // calling thread again on every call.
  bb.agents.configure((context) => {
    const sessionId = context.pluginMetadata[SESSION_METADATA_KEY];
    if (typeof sessionId !== "string") return { tools: [], skills: [] };
    const session = store.session(sessionId);
    const bound = session !== null && (session.threadId === context.thread.id || (session.threadId === null && session.sourceThreadId === context.thread.sourceThreadId));
    if (session === null || !bound || session.mode !== "fork" || !OPEN_STATES.includes(session.state)) return { tools: [], skills: [] };
    return { tools: [...TOOL_NAMES], skills: [], instructions: SESSION_INVARIANT };
  });

  const guard = (what: string, work: () => Promise<unknown> | unknown) => async () => {
    try {
      await work();
    } catch (error) {
      bb.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  bb.events.on("thread.active", ({ thread }) => guard("Noting a turn's start", () => offers.onActive(thread))());
  bb.events.on("thread.idle", ({ thread }) => guard("Weighing an offer", () => offers.onIdle(thread))());
  bb.events.on("thread.failed", ({ thread }) => guard("Clearing a failed turn", () => offers.threadGone(thread.id))());
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
}
