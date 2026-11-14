/**
 * The runs of speech on this machine, and the hooks around them. This is the
 * one place the after hook is owed, so it cannot be lost with a window:
 *
 * - **One session per machine.** The first run opened runs `before`; a run
 *   opened while the session is up joins it (two windows, a press during an
 *   announcement) and waits for that `before`. `after` runs once, when the
 *   last open run ends, and always after `before` has finished.
 * - **Every run ends.** By its window's `end`; by its lease running out, when
 *   the window stopped renewing (closed, reloaded, lost the server); or by
 *   `dispose`, when the worker goes (a plugin reload, disable or removal, the
 *   daemon shutting down) — within bb's disposal budget (`DISPOSE_BUDGET_MS`).
 * - **Order-proof.** bb does not deliver concurrent host calls in order, so an
 *   `end` can arrive before its `begin`: an ended run id is remembered, and a
 *   `begin` for it opens nothing. `end` and `renew` are safe to repeat.
 * - **A new session waits for the last one's `after`**, so a quick next
 *   sentence cannot have its `before` undone by the previous `after`.
 *
 * Each open run holds a worker lease, released once its end (and any `after`
 * it ran) is done, so an idle-worker stop cannot drop an owed `after`.
 */
import type { HookRun, SpeechHookKind } from "../shared/speech-hooks";

export interface Lease {
  dispose(): Promise<void>;
}

export interface SessionsDeps {
  /** Runs one hook command, within `timeoutMs` when given; never rejects (`host/run-hook.ts`). */
  run(kind: SpeechHookKind, command: string, timeoutMs?: number): Promise<HookRun>;
  /** Kills the hooks still running, or those of `kind`; their runs resolve as killed. */
  kill(kind?: SpeechHookKind): void;
  /** A run ended by its lease running out, and the `after` that ran then (or null). */
  expired(runId: string, after: HookRun | null): void;
  now?: () => number;
}

interface OpenRun {
  timer: ReturnType<typeof setTimeout>;
  lease: Lease;
}

interface Session {
  runs: Map<string, OpenRun>;
  /** Every run that was ever open in this session, for the report of its after hook. */
  runIds: string[];
  before: Promise<HookRun | null>;
  after: string;
}

/** A session whose after hook is running: what a dispose arriving meanwhile waits for and reports. */
interface Closing {
  runIds: string[];
  after: Promise<HookRun | null>;
}

/** How long an ended run id is remembered, against a `begin` that arrives late. */
export const ENDED_MEMORY_MS = 10 * 60_000;

/**
 * How long `dispose` may take, all in. bb gives a worker 5 s to dispose
 * before it exits it (and its daemon SIGKILLs it at about the same moment),
 * so cleanup must be done well inside that: a before hook still running is
 * killed at once, the after hook gets this long instead of its usual 5 s,
 * and anything still running when it is up is killed.
 */
export const DISPOSE_BUDGET_MS = 3_000;

/** What `dispose` did: the runs it ended, and the after hook it ran for them (null when none was owed or set). */
export interface DisposeReport {
  runIds: string[];
  after: HookRun | null;
}

export class HookSessions {
  private session: Session | null = null;
  /** The last session's `after`, while it runs; a new session's `before` waits for it. */
  private closing: Promise<unknown> = Promise.resolve();
  /** The session whose after hook is still running, until it has finished; null otherwise. */
  private inFlight: Closing | null = null;
  private readonly ended = new Map<string, number>();
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: SessionsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Opens `runId`. `lease` keeps the worker alive while it is open; it is
   * disposed here when the run is not opened. Resolves once this session's
   * `before` has finished, with its result for the run that started it.
   */
  async begin(
    input: { runId: string; before: string; after: string; leaseMs: number },
    lease: Lease,
  ): Promise<{ open: boolean; before: HookRun | null }> {
    await this.closing;
    if (this.disposed || this.ended.has(input.runId) || this.session?.runs.has(input.runId) === true) {
      await lease.dispose();
      return { open: this.session?.runs.has(input.runId) === true, before: null };
    }
    let session = this.session;
    const opened = session === null;
    if (session === null) {
      const before = input.before.trim();
      session = {
        runs: new Map(),
        runIds: [],
        before: before === "" ? Promise.resolve(null) : this.deps.run("before", before),
        after: input.after.trim(),
      };
      this.session = session;
    }
    session.runs.set(input.runId, { timer: this.expireLater(input.runId, input.leaseMs), lease });
    session.runIds.push(input.runId);
    const before = await session.before;
    return { open: true, before: opened ? before : null };
  }

  renew(runId: string, leaseMs: number): boolean {
    const run = this.session?.runs.get(runId);
    if (run === undefined) return false;
    clearTimeout(run.timer);
    run.timer = this.expireLater(runId, leaseMs);
    return true;
  }

  /** Ends `runId`; the last open run's end runs `after` and resolves with it. */
  async end(runId: string): Promise<HookRun | null> {
    this.remember(runId);
    const session = this.session;
    const run = session?.runs.get(runId);
    if (session === null || run === undefined) return null;
    clearTimeout(run.timer);
    session.runs.delete(runId);
    try {
      if (session.runs.size > 0) return null;
      return await this.close(session);
    } finally {
      await run.lease.dispose();
    }
  }

  /**
   * The worker is going: every open run ends now and its after hook runs,
   * all within `DISPOSE_BUDGET_MS` (see there). Null when no run was open.
   */
  async dispose(): Promise<DisposeReport | null> {
    this.disposed = true;
    // A before hook still running would hold the after hook up past the budget; it is cut short.
    this.deps.kill("before");
    const deadline = setTimeout(() => this.deps.kill(), DISPOSE_BUDGET_MS);
    try {
      const session = this.session;
      if (session === null) {
        // An after hook a window's end (or an expiry) started may still be running: it is not run
        // again, but waited for — the deadline bounds it — and reported, since the call that started
        // it may not get to answer once the worker is going.
        const inFlight = this.inFlight;
        if (inFlight === null) return null;
        return { runIds: inFlight.runIds, after: await inFlight.after };
      }
      const runs = [...session.runs.entries()];
      for (const [, run] of runs) clearTimeout(run.timer);
      session.runs.clear();
      try {
        return { runIds: session.runIds, after: await this.close(session, DISPOSE_BUDGET_MS) };
      } finally {
        await Promise.all(runs.map(([, run]) => run.lease.dispose()));
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  private close(session: Session, afterTimeoutMs?: number): Promise<HookRun | null> {
    this.session = null;
    const closing = (async () => {
      await session.before;
      return session.after === "" ? null : this.deps.run("after", session.after, afterTimeoutMs);
    })();
    const inFlight: Closing = { runIds: session.runIds, after: closing };
    this.inFlight = inFlight;
    this.closing = closing;
    void closing.then(() => {
      if (this.inFlight === inFlight) this.inFlight = null;
    });
    return closing;
  }

  private expireLater(runId: string, leaseMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.end(runId).then((after) => this.deps.expired(runId, after));
    }, leaseMs);
  }

  private remember(runId: string): void {
    const now = this.now();
    for (const [id, at] of this.ended) if (now - at > ENDED_MEMORY_MS) this.ended.delete(id);
    this.ended.set(runId, now);
  }
}
