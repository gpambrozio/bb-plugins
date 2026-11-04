/**
 * The offer engine (report v2 §1, feature #1): bb's thread events in, at most one live offer per
 * thread out.
 *
 * - `thread.active`: a turn started. Any unanswered offer in the thread expires, and the workspace's
 *   HEAD is noted so the turn's commits can be read when it ends.
 * - `thread.idle`: a turn ended. The gate and the caps (`policy.ts`) decide, over what the turn did
 *   (`signals.ts`): its commits (HEAD moved; the Git plugin lists them), its new and changed files (the
 *   event log's `fileChange` items and the commits' files) and a merged pull request.
 * - An hourly read catches a pull request merged on github.com after its thread went quiet.
 *
 * A commit is not this turn's when another thread in the same workspace had a turn overlapping it
 * (spike S4: a thread that only slept saw HEAD move when its neighbour committed).
 */
import type { Offer, OfferAnswer } from "../shared/types";
import { afterAnswer, decideOffer, isHumanThread, OFFER_TTL_MS, projectKey, snoozeAfterLater, type GateThread } from "./policy";
import type { Ports, ThreadInfo } from "./ports";
import { candidates, PathRules, relativize, type Candidate, type FileChange, type TurnFacts } from "./signals";
import type { LearningSettings } from "./settings";
import type { LearningStore } from "./store";

/** The thread facts a lifecycle event carries (bb's `ThreadResponse`). */
export interface EventThread extends GateThread {
  id: string;
  projectId: string;
  providerId: string;
  environmentId: string | null;
  title: string | null;
  titleFallback?: string | null;
  status: string;
}

interface TurnStart {
  environmentId: string;
  /** HEAD when the turn started; null when the Git plugin could not say. */
  headSha: string | null;
  startedAt: number;
}

interface Window {
  threadId: string;
  start: number;
  end: number | null;
}

/** How long a finished turn's window is kept for the overlap check. */
const WINDOW_TTL_MS = 6 * 60 * 60_000;

export interface OfferEngineOptions {
  ports: Ports;
  store: LearningStore;
  settings: () => LearningSettings;
}

function toThreadInfo(thread: EventThread): ThreadInfo {
  return {
    id: thread.id,
    projectId: thread.projectId,
    providerId: thread.providerId,
    environmentId: thread.environmentId,
    title: thread.title ?? thread.titleFallback ?? null,
    status: thread.status,
    parentThreadId: thread.parentThreadId,
    originPluginId: thread.originPluginId,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
    visibility: thread.visibility,
    archivedAt: thread.archivedAt,
  };
}

export class OfferEngine {
  private readonly turns = new Map<string, TurnStart>();
  private readonly windows = new Map<string, Window[]>();
  private readonly ports: Ports;
  private readonly store: LearningStore;
  private readonly settings: () => LearningSettings;

  constructor(options: OfferEngineOptions) {
    this.ports = options.ports;
    this.store = options.store;
    this.settings = options.settings;
  }

  // ── turn boundaries ───────────────────────────────────────────────────────

  async onActive(event: EventThread): Promise<void> {
    const thread = toThreadInfo(event);
    const now = this.ports.now();
    if (this.store.expireThreadOffers(thread.id) > 0) this.ports.changed();
    if (thread.environmentId === null) return;
    const windows = this.windows.get(thread.environmentId) ?? [];
    windows.push({ threadId: thread.id, start: now, end: null });
    this.windows.set(thread.environmentId, windows.filter((window) => window.end === null || now - window.end < WINDOW_TTL_MS));
    if (!isHumanThread(thread) || !this.settings().offersEnabled) return;
    const turn: TurnStart = { environmentId: thread.environmentId, headSha: null, startedAt: now };
    this.turns.set(thread.id, turn);
    turn.headSha = await this.ports.headSha(thread.environmentId);
  }

  async onIdle(event: EventThread): Promise<Offer | null> {
    const thread = toThreadInfo(event);
    const now = this.ports.now();
    const turn = this.turns.get(thread.id) ?? null;
    this.turns.delete(thread.id);
    const overlapped = thread.environmentId === null ? false : this.closeWindow(thread.environmentId, thread.id, turn?.startedAt ?? null, now);
    if (!isHumanThread(thread)) return null;
    return this.evaluate(thread, { turn, overlapped });
  }

  /** Closes the thread's window; answers whether another thread's turn overlapped it. */
  private closeWindow(environmentId: string, threadId: string, startedAt: number | null, now: number): boolean {
    const windows = this.windows.get(environmentId) ?? [];
    const own = [...windows].reverse().find((window) => window.threadId === threadId && window.end === null);
    if (own !== undefined) own.end = now;
    const start = startedAt ?? own?.start ?? now;
    return windows.some((window) => window.threadId !== threadId && window.start < now && (window.end === null || window.end > start));
  }

  // ── deciding ──────────────────────────────────────────────────────────────

  private async evaluate(thread: ThreadInfo, input: { turn: TurnStart | null; overlapped: boolean; merged?: { url: string; title: string } }): Promise<Offer | null> {
    const settings = this.settings();
    const lastTurn = input.merged === undefined ? await this.ports.lastTurn(thread.id) : null;
    const turnCompleted = input.merged !== undefined || lastTurn?.status === "completed";
    const needsChanges = settings.triggers.newFiles || settings.triggers.schema || settings.triggers.streak;
    const root = thread.environmentId === null ? null : await this.ports.environmentPath(thread.environmentId);
    const fileChanges: FileChange[] =
      settings.offersEnabled && needsChanges && lastTurn !== null && turnCompleted
        ? (await this.ports.turnFileChanges(thread.id, lastTurn.turnId)).flatMap((change) => {
            const path = relativize(change.path, root);
            return path === null ? [] : [{ kind: change.kind, path }];
          })
        : [];
    const readsCommits = settings.offersEnabled && (settings.triggers.commit || settings.triggers.newFiles || settings.triggers.schema);
    const commits = readsCommits ? await this.turnCommits(input.turn, input.overlapped) : { commits: [], files: [] };
    const changed = fileChanges.length > 0 || commits.commits.length > 0;
    const row = input.merged === undefined && lastTurn !== null && turnCompleted ? this.store.countTurn(thread.id, changed) : this.store.thread(thread.id);
    if (!settings.offersEnabled) return null;

    const merged = input.merged ?? (settings.triggers.prMerged ? await this.mergedPullRequest(thread) : null);
    const project = await this.ports.project(thread.projectId);
    const key = projectKey(project ?? { id: thread.projectId, gitRemoteUrl: null });
    const facts: TurnFacts = {
      commits: commits.commits,
      committedFiles: commits.files,
      fileChanges,
      mergedPullRequest: merged,
      changedTurnsSinceOffer: row.changedTurnsSinceOffer,
      threadTitle: thread.title ?? "",
    };
    const found: Candidate[] = candidates(facts, settings.triggers, { exclude: new PathRules(settings.excludePatterns), schema: new PathRules(settings.schemaPatterns) }, settings.streakTurns);
    if (found.length === 0) return null;
    const now = this.ports.now();
    const decision = decideOffer({
      now,
      settings,
      projectNever: this.store.isNever(key),
      thread: {
        optOut: row.optOut,
        finishedSessions: this.store.finishedSessionsFrom(thread.id),
        openSession: this.store.openSessionFrom(thread.id) !== null || this.store.sessionInThread(thread.id) !== null,
        snoozeUntil: row.snoozeUntil,
        snoozeUntilTurn: row.snoozeUntilTurn,
        completedTurns: row.completedTurns,
      },
      turnCompleted,
      interactionPending: await this.ports.interactionPending(thread.id),
      sessionActiveInProject: this.store.sessionActiveInProject(key),
      global: this.store.global(now),
      candidates: found,
    });
    if ("skip" in decision) return null;
    const offer = this.store.createOffer({ threadId: thread.id, projectKey: key, trigger: decision.offer.trigger, topic: decision.offer.topic, refs: decision.offer.refs, now });
    this.store.resetChangedTurns(thread.id);
    this.ports.changed();
    return offer;
  }

  /** The turn's own commits: none when HEAD did not move, could not be read, or moved under another thread too. */
  private async turnCommits(turn: TurnStart | null, overlapped: boolean): Promise<{ commits: TurnFacts["commits"]; files: TurnFacts["committedFiles"] }> {
    if (turn === null || turn.headSha === null || overlapped) return { commits: [], files: [] };
    const head = await this.ports.headSha(turn.environmentId);
    if (head === null || head === turn.headSha) return { commits: [], files: [] };
    return (await this.ports.commitsSince(turn.environmentId, turn.headSha)) ?? { commits: [], files: [] };
  }

  /**
   * The thread's pull request, when it went from open or draft to merged since the last read. Each read
   * is remembered per workspace with the thread that last ran there, for the hourly check.
   */
  private async mergedPullRequest(thread: ThreadInfo): Promise<{ url: string; title: string } | null> {
    if (thread.environmentId === null) return null;
    const pull = await this.ports.pullRequest(thread.environmentId);
    const before = this.store.pullRequestState(thread.environmentId);
    if (pull === null) return null;
    this.store.setPullRequestState(thread.environmentId, pull.state === "merged" || pull.state === "closed" ? null : { state: pull.state, threadId: thread.id });
    const wasOpen = before !== null && (before.state === "open" || before.state === "draft");
    return pull.state === "merged" && wasOpen ? { url: pull.url, title: pull.title } : null;
  }

  /** The hourly read: a pull request merged while its thread sat idle gets its offer then. */
  async checkPullRequests(): Promise<number> {
    const settings = this.settings();
    if (!settings.offersEnabled || !settings.triggers.prMerged) return 0;
    let offered = 0;
    for (const watched of this.store.watchedPullRequests()) {
      const pull = await this.ports.pullRequest(watched.environmentId);
      if (pull === null || pull.state === "open" || pull.state === "draft") {
        if (pull !== null && pull.state !== watched.state) this.store.setPullRequestState(watched.environmentId, { state: pull.state, threadId: watched.threadId });
        continue;
      }
      this.store.setPullRequestState(watched.environmentId, null);
      if (pull.state !== "merged") continue;
      const thread = await this.ports.thread(watched.threadId);
      if (thread === null || !isHumanThread(thread) || thread.status !== "idle") continue;
      const offer = await this.evaluate(thread, { turn: null, overlapped: false, merged: { url: pull.url, title: pull.title } });
      if (offer !== null) offered += 1;
    }
    return offered;
  }

  // ── answers ───────────────────────────────────────────────────────────────

  /** The banner or the tab drew the offer: from now it counts toward the caps. */
  seen(offerId: string): boolean {
    const now = this.ports.now();
    if (!this.store.markSeen(offerId, now)) return false;
    this.store.recordSeen(now);
    return true;
  }

  /**
   * Answers an offer. `start` and `here` are recorded here and started by the caller; the others apply
   * at once: Later snoozes the thread and counts toward the back-off, "Not in this thread" turns the
   * thread's offers off, "Never for this project" adds the project to the never list.
   */
  async answer(offerId: string, answer: OfferAnswer): Promise<Offer & { projectKey: string }> {
    const offer = this.store.offer(offerId);
    if (offer === null || offer.status !== "live") throw new Error("That offer is no longer open.");
    const now = this.ports.now();
    this.store.answerOffer(offerId, answer, now);
    // An answer is a look: an offer answered from the tab before the banner reported it still counts.
    if (offer.seenAt === null) this.store.recordSeen(now);
    const global = this.store.global(now);
    if (answer === "later") {
      const row = this.store.thread(offer.threadId);
      const snooze = snoozeAfterLater(now, row.completedTurns);
      this.store.snooze(offer.threadId, snooze.snoozeUntil, snooze.snoozeUntilTurn);
      this.store.setBackoff(afterAnswer(global, "later", now));
    } else if (answer === "start" || answer === "here") {
      this.store.setBackoff(afterAnswer(global, "start", now));
    } else if (answer === "not-thread") {
      this.store.setOptOut(offer.threadId, true);
    } else if (answer === "never-project") {
      const thread = await this.ports.thread(offer.threadId);
      const project = thread === null ? null : await this.ports.project(thread.projectId);
      this.store.setNever(offer.projectKey, project?.name ?? offer.projectKey, true);
    }
    this.ports.changed();
    return offer;
  }

  /** The hourly sweep: offers nobody answered within a day are gone. */
  expireOld(): number {
    const threads = this.store.expireOffersBefore(this.ports.now() - OFFER_TTL_MS);
    if (threads.length > 0) this.ports.changed();
    return threads.length;
  }

  threadGone(threadId: string): void {
    this.turns.delete(threadId);
    if (this.store.expireThreadOffers(threadId) > 0) this.ports.changed();
  }
}
