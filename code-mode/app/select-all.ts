// "Select all" for the Machines list: a machine is turned on only once its wrapper is written and
// ready there, so Select all never quietly turns on one where Code Mode can't start (offline, Windows,
// no usable Node). The others stay off, and each shows why.
import type { HostCheck } from "../shared/contract";

export interface SelectAllMachinesDeps {
  check(hostId: string): Promise<HostCheck>;
  /** Turns these machines on in one write. */
  turnOn(hostIds: readonly string[]): Promise<unknown>;
  /** Each machine's result as it comes in, for the page to show. */
  report(hostId: string, result: HostCheck): void;
}

export async function selectAllMachines(hostIds: readonly string[], deps: SelectAllMachinesDeps): Promise<{ on: string[]; left: string[] }> {
  const results = await Promise.all(
    hostIds.map(async (hostId) => {
      let result: HostCheck;
      try {
        result = await deps.check(hostId);
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      deps.report(hostId, result);
      return { hostId, ok: result.ok };
    }),
  );
  const on = results.filter((result) => result.ok).map((result) => result.hostId);
  const left = results.filter((result) => !result.ok).map((result) => result.hostId);
  if (on.length > 0) await deps.turnOn(on);
  return { on, left };
}
