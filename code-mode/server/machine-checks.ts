// The background service that keeps each switched-on machine's wrapper written and its status known.
//
// It runs as a service, not from the plugin's factory: bb refuses host calls while a plugin loads
// ("host plugin calls are unavailable during factory registration"), and a check made there failed on
// every machine and was kept as that machine's status, so the Send menu greyed out both of its rows on
// a machine that was on. A service starts once loading is done.
//
// It checks every machine that is on when it starts (a launcher naming an old Node is rewritten after
// a bb update), then every RECHECK_MS checks again the ones that are on but not ready, so a machine
// that was offline recovers by itself. The interval is longer than the host worker's five idle minutes
// only by chance; a ready machine is not asked again, so no worker is kept alive for it.
import type { Config } from "../shared/config";
import type { InstallResult } from "../shared/host-contract";

export const MACHINE_CHECKS_SERVICE = "machine-checks";
export const RECHECK_MS = 5 * 60_000;

export interface MachineChecksDeps {
  config(): Promise<Config>;
  check(hostId: string): Promise<InstallResult>;
  log: { warn(message: string): void };
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function machinesOn(deps: MachineChecksDeps): Promise<string[]> {
  try {
    const config = await deps.config();
    return Object.entries(config.hosts)
      .filter(([, on]) => on)
      .map(([hostId]) => hostId);
  } catch (error) {
    deps.log.warn(`Could not read Code Mode's switches to check the machines: ${String(error)}`);
    return [];
  }
}

export async function runMachineChecks(signal: AbortSignal, deps: MachineChecksDeps): Promise<void> {
  const sleep = deps.sleep ?? abortableSleep;
  let pending = await machinesOn(deps);
  while (!signal.aborted) {
    const results = await Promise.all(pending.map(async (hostId) => ({ hostId, result: await deps.check(hostId) })));
    const notReady = new Set(results.filter(({ result }) => !result.ok).map(({ hostId }) => hostId));
    await sleep(RECHECK_MS, signal);
    if (signal.aborted) break;
    // Only machines still on, and not ready at the last look.
    pending = (await machinesOn(deps)).filter((hostId) => notReady.has(hostId));
  }
}
