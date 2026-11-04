/**
 * The RPC handlers behind `shared/contract.ts`: what the banner, the tab and the thread menu read and
 * change. Inputs come from the app, so every id is checked against the store before anything acts on it.
 */
import type { RpcContract } from "../shared/contract";
import type { Session, ThreadView, TopicChoice } from "../shared/types";
import type { OfferEngine } from "./offers";
import { isHumanThread, projectKey } from "./policy";
import type { Ports, ThreadInfo } from "./ports";
import type { SessionService } from "./sessions";
import { SessionError } from "./sessions";
import type { LearningSettings } from "./settings";
import { relativize } from "./signals";
import { OPEN_STATES, publicSession, type LearningStore } from "./store";

type Input<M extends keyof RpcContract> = import("zod").infer<RpcContract[M]["input"]>;
type Output<M extends keyof RpcContract> = import("zod").infer<RpcContract[M]["output"]>;

export interface ApiDeps {
  ports: Ports;
  store: LearningStore;
  offers: OfferEngine;
  sessions: SessionService;
  settings: () => LearningSettings;
}

export class LearningApi {
  constructor(private readonly deps: ApiDeps) {}

  private async requireThread(threadId: string): Promise<ThreadInfo> {
    const thread = await this.deps.ports.thread(threadId);
    if (thread === null) throw new SessionError("That thread is gone.");
    return thread;
  }

  private async keyOf(thread: ThreadInfo): Promise<{ key: string; name: string }> {
    const project = await this.deps.ports.project(thread.projectId);
    return { key: projectKey(project ?? { id: thread.projectId, gitRemoteUrl: null }), name: project?.name ?? "this project" };
  }

  async threadView({ threadId }: Input<"threadView">): Promise<Output<"threadView">> {
    const { store } = this.deps;
    const thread = await this.requireThread(threadId);
    const { key, name } = await this.keyOf(thread);
    const hosted = store.sessionInThread(threadId);
    const started = store.openSessionFrom(threadId);
    const view: ThreadView = {
      eligible: isHumanThread(thread),
      offer: isHumanThread(thread) ? store.liveOffer(threadId) : null,
      hosted: hosted === null ? null : publicSession(hosted),
      started: started === null || started.id === hosted?.id ? null : publicSession(started),
      offersOn: !store.thread(threadId).optOut,
      projectKey: key,
      projectName: name,
      projectNever: store.isNever(key),
      offersOffGlobally: !this.deps.settings().offersEnabled,
    };
    return view;
  }

  async projectSessions({ threadId, limit }: Input<"projectSessions">): Promise<Output<"projectSessions">> {
    const thread = await this.requireThread(threadId);
    const { key } = await this.keyOf(thread);
    const max = limit ?? 20;
    const previous = this.deps.store.sessionsInProject(key, ["finished", "abandoned"], max + 1);
    return {
      paused: this.deps.store.sessionsInProject(key, ["paused"], 50).map(publicSession),
      previous: previous.slice(0, max).map(publicSession),
      hasMore: previous.length > max,
    };
  }

  sessionDetail({ sessionId }: Input<"sessionDetail">): Output<"sessionDetail"> {
    const session = this.deps.store.session(sessionId);
    if (session === null) throw new SessionError("That session is gone.");
    return { session: publicSession(session), exercises: this.deps.store.exercises(sessionId) };
  }

  /** Topics from data only: the thread's live offer, the branch's latest commit, the last turn's new files, its title. */
  async topicChoices({ threadId }: Input<"topicChoices">): Promise<Output<"topicChoices">> {
    const { ports, store } = this.deps;
    const thread = await this.requireThread(threadId);
    const choices: TopicChoice[] = [];
    const offer = store.liveOffer(threadId);
    if (offer !== null) choices.push({ id: "offer", label: offer.topic, topic: offer.topic, trigger: offer.trigger, refs: offer.refs });
    if (thread.environmentId !== null) {
      const [latest, ...older] = await ports.branchCommits(thread.environmentId);
      if (latest !== undefined) {
        const topic = `"${latest.subject}"`;
        if (!choices.some((choice) => choice.topic === topic)) {
          choices.push({ id: "commit", label: `The last commit: ${topic}`, topic, trigger: "manual", refs: { commits: [latest, ...older].slice(0, 5) } });
        }
      }
      const turn = await ports.lastTurn(threadId);
      if (turn !== null) {
        const root = await ports.environmentPath(thread.environmentId);
        const added = [...new Set((await ports.turnFileChanges(threadId, turn.turnId)).filter((change) => change.kind === "add").flatMap((change) => relativize(change.path, root) ?? []))];
        if (added.length > 0) {
          const shown = added.slice(0, 2).map((path) => `\`${path}\``).join(" and ");
          const topic = `the new ${shown}${added.length > 2 ? ` and ${added.length - 2} more` : ""}`;
          choices.push({ id: "files", label: `Files from the last turn: ${shown}`, topic, trigger: "manual", refs: { paths: added.slice(0, 20) } });
        }
      }
    }
    if (thread.title !== null && thread.title.trim() !== "") {
      choices.push({ id: "title", label: `This thread: "${thread.title}"`, topic: `"${thread.title}"`, trigger: "manual", refs: {} });
    }
    return { choices };
  }

  offerSeen({ offerId }: Input<"offerSeen">): null {
    if (this.deps.offers.seen(offerId)) this.deps.ports.changed();
    return null;
  }

  async answerOffer({ offerId, answer }: Input<"answerOffer">): Promise<Output<"answerOffer">> {
    const offer = await this.deps.offers.answer(offerId, answer);
    if (answer !== "start" && answer !== "here") return { threadId: null };
    const started = await this.deps.sessions.start({
      sourceThreadId: offer.threadId,
      topic: offer.topic,
      trigger: offer.trigger,
      refs: offer.refs,
      offerId: offer.id,
      mode: answer === "here" ? "here" : "auto",
    });
    return { threadId: started.threadId };
  }

  async startSession(input: Input<"startSession">): Promise<Output<"startSession">> {
    const thread = await this.requireThread(input.threadId);
    // A manual start answers the thread's live offer, so the banner goes away.
    const offer = this.deps.store.liveOffer(thread.id);
    if (offer !== null) this.deps.store.answerOffer(offer.id, input.here === true ? "here" : "start", this.deps.ports.now());
    const started = await this.deps.sessions.start({
      sourceThreadId: thread.id,
      topic: input.topic,
      trigger: input.trigger,
      refs: input.refs,
      offerId: offer?.id ?? null,
      mode: input.here === true ? "here" : "auto",
    });
    return { threadId: started.threadId };
  }

  pauseSession({ sessionId }: Input<"pauseSession">): null {
    this.requireOpen(sessionId);
    this.deps.sessions.pause(sessionId, "user");
    return null;
  }

  async resumeSession({ sessionId }: Input<"resumeSession">): Promise<Output<"resumeSession">> {
    await this.deps.sessions.resume(sessionId);
    const session = this.deps.store.session(sessionId);
    return { threadId: session?.threadId ?? "" };
  }

  async finishSession({ sessionId }: Input<"finishSession">): Promise<null> {
    this.requireOpen(sessionId);
    await this.deps.sessions.finishFromUser(sessionId);
    return null;
  }

  deleteSession({ sessionId }: Input<"deleteSession">): null {
    if (this.deps.store.session(sessionId) === null) throw new SessionError("That session is gone.");
    this.deps.sessions.deleteSession(sessionId);
    return null;
  }

  private requireOpen(sessionId: string): Session {
    const session = this.deps.store.session(sessionId);
    if (session === null) throw new SessionError("That session is gone.");
    if (!OPEN_STATES.includes(session.state)) throw new SessionError("That session is already over.");
    return session;
  }

  threadOffers({ threadIds }: Input<"threadOffers">): Output<"threadOffers"> {
    return { off: [...this.deps.store.optOuts(threadIds)] };
  }

  setThreadOffers({ threadId, on }: Input<"setThreadOffers">): null {
    this.deps.store.setOptOut(threadId, !on);
    if (!on) this.deps.store.expireThreadOffers(threadId);
    this.deps.ports.changed();
    return null;
  }

  async setProjectNever({ threadId, never }: Input<"setProjectNever">): Promise<null> {
    const thread = await this.requireThread(threadId);
    const { key, name } = await this.keyOf(thread);
    this.deps.store.setNever(key, name, never);
    this.deps.ports.changed();
    return null;
  }

  neverProjects(): Output<"neverProjects"> {
    return { projects: this.deps.store.neverProjects() };
  }

  removeNeverProject({ key }: Input<"removeNeverProject">): null {
    const entry = this.deps.store.neverProjects().find((project) => project.key === key);
    if (entry !== undefined) this.deps.store.setNever(key, entry.name, false);
    this.deps.ports.changed();
    return null;
  }
}

