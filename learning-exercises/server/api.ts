/**
 * The RPC handlers behind `shared/contract.ts`: what the banner, the tab and the thread menu read and
 * change. Inputs come from the app, so every id is checked against the store before anything acts on it.
 */
import type { RpcContract } from "../shared/contract";
import type { Session, ThreadView, TopicChoice } from "../shared/types";
import type { OfferEngine } from "./offers";
import { canStartByHand, isHumanThread, projectKey } from "./policy";
import type { Ports, ThreadInfo } from "./ports";
import type { SessionService } from "./sessions";
import { SessionError } from "./sessions";
import type { LearningSettings } from "./settings";
import { relativize } from "./signals";
import { OPEN_STATES, publicSession, type LearningStore } from "./store";
import { workspaceOf } from "./workspace";

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
      canStart: canStartByHand(thread),
      offer: isHumanThread(thread) ? this.deps.offers.visibleOffer(threadId) : null,
      hosted: hosted === null ? null : publicSession(hosted),
      started: started === null || started.id === hosted?.id ? null : publicSession(started),
      offersOn: !store.thread(threadId).optOut,
      projectKey: key,
      projectName: name,
      projectNever: store.isNever(key),
      offersOffGlobally: !this.deps.settings().offersEnabled,
      sessionWhere: this.deps.settings().sessionLocation === "fork" && (await this.deps.ports.canFork(thread.providerId)) ? "fork" : "here",
      workspace: await workspaceOf(this.deps.ports, thread),
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

  /**
   * A session's questions resolve their file references against the session thread's workspace, or the
   * source thread's once that one is gone (an archived fork's environment has no folder any more).
   */
  async sessionDetail({ sessionId }: Input<"sessionDetail">): Promise<Output<"sessionDetail">> {
    const { ports, store } = this.deps;
    const session = store.session(sessionId);
    if (session === null) throw new SessionError("That session is gone.");
    let workspace = session.threadId === null ? null : await workspaceOf(ports, session.threadId);
    if (workspace === null && session.sourceThreadId !== null) workspace = await workspaceOf(ports, session.sourceThreadId);
    // The history is built from the thread's stored messages too: a reply no read kept is read now.
    await this.deps.sessions.recoverReplies(sessionId);
    return { session: publicSession(session), exercises: store.exercises(sessionId), workspace };
  }

  async feedbackCards({ threadId }: Input<"feedbackCards">): Promise<Output<"feedbackCards">> {
    const { ports, store } = this.deps;
    const cards = store.feedbackCards(threadId);
    // Most threads ran no session: they cost one query and no bb read.
    if (cards.length === 0) return { cards: [] };
    const workspace = await workspaceOf(ports, threadId);
    return { cards: cards.map((card) => ({ ...card, workspace })) };
  }

  cardDraft({ sessionId, ordinal }: Input<"cardDraft">): Output<"cardDraft"> {
    const { sessions } = this.deps;
    return { draft: sessions.cardDraft(sessionId, ordinal), ...sessions.draftStamp(sessionId, ordinal) };
  }

  saveDraft({ sessionId, ordinal, draft, writer }: Input<"saveDraft">): Output<"saveDraft"> {
    const { sessions } = this.deps;
    const saved = sessions.saveDraft(sessionId, ordinal, draft, writer);
    return { saved, token: saved ? sessions.draftToken(sessionId, ordinal) : null };
  }

  openQuestions({ questions }: Input<"openQuestions">): Output<"openQuestions"> {
    return { open: this.deps.sessions.openQuestions(questions) };
  }

  /** Topics from data only: the thread's live offer, the branch's latest commit, the last turn's new files, its title. */
  async topicChoices({ threadId }: Input<"topicChoices">): Promise<Output<"topicChoices">> {
    const { ports, store } = this.deps;
    const thread = await this.requireThread(threadId);
    const choices: TopicChoice[] = [];
    const offer = store.liveOffer(threadId);
    if (offer !== null) choices.push({ id: "offer", label: offer.topic, topic: offer.topic, trigger: offer.trigger, refs: offer.refs });
    if (thread.environmentId !== null) {
      const branch = await ports.branchCommits(thread.environmentId);
      // On a default branch nothing is ahead: the commits this thread's own turns made, as recorded.
      const [latest, ...older] = branch.length > 0 ? branch : store.lastCommits(threadId);
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

  /** The view drew the offer: claim it against the caps as they are now (a refused claim drops it). */
  offerSeen({ offerId }: Input<"offerSeen">): Output<"offerSeen"> {
    return { visible: this.deps.offers.claim(offerId) };
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
    // A manual start answers the thread's live offer the way the banner's Start does (claimed and
    // charged once, the run of Laters reset), so the banner goes away. An offer that may no longer be
    // answered is dropped; the user asked for this session either way.
    const live = this.deps.store.liveOffer(thread.id);
    let offerId: string | null = null;
    if (live !== null) {
      try {
        offerId = (await this.deps.offers.answer(live.id, input.here === true ? "here" : "start")).id;
      } catch {
        if (this.deps.store.expireOffer(live.id)) this.deps.ports.changed();
      }
    }
    const started = await this.deps.sessions.start({
      sourceThreadId: thread.id,
      topic: input.topic,
      trigger: input.trigger,
      refs: input.refs,
      offerId,
      mode: input.here === true ? "here" : "auto",
    });
    if (offerId === null) this.deps.offers.accepted();
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
    if (never) this.deps.store.expireLiveOffers(key);
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

