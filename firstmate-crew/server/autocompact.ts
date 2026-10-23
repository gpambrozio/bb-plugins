/**
 * Autocompact: compacting the first mate's or a crewmate's conversation once it has sat idle with a large
 * context, so the next turn does not resend all of it after the provider's prompt cache has expired.
 * `server.ts` calls `checkAutoCompact` from its own service, once a minute.
 *
 * A thread is compacted when its rule is on, it is at rest (`isAtRest`), its last turn ended at least
 * `idleMinutes` ago (the `turn/completed` event's time in bb's event log, so a restart neither resets nor
 * fakes the clock), and its context holds more than `minTokens` tokens. Each compaction leaves a mark in
 * the store naming the turn that began the idle stretch, and a marked thread is left alone until it has
 * run a turn of its own since: compaction is itself a turn, so that takes two turns after the mark when
 * bb accepted the request, and one when it refused it. Stale or estimated usage therefore cannot loop.
 *
 * One check compacts at most one thread, so after a long stop the backlog is worked through one thread a
 * minute rather than all at once.
 */
import { errorText, type Log } from "./log";
import type { ContextUsage, RestState, ThreadInfo, ThreadsPort, TurnEnd } from "./ports";
import type { AutoCompactRule, AutoCompactRules } from "./settings";
import type { CompactionMark, Store } from "./store";

/** How often `server.ts` checks. A whole minute is the settings' own granularity. */
export const AUTOCOMPACT_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;

export type AutoCompactRole = "mate" | "crew";

export interface AutoCompactDeps {
  threads: ThreadsPort;
  store: Store;
  rules: () => Promise<AutoCompactRules>;
  /** Runs the first mate's compaction under the lock its launch, restart and Compact button share. */
  withMateLock: <T>(work: () => Promise<T>) => Promise<T>;
  now: () => number;
  log: Log;
}

/** What one check did: the thread it asked bb to compact, and whether bb accepted. */
export interface AutoCompaction {
  threadId: string;
  role: AutoCompactRole;
  usage: ContextUsage;
  idleMinutes: number;
  ok: boolean;
}

interface Candidate {
  thread: ThreadInfo;
  role: AutoCompactRole;
  rule: AutoCompactRule;
}

interface Due {
  lastTurn: TurnEnd;
  usage: ContextUsage;
  idleMinutes: number;
}

/**
 * Nothing that would wake the thread is running or waiting: no turn, no queued message, no question,
 * permission or plan, no background agent, and its machine is there.
 */
export function isAtRest(state: RestState): boolean {
  return (
    state.status === "idle" &&
    state.runtimeStatus === "idle" &&
    state.queuedMessages === 0 &&
    state.pendingInteractions === 0 &&
    state.backgroundAgents === 0
  );
}

/** Whether the thread has run a turn of its own since its mark, so its new idle stretch may be compacted. */
async function ranTurnSinceMark(threads: ThreadsPort, threadId: string, mark: CompactionMark): Promise<boolean> {
  // An accepted compaction runs a turn itself; the thread's own turn is the one after it.
  const needed = mark.ok ? 2 : 1;
  return (await threads.turnsStartedAfter(threadId, mark.afterSeq, needed)) >= needed;
}

/** The thread's case for compaction now, or null when it has none. Cheapest reads first. */
async function assess(deps: AutoCompactDeps, candidate: Candidate, mark: CompactionMark | undefined): Promise<Due | null> {
  const { thread, rule } = candidate;
  if (thread.status !== "idle") return null;
  if (mark !== undefined && !(await ranTurnSinceMark(deps.threads, thread.id, mark))) return null;
  const lastTurn = await deps.threads.lastTurnEnd(thread.id);
  if (lastTurn === null) return null;
  const idleMs = deps.now() - lastTurn.at;
  if (idleMs < rule.idleMinutes * MINUTE_MS) return null;
  const usage = await deps.threads.contextUsage(thread.id);
  if (usage === null || usage.usedTokens <= rule.minTokens) return null;
  const state = await deps.threads.restState(thread.id);
  if (state === null || !isAtRest(state)) return null;
  return { lastTurn, usage, idleMinutes: Math.floor(idleMs / MINUTE_MS) };
}

function describe(candidate: Candidate): string {
  const who = candidate.role === "mate" ? "the first mate" : "crewmate";
  const title = candidate.thread.title === null ? "" : ` "${candidate.thread.title}"`;
  return `${who} ${candidate.thread.id}${title}`;
}

/**
 * Compacts the thread if it is still where `assess` found it: at rest, with no turn since. bb itself
 * refuses to compact a thread mid-turn; this also catches a message queued or a question asked meanwhile.
 * The mark is written whether bb accepts or refuses, so a refusal is not retried every minute.
 */
async function compact(deps: AutoCompactDeps, candidate: Candidate, due: Due, marks: Record<string, CompactionMark>): Promise<AutoCompaction | null> {
  const { threads, log } = deps;
  const id = candidate.thread.id;
  const state = await threads.restState(id);
  if (state === null || !isAtRest(state)) return null;
  const lastTurn = await threads.lastTurnEnd(id);
  if (lastTurn?.seq !== due.lastTurn.seq) return null;

  let ok = true;
  try {
    await threads.compact(id);
  } catch (error) {
    ok = false;
    log.warn(`Autocompact could not compact ${describe(candidate)}: ${errorText(error)}. It is tried again after its next turn.`);
  }
  await deps.store.setCompactions({ ...marks, [id]: { afterSeq: due.lastTurn.seq, ok, at: deps.now() } });
  if (ok) {
    const estimate = due.usage.estimated ? " (estimated)" : "";
    log.info(
      `Autocompact compacted ${describe(candidate)}: ${due.usage.usedTokens.toLocaleString("en-US")} tokens${estimate}, idle ${due.idleMinutes} minutes.`,
    );
  }
  return { threadId: id, role: candidate.role, usage: due.usage, idleMinutes: due.idleMinutes, ok };
}

/** The marks of threads that are still the first mate or one of its live crew; null when none was dropped. */
function liveMarks(marks: Record<string, CompactionMark>, live: Set<string>): Record<string, CompactionMark> | null {
  const kept = Object.fromEntries(Object.entries(marks).filter(([id]) => live.has(id)));
  return Object.keys(kept).length === Object.keys(marks).length ? null : kept;
}

/**
 * One check: compacts the first thread that is due — the first mate before its crew — and no other.
 * A thread whose reads fail is logged and skipped; the next check tries it again.
 */
export async function checkAutoCompact(deps: AutoCompactDeps): Promise<AutoCompaction | null> {
  const rules = await deps.rules();
  if (!rules.mate.enabled && !rules.crew.enabled) return null;
  const mateId = await deps.store.mateThreadId();
  if (mateId === null) return null;
  const mate = await deps.threads.get(mateId);
  if (mate === null) return null;
  const crew = await deps.threads.children(mate.id);

  let marks = await deps.store.compactions();
  const pruned = liveMarks(marks, new Set([mate.id, ...crew.map((thread) => thread.id)]));
  if (pruned !== null) {
    marks = pruned;
    await deps.store.setCompactions(marks);
  }

  const candidates: Candidate[] = [];
  if (rules.mate.enabled) candidates.push({ thread: mate, role: "mate", rule: rules.mate });
  if (rules.crew.enabled) candidates.push(...crew.map((thread) => ({ thread, role: "crew" as const, rule: rules.crew })));

  for (const candidate of candidates) {
    try {
      const due = await assess(deps, candidate, marks[candidate.thread.id]);
      if (due === null) continue;
      const run = () => compact(deps, candidate, due, marks);
      const done = candidate.role === "mate" ? await deps.withMateLock(run) : await run();
      if (done !== null) return done;
    } catch (error) {
      deps.log.warn(`Autocompact could not check ${describe(candidate)}: ${errorText(error)}`);
    }
  }
  return null;
}
