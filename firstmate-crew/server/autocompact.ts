/**
 * Autocompact: compacting the first mate's or a crewmate's conversation once it has sat idle with a large
 * context, so the next turn does not resend all of it after the provider's prompt cache has expired.
 * `server.ts` calls `checkAutoCompact` from its own service, once a minute.
 *
 * A thread is compacted when its rule is on, it is at rest (`isAtRest`), its context holds more than
 * `minTokens` tokens, and it has been idle long enough: until its prompt cache expired when bb says when
 * that is (`ContextUsage.cacheExpiresAt`), else `idleMinutes` after its last turn ended (the
 * `turn/completed` event's time in bb's event log, so a restart neither resets nor fakes the clock). Each
 * attempt leaves a mark in the store naming the turn that began the idle stretch, written before the
 * request goes to bb, and a marked thread is left alone until it has run a turn of its own since:
 * compaction is itself a turn, so that takes two turns after the mark when bb accepted the request, and
 * one when it refused it. Stale or
 * estimated usage therefore cannot loop, and a mark that cannot be written stops the compaction.
 *
 * One check sends at most one compaction, so after a long stop the backlog is worked through one thread a
 * minute rather than all at once. Every compaction runs under the `mate` lock, after checking that the
 * thread still belongs to the stored first mate, so a release or adoption that came first is respected.
 */
import { errorText, type Log } from "./log";
import type { ContextUsage, RestState, ThreadInfo, ThreadsPort, TurnEnd } from "./ports";
import type { AutoCompactRule, AutoCompactRules } from "./settings";
import type { CompactionMark, Store } from "./store";

/** How often `server.ts` checks. A whole minute is the settings' own granularity. */
export const AUTOCOMPACT_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;

/** The failure key for reading the first mate and its crew, before any one thread is looked at. */
const CHECK_KEY = "check";

export type AutoCompactRole = "mate" | "crew";

/**
 * Logs each failure once until it changes or clears, so a failure that lasts does not repeat a warning
 * every minute for every thread. Kept across checks; it remembers at most `limit` keys. At that limit a
 * new key is not admitted, and evicting none means none is logged again: one summary line says that
 * further failures go unlogged, until a remembered one clears and makes room.
 */
export class FailureLog {
  private readonly logged = new Map<string, string>();
  /** The summary was logged since the log last had room. */
  private overflowed = false;

  constructor(
    private readonly log: Log,
    private readonly limit = 1_000,
  ) {}

  warn(key: string, message: string): void {
    const known = this.logged.get(key);
    if (known === message) return;
    if (known === undefined && this.logged.size >= this.limit) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.log.warn(`Autocompact is failing for more than ${this.limit} threads; it logs no further failures until some recover.`);
      }
      return;
    }
    this.logged.set(key, message);
    this.log.warn(message);
  }

  /** The thing works again: its next failure is logged. */
  clear(key: string): void {
    this.logged.delete(key);
    this.makeRoom();
  }

  /** Forgets every key but these. */
  keepOnly(keys: ReadonlySet<string>): void {
    for (const key of [...this.logged.keys()]) if (!keys.has(key)) this.logged.delete(key);
    this.makeRoom();
  }

  get size(): number {
    return this.logged.size;
  }

  private makeRoom(): void {
    if (this.logged.size < this.limit) this.overflowed = false;
  }
}

/**
 * Runs `work` under the lock, or gives up with null as soon as `signal` aborts while it waits there, so
 * a stopping service settles without waiting on whatever holds the lock. The abandoned `work` still runs
 * when the lock frees, and must check the signal itself before doing anything.
 */
async function underLockUnlessAborted<T>(
  withLock: <R>(work: () => Promise<R>) => Promise<R>,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T | null> {
  if (signal.aborted) return null;
  const locked = withLock(work);
  let onAbort!: () => void;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([locked, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Once abandoned, nobody awaits it: its failure must not be an unhandled rejection.
    locked.catch(() => undefined);
  }
}

export interface AutoCompactDeps {
  threads: ThreadsPort;
  store: Store;
  rules: () => Promise<AutoCompactRules>;
  /** The lock the first mate's launch, adoption, release, restart and Compact button share. */
  withMateLock: <T>(work: () => Promise<T>) => Promise<T>;
  now: () => number;
  log: Log;
  failures: FailureLog;
  /** Aborted when the service stops: nothing is sent to bb after it, though an attempt already sent is recorded. */
  signal: AbortSignal;
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

export interface Due {
  lastTurn: TurnEnd;
  usage: ContextUsage;
  idleMinutes: number;
  /** What said the thread had been idle long enough: bb's cache deadline, or the idle-minutes setting. */
  deadline: "cache" | "setting";
}

/** What `assess` reads with. */
type AssessDeps = Pick<AutoCompactDeps, "threads" | "store" | "now" | "signal">;

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
async function ranTurnSinceMark(deps: AssessDeps, threadId: string, mark: CompactionMark): Promise<boolean> {
  // An accepted compaction runs a turn itself; the thread's own turn is the one after it.
  const needed = mark.ok ? 2 : 1;
  return (await deps.threads.turnsStartedAfter(threadId, mark.afterSeq, needed, deps.signal)) >= needed;
}

/**
 * The thread's case for compaction now, or null when it has none. Cheapest reads first; the context is
 * read before the idle time is judged, because it may carry bb's own deadline.
 */
async function assess(deps: AssessDeps, candidate: Candidate): Promise<Due | null> {
  const { thread, rule } = candidate;
  const { threads, signal } = deps;
  if (thread.status !== "idle") return null;
  const mark = await deps.store.compactionMark(thread.id);
  if (mark !== null && !(await ranTurnSinceMark(deps, thread.id, mark))) return null;
  const lastTurn = await threads.lastTurnEnd(thread.id, signal);
  if (lastTurn === null) return null;
  const usage = await threads.contextUsage(thread.id, signal);
  if (usage === null || usage.usedTokens <= rule.minTokens) return null;
  const now = deps.now();
  const deadline = usage.cacheExpiresAt ?? lastTurn.at + rule.idleMinutes * MINUTE_MS;
  if (now < deadline) return null;
  const state = await threads.restState(thread.id, signal);
  if (state === null || !isAtRest(state)) return null;
  return {
    lastTurn,
    usage,
    idleMinutes: Math.floor((now - lastTurn.at) / MINUTE_MS),
    deadline: usage.cacheExpiresAt === null ? "setting" : "cache",
  };
}

/** The case for a compaction, for the log: its size, its idle time, and what said that was long enough. */
export function dueText(due: Due): string {
  const estimate = due.usage.estimated ? " (estimated)" : "";
  const deadline = due.deadline === "cache" ? ", past bb's prompt-cache deadline" : "";
  return `${due.usage.usedTokens.toLocaleString("en-US")} tokens${estimate}, idle ${due.idleMinutes} minutes${deadline}`;
}

function describe(candidate: Candidate): string {
  const who = candidate.role === "mate" ? "the first mate" : "crewmate";
  const title = candidate.thread.title === null ? "" : ` "${candidate.thread.title}"`;
  return `${who} ${candidate.thread.id}${title}`;
}

/** Whether the thread is still the first mate `mateId`, or one of its crew, now that the lock is held. */
function stillAboard(candidate: Candidate, mateId: string, storedMateId: string | null, state: RestState): boolean {
  if (storedMateId !== mateId) return false;
  return candidate.role === "mate" ? candidate.thread.id === mateId : state.parentThreadId === mateId;
}

/**
 * Runs under the `mate` lock. Compacts the thread if it is still where `assess` found it: aboard the same
 * first mate, at rest, with no turn since, and the service still running. Null means nothing was sent;
 * a read or the mark's write failing before that rejects, and nothing is sent either. Once the request
 * is sent this never rejects: the attempt is the check's one, whatever its bookkeeping does.
 */
async function compact(deps: AutoCompactDeps, candidate: Candidate, mateId: string, due: Due): Promise<AutoCompaction | null> {
  const { threads, store, log, signal } = deps;
  const id = candidate.thread.id;
  if (signal.aborted) return null;
  const storedMateId = await store.mateThreadId();
  const state = await threads.restState(id, signal);
  if (state === null || !stillAboard(candidate, mateId, storedMateId, state) || !isAtRest(state)) return null;
  const lastTurn = await threads.lastTurnEnd(id, signal);
  if (lastTurn?.seq !== due.lastTurn.seq) return null;
  // A message sent meanwhile may have asked bb to compact first (`compact-first.ts`): its mark names
  // this same idle stretch.
  if ((await store.compactionMark(id))?.afterSeq === due.lastTurn.seq) return null;

  // Marked as accepted before it is sent, so a write that fails stops it, and a failure after it errs
  // on waiting for two turns.
  const mark: CompactionMark = { afterSeq: due.lastTurn.seq, ok: true, at: deps.now() };
  if (signal.aborted) return null;
  try {
    await store.setCompactionMark(id, mark);
  } catch (error) {
    throw new Error(`its mark could not be saved, so it was not compacted: ${errorText(error)}`, { cause: error });
  }
  if (signal.aborted) {
    await store.deleteCompactionMark(id).catch(() => undefined);
    return null;
  }

  let ok = true;
  try {
    await threads.compact(id);
  } catch (error) {
    ok = false;
    log.warn(`Autocompact could not compact ${describe(candidate)}: ${errorText(error)}. It is tried again after its next turn.`);
  }
  if (ok) {
    log.info(`Autocompact compacted ${describe(candidate)}: ${dueText(due)}.`);
  } else {
    try {
      await store.setCompactionMark(id, { ...mark, ok: false });
    } catch (error) {
      log.warn(`Autocompact could not note that bb refused to compact ${id}, so it waits for two turns instead of one: ${errorText(error)}`);
    }
  }
  return { threadId: id, role: candidate.role, usage: due.usage, idleMinutes: due.idleMinutes, ok };
}

/** The first mate and the candidates its rules allow, with the marks of anything else dropped. */
async function gather(deps: AutoCompactDeps, rules: AutoCompactRules): Promise<{ mateId: string; candidates: Candidate[] } | null> {
  const { threads, store, signal } = deps;
  const mateId = await store.mateThreadId();
  if (mateId === null) return null;
  const mate = await threads.get(mateId, signal);
  if (mate === null) return null;
  const crew = await threads.children(mate.id, signal);

  const live = new Set([mate.id, ...crew.map((thread) => thread.id)]);
  for (const id of await store.compactionMarkIds()) if (!live.has(id)) await store.deleteCompactionMark(id);

  const candidates: Candidate[] = [];
  if (rules.mate.enabled) candidates.push({ thread: mate, role: "mate", rule: rules.mate });
  if (rules.crew.enabled) candidates.push(...crew.map((thread) => ({ thread, role: "crew" as const, rule: rules.crew })));
  return { mateId: mate.id, candidates };
}

/** What `dueNow` reads with. */
export type DueNowDeps = Pick<AutoCompactDeps, "threads" | "store" | "rules" | "now">;

/**
 * The thread's case for compaction right now, by the same rules the check applies, or null: it is not the
 * first mate or one of its crew, its rule is off, or it is not due. For a message about to go to it
 * (`server/compact-first.ts`).
 */
export async function dueNow(deps: DueNowDeps, threadId: string): Promise<Due | null> {
  // The rules first: with autocompact off, nothing about the thread is read.
  const rules = await deps.rules();
  if (!rules.mate.enabled && !rules.crew.enabled) return null;
  const mateId = await deps.store.mateThreadId();
  if (mateId === null) return null;
  const thread = await deps.threads.get(threadId);
  if (thread === null) return null;
  const role: AutoCompactRole | null = thread.id === mateId ? "mate" : thread.parentThreadId === mateId ? "crew" : null;
  if (role === null) return null;
  const rule = rules[role];
  if (!rule.enabled) return null;
  return assess({ ...deps, signal: new AbortController().signal }, { thread, role, rule });
}

/**
 * One check: sends at most one compaction, to the first thread that is due — the first mate before its
 * crew. A thread whose reads fail is logged (once while the failure lasts) and skipped. Stops quietly once
 * the service's signal aborts.
 */
export async function checkAutoCompact(deps: AutoCompactDeps): Promise<AutoCompaction | null> {
  const { failures, signal } = deps;
  const rules = await deps.rules();
  if (!rules.mate.enabled && !rules.crew.enabled) {
    failures.keepOnly(new Set());
    return null;
  }

  let found: Awaited<ReturnType<typeof gather>>;
  try {
    found = await gather(deps, rules);
    failures.clear(CHECK_KEY);
  } catch (error) {
    if (!signal.aborted) failures.warn(CHECK_KEY, `Autocompact could not read the first mate and its crew: ${errorText(error)}`);
    return null;
  }
  if (found === null) return null;
  const { mateId, candidates } = found;
  failures.keepOnly(new Set([CHECK_KEY, ...candidates.map((candidate) => candidate.thread.id)]));

  for (const candidate of candidates) {
    if (signal.aborted) return null;
    const id = candidate.thread.id;
    try {
      const due = await assess(deps, candidate);
      const done = due === null ? null : await underLockUnlessAborted(deps.withMateLock, signal, () => compact(deps, candidate, mateId, due));
      failures.clear(id);
      if (done !== null) return done;
    } catch (error) {
      if (signal.aborted) return null;
      failures.warn(id, `Autocompact could not check ${describe(candidate)}: ${errorText(error)}`);
    }
  }
  return null;
}
