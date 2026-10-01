import type { FailingEntry, Health } from "../shared/channels";
import type { FailingJob } from "../shared/jobs";

/**
 * The failing count behind the sidebar row: which jobs, on which Macs, ended
 * their latest run badly without the user having looked.
 *
 * The server takes it about once a minute whether or not the panel is open,
 * and publishes it when it changes. It asks the server's own Mac always, and
 * any other Mac only once a listing there has found a job — so a laptop whose
 * jobs nobody has opened is not woken every minute, and a Mac whose jobs are
 * all deleted drops out again.
 */
export interface HealthDeps {
  primaryHostId(): Promise<string | null>;
  /** Every enrolled host by id, with its name and whether it can answer now. */
  knownHosts(): Promise<Map<string, { name: string; connected: boolean }>>;
  hostHealth(hostId: string): Promise<{ supported: boolean; jobCount: number; failing: FailingJob[] }>;
  loadWatched(): Promise<string[]>;
  saveWatched(hostIds: string[]): Promise<void>;
  publish(health: Health): void;
  now(): number;
  warn(message: string): void;
}

function sameFailing(a: readonly FailingEntry[], b: readonly FailingEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return other !== undefined && other.hostId === entry.hostId && other.id === entry.id && other.name === entry.name && other.hostName === entry.hostName;
    })
  );
}

export function createHealthMonitor(deps: HealthDeps) {
  let current: Health = { failing: [], checkedAt: null };
  let watched: Set<string> | null = null;
  let running: Promise<Health> | null = null;
  /** One more check, asked for while `running` was under way; see `refresh`. */
  let queued: Promise<Health> | null = null;
  /** Only warn when a host's failure changes, or a sleeping laptop logs every minute. */
  const lastWarning = new Map<string, string>();

  async function watchedHosts(): Promise<Set<string>> {
    if (watched === null) watched = new Set(await deps.loadWatched());
    return watched;
  }

  /** Records whether a listing or a check found jobs on `hostId`; the primary host is always checked. */
  async function noteJobCount(hostId: string, jobCount: number): Promise<void> {
    const set = await watchedHosts();
    const before = set.has(hostId);
    if (jobCount > 0) set.add(hostId);
    else set.delete(hostId);
    if (before !== set.has(hostId)) await deps.saveWatched([...set].sort());
  }

  async function check(): Promise<Health> {
    const [primary, known, set] = await Promise.all([deps.primaryHostId(), deps.knownHosts(), watchedHosts()]);
    // A Mac removed from bb is forgotten, failures and all: nobody can open it to clear them.
    const gone = [...set].filter((hostId) => !known.has(hostId));
    if (gone.length > 0) {
      for (const hostId of gone) set.delete(hostId);
      await deps.saveWatched([...set].sort());
    }
    const targets = [...new Set([...(primary === null ? [] : [primary]), ...set])].filter((hostId) => known.has(hostId)).sort();
    const failing: FailingEntry[] = [];
    for (const hostId of targets) {
      const host = known.get(hostId);
      // A Mac that is asleep keeps whatever it last reported.
      if (host === undefined || !host.connected) {
        failing.push(...current.failing.filter((entry) => entry.hostId === hostId));
        continue;
      }
      const hostName = host.name;
      try {
        const health = await deps.hostHealth(hostId);
        lastWarning.delete(hostId);
        if (health.supported) await noteJobCount(hostId, health.jobCount);
        failing.push(...health.failing.map((job) => ({ hostId, hostName, id: job.id, name: job.name })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (lastWarning.get(hostId) !== message) {
          lastWarning.set(hostId, message);
          deps.warn(`could not check job health on ${hostName}: ${message}`);
        }
        failing.push(...current.failing.filter((entry) => entry.hostId === hostId));
      }
    }
    const changed = !sameFailing(current.failing, failing);
    current = { failing, checkedAt: deps.now() };
    if (changed) deps.publish(current);
    return current;
  }

  /**
   * Takes a new count. A caller arriving while a check is under way gets the
   * one after it, since the running check may have read the files before
   * whatever the caller just changed (an acknowledgement, a delete); callers
   * arriving together share that one.
   */
  function refresh(): Promise<Health> {
    if (running === null) {
      running = check().finally(() => {
        running = null;
      });
      return running;
    }
    if (queued === null) {
      queued = running
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return refresh();
        });
    }
    return queued;
  }

  return {
    noteJobCount,
    current: (): Health => current,
    refresh,
  };
}
