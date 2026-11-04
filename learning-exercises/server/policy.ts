/**
 * When an offer may be made (report v2 §1.3): the gate, the caps and the back-off, as pure functions
 * over plain facts. Every check is a field comparison; none asks a model. The caps live here, in the
 * server, not in an agent's memory as upstream's do.
 */
import type { Candidate } from "./signals";
import { PLUGIN_ID } from "../shared/types";
import type { LearningSettings } from "./settings";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "Later" snoozes the thread until both have passed. */
export const SNOOZE_MS = 45 * MINUTE;
export const SNOOZE_TURNS = 3;
/** This many "Later" answers in a row turn the low-signal triggers off for `BACKOFF_MS`. */
export const BACKOFF_AFTER_LATERS = 3;
export const BACKOFF_MS = 7 * DAY;
/** Triggers that still fire during a back-off. */
export const BACKOFF_KEEPS: readonly Candidate["trigger"][] = ["commit", "pr-merged"];
/** An offer nobody answered is gone after this, seen or not. */
export const OFFER_TTL_MS = DAY;

/** The thread facts the gate reads; the shape of bb's `ThreadResponse` fields used. */
export interface GateThread {
  parentThreadId: string | null;
  originPluginId: string | null;
  lifecycleOwnerThreadId: string | null;
  visibility: string;
  archivedAt: number | null;
}

/**
 * A top-level thread a person drives: not a child, not started by a plugin (automations, diff-review
 * runs, side chats, this plugin's own sessions), not owned by another thread, not hidden, not archived.
 */
export function isHumanThread(thread: GateThread): boolean {
  return (
    thread.parentThreadId === null &&
    thread.originPluginId === null &&
    thread.lifecycleOwnerThreadId === null &&
    thread.visibility === "visible" &&
    thread.archivedAt === null
  );
}

/**
 * Where the learner may start a session by hand: any visible, unarchived thread except this plugin's own
 * session threads. Wider than `isHumanThread` on purpose: a child (sub-agent) thread gets no offers, but
 * the learner can open the Learning tab there on demand and start one with that thread as the source.
 */
export function canStartByHand(thread: GateThread): boolean {
  return thread.originPluginId !== PLUGIN_ID && thread.visibility === "visible" && thread.archivedAt === null;
}

export interface ThreadState {
  optOut: boolean;
  /** Sessions started from this thread that finished. */
  finishedSessions: number;
  /** A session that lives in or was started from this thread and is not finished. */
  openSession: boolean;
  snoozeUntil: number | null;
  snoozeUntilTurn: number | null;
  completedTurns: number;
}

export interface GlobalState {
  /** When each seen offer was first seen, newest last. */
  seenAt: readonly number[];
  consecutiveLaters: number;
  backoffUntil: number | null;
}

export interface OfferInputs {
  now: number;
  settings: LearningSettings;
  projectNever: boolean;
  thread: ThreadState;
  turnCompleted: boolean;
  interactionPending: boolean;
  /** A session in this project is mid-question or mid-turn somewhere. */
  sessionActiveInProject: boolean;
  global: GlobalState;
  candidates: readonly Candidate[];
}

export type OfferDecision = { offer: Candidate } | { skip: string };

export function seenInLastDay(seenAt: readonly number[], now: number): number {
  return seenAt.filter((at) => now - at < DAY).length;
}

export function decideOffer(input: OfferInputs): OfferDecision {
  const { now, settings, thread, global } = input;
  if (!settings.offersEnabled) return { skip: "offers are off" };
  if (input.projectNever) return { skip: "never for this project" };
  if (thread.optOut) return { skip: "off for this thread" };
  if (!input.turnCompleted) return { skip: "the turn did not complete" };
  if (input.interactionPending) return { skip: "a question is waiting for the user" };
  if (thread.openSession) return { skip: "a session is open for this thread" };
  if (input.sessionActiveInProject) return { skip: "a session is running in this project" };
  if (thread.finishedSessions >= settings.sessionsPerThread) return { skip: "this thread had its sessions" };
  if (thread.snoozeUntil !== null && now < thread.snoozeUntil) return { skip: "snoozed" };
  if (thread.snoozeUntilTurn !== null && thread.completedTurns < thread.snoozeUntilTurn) return { skip: "snoozed" };
  if (seenInLastDay(global.seenAt, now) >= settings.offersPerDay) return { skip: "the daily limit is reached" };
  const lastSeen = global.seenAt.at(-1);
  if (lastSeen !== undefined && now - lastSeen < settings.hoursBetweenOffers * HOUR) return { skip: "too soon after the last offer" };
  const backingOff = global.backoffUntil !== null && now < global.backoffUntil;
  const allowed = backingOff ? input.candidates.filter((candidate) => BACKOFF_KEEPS.includes(candidate.trigger)) : input.candidates;
  const first = allowed[0];
  return first === undefined ? { skip: backingOff && input.candidates.length > 0 ? "backing off" : "nothing to offer" } : { offer: first };
}

/**
 * Why an offer already made can no longer be shown or answered, seen or not: offers turned off, the
 * project or the thread opted out, a session open for the thread, or the offer is a day old.
 */
export function offerStanding(input: {
  now: number;
  settings: LearningSettings;
  projectNever: boolean;
  optOut: boolean;
  openSession: boolean;
  createdAt: number;
}): string | null {
  if (!input.settings.offersEnabled) return "offers are off";
  if (input.projectNever) return "never for this project";
  if (input.optOut) return "off for this thread";
  if (input.openSession) return "a session is open for this thread";
  if (input.now - input.createdAt >= OFFER_TTL_MS) return "the offer is a day old";
  return null;
}

/**
 * Why an offer nobody has seen yet may not become visible now: the caps and the back-off, applied when
 * it is about to show, not only when it was made (offers made in quiet threads would all show at once).
 */
export function offerCaps(input: {
  now: number;
  settings: LearningSettings;
  trigger: Candidate["trigger"] | "manual";
  finishedSessions: number;
  global: GlobalState;
}): string | null {
  const { now, settings, global } = input;
  if (input.finishedSessions >= settings.sessionsPerThread) return "this thread had its sessions";
  if (seenInLastDay(global.seenAt, now) >= settings.offersPerDay) return "the daily limit is reached";
  const lastSeen = global.seenAt.at(-1);
  if (lastSeen !== undefined && now - lastSeen < settings.hoursBetweenOffers * HOUR) return "too soon after the last offer";
  const backingOff = global.backoffUntil !== null && now < global.backoffUntil;
  if (backingOff && input.trigger !== "manual" && !BACKOFF_KEEPS.includes(input.trigger)) return "backing off";
  return null;
}

/** The snooze "Later" sets on a thread. */
export function snoozeAfterLater(now: number, completedTurns: number): { snoozeUntil: number; snoozeUntilTurn: number } {
  return { snoozeUntil: now + SNOOZE_MS, snoozeUntilTurn: completedTurns + SNOOZE_TURNS };
}

/** The global state after an answer: "Later" counts toward the back-off, "Start" resets the count. */
export function afterAnswer(global: GlobalState, answer: "later" | "start" | "other", now: number): Pick<GlobalState, "consecutiveLaters" | "backoffUntil"> {
  if (answer === "start") return { consecutiveLaters: 0, backoffUntil: global.backoffUntil };
  if (answer !== "later") return { consecutiveLaters: global.consecutiveLaters, backoffUntil: global.backoffUntil };
  const laters = global.consecutiveLaters + 1;
  if (laters >= BACKOFF_AFTER_LATERS) return { consecutiveLaters: 0, backoffUntil: now + BACKOFF_MS };
  return { consecutiveLaters: laters, backoffUntil: global.backoffUntil };
}

/**
 * The key a project is remembered by (history, "never for this project"): its normalised git remote,
 * so the same repository checked out as two projects is one; the project id when it has no remote.
 */
export function projectKey(project: { id: string; gitRemoteUrl: string | null }): string {
  const remote = project.gitRemoteUrl?.trim();
  if (remote === undefined || remote === "") return `project:${project.id}`;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(remote);
  let host: string;
  let path: string;
  if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(remote);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return `remote:${remote.toLowerCase()}`;
    }
  }
  const cleaned = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return `remote:${host.toLowerCase()}/${cleaned.toLowerCase()}`;
}
