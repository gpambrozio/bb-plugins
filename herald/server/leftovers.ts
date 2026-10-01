/**
 * Summary helpers an earlier instance of the plugin did not put away — its
 * unload deadline passed while a stop hung, the plugin was disabled mid-summary,
 * the bb server stopped. Each instance puts the whole lot away before it
 * spawns a helper of its own (`server.ts` gates every spawn on this), so the
 * two-helper cap holds by construction: when the first new helper starts, no
 * old one is left.
 *
 * Every wait gives way to the abort signal — unload, or bb stopping the
 * service — and the signal is checked again before each step.
 */
import type { HelperPort, Log } from "./ports";

const ABORTED = Symbol("aborted");

/** `work`, or `ABORTED` as soon as the signal fires; the work itself is left to finish or fail alone. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export interface LeftoverDeps {
  helpers: HelperPort;
  /** Delete, or archive when the user keeps helpers to read later. */
  deleteHelpers: () => Promise<boolean>;
  log: Log;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stops and puts away every leftover helper; resolves with how many were found. Never rejects. */
export async function putAwayLeftovers(deps: LeftoverDeps, signal: AbortSignal): Promise<number> {
  let leftovers: string[] | typeof ABORTED;
  try {
    leftovers = await unlessAborted(deps.helpers.listLeftovers(), signal);
  } catch (error) {
    deps.log.warn(`Could not look for leftover summary helpers: ${reasonOf(error)}`);
    return 0;
  }
  if (leftovers === ABORTED) return 0;
  for (const helperId of leftovers) {
    if (signal.aborted) break;
    try {
      if ((await unlessAborted(deps.helpers.stop(helperId), signal)) === ABORTED) break;
    } catch (error) {
      deps.log.warn(`Could not stop leftover summary helper ${helperId}: ${reasonOf(error)}`);
    }
    if (signal.aborted) break;
    try {
      const putAway = (await deps.deleteHelpers()) ? deps.helpers.delete(helperId) : deps.helpers.archive(helperId);
      if ((await unlessAborted(putAway, signal)) === ABORTED) break;
    } catch (error) {
      deps.log.warn(`Could not put away leftover summary helper ${helperId}: ${reasonOf(error)}`);
    }
  }
  if (leftovers.length > 0) deps.log.info(`Put away ${leftovers.length} leftover summary helpers.`);
  return leftovers.length;
}

export { unlessAborted, ABORTED };
